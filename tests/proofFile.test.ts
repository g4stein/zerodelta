/**
 * Guards the proof history and re-checks the v3 proof offline.
 * - v2 is kept unchanged: proofs/testnet-proof.v2.json is the original file (sha256 99a0feb3…)
 *   and testnet-proof.json carries the same object under previousDeployment.
 * - v3: the recorded digest is what the TS mirror builds from the recorded request, the recorded
 *   exchange request is that action + nonce + signature, and the signature recovers to the pinned
 *   MPC-derived hedge address.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoverAddress } from "../scripts/testnet-setup-v3";
import { V2_PROOF_JSON, V3_PROOF_JSON, V31_PROOF_JSON } from "../src/lib/near/proofFile";
import { TESTNET_PROOF } from "../src/lib/near/riskGuardContract";
import { RISK_GUARD_CONTRACT_ID } from "../src/lib/near/deployment";
import { buildV3Hedge } from "../src/lib/hyperliquid/v3Hedge";
import { buildV31Hedge } from "../src/lib/hyperliquid/v31Hedge";

const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const v3 = V3_PROOF_JSON as any;
const v31 = V31_PROOF_JSON as any;

describe("testnet-proof.json history", () => {
  it("keeps the v2 proof unchanged under previousDeployment and as a byte-identical file", () => {
    const bytes = readFileSync("proofs/testnet-proof.v2.json");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("99a0feb37566af1578148481191cad69511b78f2bcac552f729cabb09b138581");
    expect(canon(v3.previousDeployment)).toBe(canon(JSON.parse(bytes.toString("utf8"))));
    expect(v3.previousDeploymentFile.sha256).toBe("99a0feb37566af1578148481191cad69511b78f2bcac552f729cabb09b138581");
  });

  it("the v2 demo still points at the v2 contract and its 5 transactions", () => {
    expect(V2_PROOF_JSON.version).toBe(2);
    expect(TESTNET_PROOF.contract.accountId).toBe("zerodelta-guard-fb604f.testnet");
    expect(RISK_GUARD_CONTRACT_ID).toBe("zerodelta-guard-fb604f.testnet");
    expect(TESTNET_PROOF.transactions).toHaveLength(5);
    expect((TESTNET_PROOF.previousDeployment as { version: number }).version).toBe(1);
  });
});

describe("v3 proof (offline re-check)", () => {
  it("is locked, on testnet indices, and lists the expected transactions", () => {
    expect(v3.version).toBe(3);
    expect(v3.contract.locked && v3.contract.accessKeys === 0).toBe(true);
    expect(v3.contract.hlNetwork).toBe("testnet");
    expect(v3.contract.markets).toEqual([
      { symbol: "BTC", asset: 3, sz_decimals: 5 },
      { symbol: "ETH", asset: 4, sz_decimals: 4 },
      { symbol: "SOL", asset: 0, sz_decimals: 2 },
      { symbol: "NEAR", asset: 54, sz_decimals: 1 },
    ]);
    expect(v3.transactions.map((t: { kind: string; expect: string; mpcReceipt: boolean }) => `${t.kind}:${t.expect}:${t.mpcReceipt}`)).toEqual([
      "CREATE_V3_ACCOUNT:success:false",
      "DEPLOY_INIT_AND_LOCK:success:false",
      "APPROVED_EXECUTABLE_HEDGE_SIGNED:success:true",
      "PRICE_OUT_OF_BAND_REJECTED:failure:false",
      "REPLAY_REJECTED:failure:false",
      "PRIVATE_CALLBACK_REJECTED:failure:false",
    ]);
    expect(v3.hedgeKey.path).toBe("zerodelta/hedge/hyperliquid");
    expect(v3.hedgeKey.evmAddress).not.toBe(TESTNET_PROOF.mpcSignature.evmAddress.toLowerCase());
  });

  it("the recorded digest is what the TS mirror builds from the recorded request", () => {
    const req = v3.approvedHedge.args.request;
    const b = buildV3Hedge(v3.contract.accountId, "testnet", v3.approvedHedge.market, req.order, BigInt(req.limit_px_e8), BigInt(req.reference_px_e8), v3.contract.policy);
    expect(b.violations).toEqual([]);
    expect(b.digestHex).toBe(v3.approvedHedge.digestHex);
    expect(b.commitmentHex).toBe(v3.approvedHedge.commitmentHex);
    expect(req.expected_digest_hex).toBe(b.digestHex);
    expect(v3.approvedHedge.exchangeRequest.action).toEqual(b.action);
    expect(v3.approvedHedge.exchangeRequest.nonce).toBe(req.order.nonce);
  });

  it("the MPC signature recovers to the pinned derived hedge address; a corrupted one does not", () => {
    const { signature } = v3.approvedHedge.exchangeRequest;
    expect(recoverAddress(v3.approvedHedge.digestHex, signature)).toBe(v3.hedgeKey.evmAddress.toLowerCase());
    expect(signature.v).toBeGreaterThanOrEqual(27);
    const flipped = { ...signature, v: signature.v === 27 ? 28 : 27 };
    expect(recoverAddress(v3.approvedHedge.digestHex, flipped)).not.toBe(v3.hedgeKey.evmAddress.toLowerCase());
  });
});

describe("Hyperliquid acceptance (CP4) classification and recorded result", () => {
  it("parses the recovered address strictly and never passes on other responses", async () => {
    const { classify, parseRecoveredAddress } = await import("../scripts/hl-acceptance");
    const exp = "0xef639b571185dc6ee0e4680de4e8dd81e7e02c66";
    const msg = (a: string) => JSON.stringify({ status: "err", response: `User or API Wallet ${a} does not exist.` });
    expect(classify(parseRecoveredAddress(msg("0xEF639B571185DC6EE0E4680DE4E8DD81E7E02C66")), exp)).toBe("PASS");
    expect(classify(parseRecoveredAddress(msg("0xd9cf502b9ce06090c94da764e15446fbcd0e3608")), exp)).toBe("FAIL");
    for (const other of [
      "not json",
      JSON.stringify({ status: "ok", response: { type: "order" } }),
      JSON.stringify({ status: "err", response: "Order has invalid price." }),
      JSON.stringify({ status: "err", response: `Must deposit before performing actions. User: ${exp}` }),
      "",
    ]) {
      expect(classify(parseRecoveredAddress(other), exp)).toBe("OTHER");
    }
  });

  it("the recorded run passed: HL recovered the hedge address, and different ones for both controls", () => {
    const r = JSON.parse(readFileSync("proofs/hl-acceptance.v3.json", "utf8"));
    expect(r.verdict).toBe("PASS");
    expect(r.expectedAddress).toBe(v3.hedgeKey.evmAddress.toLowerCase());
    expect(r.digestHex).toBe(v3.approvedHedge.digestHex);
    expect(r.results.map((x: { classification: string }) => x.classification)).toEqual(["PASS", "FAIL", "FAIL"]);
    expect(r.results[0].recoveredAddress).toBe(r.expectedAddress);
    expect(new Set(r.results.map((x: { recoveredAddress: string }) => x.recoveredAddress)).size).toBe(3);
    for (const x of r.results) {
      expect(x.request).not.toHaveProperty("vaultAddress");
      expect(x.hyperliquidAgreesWithLocalRecovery).toBe(true);
      expect(x.recoveredAddress).toBe(recoverAddress(v3.approvedHedge.digestHex, x.request.signature));
    }
  });
});

describe("v3.1 proof (current; offline re-check)", () => {
  it("is locked, has the coin caps, and lists the expected transactions", () => {
    expect(v31.version).toBe(3.1);
    expect(v31.contract.locked && v31.contract.accessKeys === 0).toBe(true);
    expect(v31.contract.markets.every((m: any) => m.max_order_size_e8 > 0 && m.window_size_cap_e8 >= m.max_order_size_e8)).toBe(true);
    expect(v31.transactions.map((t: any) => `${t.kind}:${t.expect}:${t.mpcReceipt}`)).toEqual([
      "CREATE_V31_ACCOUNT:success:false",
      "DEPLOY_INIT_AND_LOCK:success:false",
      "APPROVED_EXECUTABLE_HEDGE_SIGNED:success:true",
      "INFLATION_ATTACK_REJECTED:failure:false",
      "EXPIRY_TOO_FAR_REJECTED:failure:false",
      "REPLAY_REJECTED:failure:false",
      "PRIVATE_CALLBACK_REJECTED:failure:false",
    ]);
    expect(v31.previousDeployment.version).toBe(3);
    expect(v31.hedgeKey.evmAddress).not.toBe(v3.hedgeKey.evmAddress);
  });

  it("the recorded digest (with expiresAfter) is what the TS mirror builds; the signature recovers to the hedge address", () => {
    const req = v31.approvedHedge.args.request;
    const b = buildV31Hedge(v31.contract.accountId, "testnet", v31.approvedHedge.market, req.order, BigInt(req.limit_px_e8), BigInt(req.reference_px_e8), BigInt(req.expires_after_ms), v31.contract.policy);
    expect(b.violations).toEqual([]);
    expect(b.digestHex).toBe(v31.approvedHedge.digestHex);
    expect(v31.approvedHedge.exchangeRequest.expiresAfter).toBe(req.expires_after_ms);
    const { signature } = v31.approvedHedge.exchangeRequest;
    expect(recoverAddress(v31.approvedHedge.digestHex, signature)).toBe(v31.hedgeKey.evmAddress.toLowerCase());
  });

  it("the recorded Hyperliquid run passed for the v3.1 hedge address, and a repeat post is SPENT, not a pass", async () => {
    const r = JSON.parse(readFileSync("hl-acceptance.json", "utf8"));
    expect(r.verdict).toBe("PASS");
    expect(r.expectedAddress).toBe(v31.hedgeKey.evmAddress.toLowerCase());
    expect(r.digestHex).toBe(v31.approvedHedge.digestHex);
    expect(r.results.map((x: any) => x.classification)).toEqual(["PASS", "FAIL", "FAIL"]);
    const { classify } = await import("../scripts/hl-acceptance");
    expect(classify(null, "0xabc", JSON.stringify({ status: "err", response: "Invalid nonce: duplicate nonce 1" }))).toBe("SPENT");
  });

  it("the proof loader throws instead of falling back to the whole file", async () => {
    expect(V2_PROOF_JSON.version).toBe(2);
    expect(V3_PROOF_JSON.version).toBe(3);
    expect(V31_PROOF_JSON.version).toBe(3.1);
  });
});
