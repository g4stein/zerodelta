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
import { V2_PROOF_JSON, V3_PROOF_JSON } from "../src/lib/near/proofFile";
import { TESTNET_PROOF } from "../src/lib/near/riskGuardContract";
import { RISK_GUARD_CONTRACT_ID } from "../src/lib/near/deployment";
import { buildV3Hedge } from "../src/lib/hyperliquid/v3Hedge";

const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const v3 = V3_PROOF_JSON as any;

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
