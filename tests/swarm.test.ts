/**
 * Deterministic, offline test suite. No network calls: market data comes from
 * bundled snapshots and quotes from the local fallback model. Live network
 * behaviour is covered by `npm run verify`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KeyPair, KeyPairSigner, type KeyPairEd25519 } from "near-api-js";
import {
  NEP413_TAG,
  buildIntentMessage,
  createEphemeralSigner,
  generateNonce,
  hashNep413Payload,
  serializeNep413Payload,
  signNep413,
  tamperSignature,
  verifyNep413,
} from "../src/lib/near/nep413";
import {
  EXPECTED_SOLVER_MEASUREMENT,
  SOLVER_ENCLAVE_MANIFEST,
  computeMeasurement,
  computeReportData,
  createEnclave,
  signAttestation,
  verifyAttestation,
} from "../src/lib/crypto/attestation";
import { bytesToHex, canonicalJson, fromBase58, fromBase64, hashObject, sha256Bytes, sha256Hex, toBase58, toBase64 } from "../src/lib/crypto/encoding";
import { EXPECTED_ONCHAIN_POLICY, TESTNET_PROOF, verifyMpcSignature } from "../src/lib/near/riskGuardContract";
import { commitmentPreimage, computeHedgePayloadHex, computeOrderMetrics, orderParamsFromPlan, type OrderParams } from "../src/lib/near/orderCommitment";
import { MPC_SIGNER_CONTRACT, RISK_GUARD_CONTRACT_ID } from "../src/lib/near/deployment";
import { ONECLICK_TOKEN_SNAPSHOT, evmAddressFromSecp256k1, type OneClickTokenFeed } from "../src/lib/near/rpcClient";
import { FUNDING_SNAPSHOT, fundingApr, type FundingFeed } from "../src/lib/market/fundingFeed";
import { SCANNER_ASSUMPTIONS, buildRogueDirectionalPlan, chooseHedgeLeverage, maxSliceUsd, probeEntryCosts, proposeReslice, recommendSlices, runScannerAgent } from "../src/lib/agents/scannerAgent";
import { getSolverEnclave, runSolverAgent, type SolverResult } from "../src/lib/agents/solverAgent";
import {
  GUARDIAN_NEAR_ACCOUNT,
  RISK_POLICY,
  computeRiskMetrics,
  evaluateRiskInvariants,
  getGuardianIdentity,
  runGuardianAgent,
  verifyGuardianDecision,
} from "../src/lib/agents/guardianAgent";
import { runSwarm, verifyAuditChain } from "../src/lib/swarm/orchestrator";
import { parseSwarmRequest, type PairId, type RebalancePlan } from "../src/lib/swarm/types";

const tokens: OneClickTokenFeed = {
  live: false,
  source: "test-snapshot",
  tokens: ONECLICK_TOKEN_SNAPSHOT,
  count: ONECLICK_TOKEN_SNAPSHOT.length,
  chains: [],
  fetchedAt: new Date().toISOString(),
};
const funding: FundingFeed = { live: false, source: "test-snapshot", markets: FUNDING_SNAPSHOT, fetchedAt: new Date().toISOString() };
const costs = await probeEntryCosts(false, "offline");

async function solve(plan: RebalancePlan, sliceCount = 8, compromise?: "spoofed_metrics"): Promise<SolverResult> {
  return runSolverAgent({
    compromise,
    plan,
    sliceCount,
    tokens,
    signer: createEphemeralSigner(),
    guardianBoxPublicKey: getGuardianIdentity().boxPublicKeyHex,
    live: false,
  });
}

function scannerPlan(pair: PairId = "NEAR", treasuryUsd = 50_000) {
  return runScannerAgent({ pair, treasuryUsd, tokens, funding, costs }).plan;
}

function guard(solver: SolverResult, now?: Date, lastAcceptedNonce = 0) {
  return runGuardianAgent({ runId: "test", solver, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex], now, lastAcceptedNonce });
}

// ---------------------------------------------------------------------------

describe("NEP-413 intent cryptography", () => {
  it("borsh-serialises with the 2^31+413 tag, length-prefixed strings and a 32-byte nonce", () => {
    const nonce = new Uint8Array(32).fill(7);
    const bytes = serializeNep413Payload({ message: "hi", nonce, recipient: "intents.near" });
    const view = new DataView(bytes.buffer);
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    expect(view.getUint32(0, true)).toBe(NEP413_TAG);
    expect(view.getUint32(4, true)).toBe(2); // "hi"
    expect(bytesToHex(bytes.slice(10, 42))).toBe("07".repeat(32));
    expect(view.getUint32(42, true)).toBe("intents.near".length);
    expect(bytes[bytes.length - 1]).toBe(0); // callbackUrl: None
    expect(bytes.length).toBe(4 + 4 + 2 + 32 + 4 + 12 + 1);
  });

  it("rejects nonces that are not exactly 32 bytes", () => {
    expect(() => serializeNep413Payload({ message: "x", nonce: new Uint8Array(31), recipient: "intents.near" })).toThrow(/32 bytes/);
  });

  it("generates distinct 32-byte random nonces", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a.length).toBe(32);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("derives a 64-char hex implicit account from the ed25519 public key", () => {
    const signer = createEphemeralSigner();
    expect(signer.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.publicKey.startsWith("ed25519:")).toBe(true);
  });

  it("signs and verifies with both tweetnacl and near-api-js", () => {
    const signer = createEphemeralSigner();
    const message = buildIntentMessage({ signer_id: signer.accountId, deadline: new Date(Date.now() + 60_000).toISOString(), intents: [] });
    const res = signNep413(signer.keyPair, { message, nonce: generateNonce(), recipient: "intents.near" });
    expect(res.signed.standard).toBe("nep413");
    expect(res.signed.signature.startsWith("ed25519:")).toBe(true);
    expect(res.signatureHex).toHaveLength(128);
    expect(fromBase64(res.signed.payload.nonce)).toHaveLength(32);
    const v = verifyNep413(res.signed);
    expect(v).toMatchObject({ valid: true, tweetnaclValid: true, nearApiJsValid: true });
    expect(v.payloadHashHex).toBe(res.payloadHashHex);
  });

  it("produces byte-identical signatures to near-api-js's own NEP-413 signer", async () => {
    const kp = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
    const nonce = generateNonce();
    const payload = { message: '{"hello":"near"}', nonce, recipient: "intents.near" };
    const ours = signNep413(kp, payload);
    const theirs = await new KeyPairSigner(kp).signNep413Message("alice.near", payload);
    expect(bytesToHex(theirs.signature)).toBe(ours.signatureHex);
  });

  it("detects tampered signatures, messages and recipients", () => {
    const signer = createEphemeralSigner();
    const res = signNep413(signer.keyPair, { message: "pay 1 USDC", nonce: generateNonce(), recipient: "intents.near" });
    expect(verifyNep413(tamperSignature(res.signed)).valid).toBe(false);
    expect(verifyNep413({ ...res.signed, payload: { ...res.signed.payload, message: "pay 1000 USDC" } }).valid).toBe(false);
    expect(verifyNep413({ ...res.signed, payload: { ...res.signed.payload, recipient: "evil.near" } }).valid).toBe(false);
    const other = createEphemeralSigner();
    expect(verifyNep413({ ...res.signed, public_key: other.publicKey }).valid).toBe(false);
  });

  it("hash changes when any payload field changes", () => {
    const nonce = generateNonce();
    const base = bytesToHex(hashNep413Payload({ message: "m", nonce, recipient: "intents.near" }));
    expect(bytesToHex(hashNep413Payload({ message: "m", nonce, recipient: "intents.near", callbackUrl: "https://x" }))).not.toBe(base);
    expect(bytesToHex(hashNep413Payload({ message: "m", nonce: generateNonce(), recipient: "intents.near" }))).not.toBe(base);
  });
});

describe("Agent 1 — scanner", () => {
  it("annualises hourly funding (Hyperliquid pays hourly)", () => {
    expect(fundingApr(0.0000125)).toBeCloseTo(0.1095, 6);
  });

  it("evaluates every candidate market and ranks them by net-of-cost carry", () => {
    const r = runScannerAgent({ pair: "AUTO", treasuryUsd: 100_000, tokens, funding, costs });
    expect(r.opportunityMatrix.map((o) => o.asset).sort()).toEqual(["BTC", "ETH", "NEAR", "SOL"]);
    expect(r.opportunityMatrix.map((o) => o.rank)).toEqual([1, 2, 3, 4]);
    for (const o of r.opportunityMatrix) {
      // net = gross − round trip amortised over the holding horizon
      expect(o.estimatedRoundTripCostBps).toBeCloseTo(2 * o.entryCostBps + 2 * SCANNER_ASSUMPTIONS.perpTakerFeeBps, 6);
      expect(o.netCarryAprPct).toBeCloseTo(o.grossCarryAprPct - (o.estimatedRoundTripCostBps / 100) * (365 / SCANNER_ASSUMPTIONS.holdingDays), 2);
    }
    const eligible = r.opportunityMatrix.filter((o) => o.eligible);
    for (let i = 1; i < eligible.length; i++) expect(eligible[i - 1].netCarryAprPct).toBeGreaterThanOrEqual(eligible[i].netCarryAprPct);
    expect(r.selection.mode).toBe("auto");
    expect(r.selected.asset).toBe(r.opportunityMatrix[0].asset);
    expect(r.selection.bestByNetCarry).toBe(r.selected.asset);
  });

  it("ranks a market with negative funding below every carry trade", () => {
    const negative: FundingFeed = { ...funding, markets: { ...funding.markets, SOL: { ...funding.markets.SOL, fundingHourly: -0.00003 } } };
    const r = runScannerAgent({ pair: "AUTO", treasuryUsd: 50_000, tokens, funding: negative, costs });
    const sol = r.opportunityMatrix.find((o) => o.asset === "SOL")!;
    expect(sol.eligible).toBe(false);
    expect(sol.verdict).toMatch(/negative/);
    expect(r.selected.asset).not.toBe("SOL");
  });

  it("records a manual override and still produces a delta-neutral plan", () => {
    const r = runScannerAgent({ pair: "SOL", treasuryUsd: 100_000, tokens, funding, costs });
    expect(r.selection.mode).toBe("manual");
    expect(r.selected.asset).toBe("SOL");
    expect(r.selection.reason).toMatch(/Manual/);
    const legs = Object.fromEntries(r.plan.legs.map((l) => [l.id, l]));
    expect(legs["spot-long"].notionalUsd + legs["hedge-margin"].notionalUsd).toBeCloseTo(100_000, 6);
    expect(legs["perp-short"].deltaUsd).toBe(-legs["spot-long"].notionalUsd);
    expect(r.plan.legs.reduce((s, l) => s + l.deltaUsd, 0)).toBe(0);
    expect(r.expectedTreasuryAprPct).toBeCloseTo(r.selected.netCarryAprPct * r.selected.spotFraction, 2);
  });

  it("sizes hedge leverage from the 24h move and slices from liquidity", () => {
    expect(chooseHedgeLeverage(0.2)).toBe(1); // wild market: no extra leverage
    expect(chooseHedgeLeverage(0.06)).toBeCloseTo(1.67, 2);
    expect(chooseHedgeLeverage(0.01)).toBe(2); // capped
    // impact 10 bps at $10k -> k = 0.1 -> $10k max slice for a 10 bps target
    expect(maxSliceUsd(10, 0)).toBe(10_000);
    expect(maxSliceUsd(0, 10_000_000)).toBe(5_000); // capped by 0.05% of perp volume
    expect(recommendSlices(50_000, 10_000)).toBe(5);
    expect(recommendSlices(10_000_000, 1_000)).toBe(24);
  });

  it("Agent 1 answers slippage feedback with a square-root reslice", () => {
    expect(proposeReslice(1, 20)).toBe(4); // (20/10)^2
    expect(proposeReslice(5, 14.77)).toBe(11);
    expect(proposeReslice(4, 10.1)).toBe(5); // always at least one more slice
    expect(proposeReslice(20, 50)).toBe(24); // capped
  });
});

describe("Delta-neutral risk invariants (Agent 3 math)", () => {
  it("scanner plan is exactly delta-neutral and well inside the leverage ceiling", () => {
    const m = computeRiskMetrics(scannerPlan(), 5);
    expect(m.netDeltaUsd).toBe(0);
    expect(m.netDeltaRatio).toBe(0);
    expect(m.leverage).toBeGreaterThanOrEqual(1);
    expect(m.leverage).toBeLessThanOrEqual(1.34); // 2 x spot fraction (rounded to 4 dp), hedge <= 2x
  });

  it("enforces the ±2% net delta boundary", () => {
    expect(evaluateRiskInvariants({ netDeltaRatio: 0.02, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral).toBe(true);
    expect(evaluateRiskInvariants({ netDeltaRatio: 0.0201, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral).toBe(false);
  });

  it("enforces the 3.0x leverage ceiling", () => {
    expect(evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3.0, maxPriceImpactBps: 0 }).leverageOk).toBe(true);
    expect(evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3.01, maxPriceImpactBps: 0 }).leverageOk).toBe(false);
  });

  it("enforces the 25 bps slippage ceiling", () => {
    expect(evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25 }).slippageOk).toBe(true);
    expect(evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25.01 }).slippageOk).toBe(false);
  });

  it("matches the spec formula |spotLong − perpShort| / treasury for a 52/48 mis-hedge", () => {
    const plan = scannerPlan("ETH", 100_000);
    const legs = plan.legs.map((l) =>
      l.id === "spot-long" ? { ...l, notionalUsd: 52_000, deltaUsd: 52_000 } : l.id === "perp-short" ? { ...l, notionalUsd: 48_000, deltaUsd: -48_000 } : l,
    );
    const m = computeRiskMetrics({ ...plan, legs }, 0);
    expect(m.netDeltaRatio).toBeCloseTo(Math.abs(52_000 - 48_000) / 100_000, 12);
    expect(evaluateRiskInvariants(m).deltaNeutral).toBe(false);
  });
});

describe("Agent 2 — confidential solver", () => {
  it("sizes the hedge to the quoted spot fill so net delta is exactly zero", async () => {
    const s = await solve(scannerPlan("NEAR", 250_000), 12);
    const m = computeRiskMetrics(s.executablePlan, s.maxPriceImpactBps);
    expect(m.netDeltaUsd).toBe(0);
    expect(s.quotes.every((q) => q.source === "local-fallback")).toBe(true);
  });

  it("encrypts slices so ciphertext does not reveal order size, and slices sum to the order", async () => {
    const s = await solve(scannerPlan("SOL", 80_000), 6);
    expect(s.envelope.slices).toHaveLength(6);
    const spotIn = s.quotes.find((q) => q.legId === "spot-long")!.amountIn;
    for (const slice of s.envelope.slices) {
      const raw = Buffer.from(fromBase64(slice.ciphertext)).toString("latin1");
      expect(raw.includes("amountIn")).toBe(false);
      expect(raw.includes(spotIn.slice(0, 6))).toBe(false);
    }
    expect(guard(s).checks.find((c) => c.id === "ENVELOPE_INTEGRITY")!.pass).toBe(true);
  });

  it("builds a token_diff intent addressed to intents.near", async () => {
    const s = await solve(scannerPlan());
    expect(s.intent.signed.payload.recipient).toBe("intents.near");
    expect(s.intent.message.intents[0].intent).toBe("token_diff");
    const diff = (s.intent.message.intents[0] as { diff: Record<string, string> }).diff;
    expect(Object.values(diff).some((v) => v.startsWith("-"))).toBe(true);
    expect(verifyNep413(s.intent.signed).valid).toBe(true);
  });
});

describe("TEE attestation", () => {
  it("measurement is SHA-256 of the canonical solver manifest (pinned)", () => {
    expect(EXPECTED_SOLVER_MEASUREMENT).toBe(sha256Hex(canonicalJson(SOLVER_ENCLAVE_MANIFEST)));
    expect(EXPECTED_SOLVER_MEASUREMENT).toBe("1e3c96a269ada14c492e55e1046b7ce737a0a5da8f3526d2f879a55ee54268b9");
  });

  const policyFor = (publicKeyHex: string, reportData: string) => ({
    trustedMeasurements: [EXPECTED_SOLVER_MEASUREMENT],
    trustedEnclaveKeys: [publicKeyHex],
    expectedReportData: reportData,
  });

  it("accepts a fresh, bound report from a trusted enclave", () => {
    const enclave = createEnclave();
    const rd = computeReportData({ envelopeHash: "a", intentPayloadHash: "b", planHash: "c" });
    expect(verifyAttestation(signAttestation(enclave, rd), policyFor(enclave.publicKeyHex, rd)).valid).toBe(true);
  });

  it("rejects a modified solver build (different measurement)", () => {
    const rogue = createEnclave({ ...SOLVER_ENCLAVE_MANIFEST, version: "1.0.1-backdoor" });
    expect(computeMeasurement({ ...SOLVER_ENCLAVE_MANIFEST, version: "1.0.1-backdoor" })).not.toBe(EXPECTED_SOLVER_MEASUREMENT);
    const v = verifyAttestation(signAttestation(rogue, "rd"), policyFor(rogue.publicKeyHex, "rd"));
    expect(v.valid).toBe(false);
    expect(v.measurementTrusted).toBe(false);
  });

  it("rejects untrusted keys, forged signatures, wrong report data and stale reports", () => {
    const enclave = createEnclave();
    const att = signAttestation(enclave, "rd");
    expect(verifyAttestation(att, policyFor("00".repeat(32), "rd")).enclaveKeyTrusted).toBe(false);
    const forged = { ...att, signature: "11".repeat(64) };
    expect(verifyAttestation(forged, policyFor(enclave.publicKeyHex, "rd")).signatureValid).toBe(false);
    expect(verifyAttestation(att, policyFor(enclave.publicKeyHex, "other")).reportDataBound).toBe(false);
    const later = new Date(Date.now() + 10 * 60_000);
    expect(verifyAttestation(att, { ...policyFor(enclave.publicKeyHex, "rd"), now: later }).fresh).toBe(false);
  });
});

describe("Agent 3 — guardian decisions", () => {
  it("approves the hedged plan and routes the MPC request through the Risk Guard contract", async () => {
    const s = await solve(scannerPlan("ETH", 50_000));
    const d = guard(s);
    expect(d.decision).toBe("APPROVED");
    expect(d.violations).toEqual([]);
    expect(d.checks).toHaveLength(8);
    const req = d.mpcSignRequest!;
    expect(req.contractId).toBe(RISK_GUARD_CONTRACT_ID);
    expect(req.methodName).toBe("record_rebalance");
    expect(req.args.request_mpc_sign).toBe(true);
    expect(req.args.rebalance.order).toEqual(s.order);
    expect(req.args.rebalance.hedge_order_payload_hex).toBe(computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, s.order));
    expect(req.args.rebalance.decision_hash).toBe(d.decisionHash);
    expect(req.forwardsTo).toMatchObject({ contractId: MPC_SIGNER_CONTRACT, methodName: "sign", predecessor: RISK_GUARD_CONTRACT_ID });
    expect(req.forwardsTo.args.request.payload_v2.Ecdsa).toBe(s.hedgeOrderPayloadHex);
    expect(req.forwardsTo.args.request.domain_id).toBe(0);
    expect(verifyGuardianDecision(d)).toBe(true);
  });

  it("rejects the rogue unhedged 10x long even though all cryptography is valid", async () => {
    const d = guard(await solve(buildRogueDirectionalPlan("NEAR", 50_000), 1));
    expect(d.decision).toBe("REJECTED");
    expect(d.violations).toEqual(expect.arrayContaining(["DELTA_NEUTRALITY", "LEVERAGE_CEILING"]));
    const byId = Object.fromEntries(d.checks.map((c) => [c.id, c.pass]));
    expect(byId.TEE_ATTESTATION && byId.NEP413_SIGNATURE && byId.ENVELOPE_INTEGRITY && byId.ORDER_PAYLOAD_BINDING).toBe(true);
    expect(d.metrics.leverage).toBeGreaterThan(RISK_POLICY.maxLeverage);
    expect(d.metrics.netDeltaRatio).toBeGreaterThan(9);
    expect(d.mpcSignRequest).toBeNull();
    expect(verifyGuardianDecision(d)).toBe(true);
  });

  it("rejection proof fails verification if anyone edits it", async () => {
    const d = guard(await solve(buildRogueDirectionalPlan("SOL", 20_000), 1));
    const edited = { ...d, decisionRecord: { ...d.decisionRecord, decision: "APPROVED" } };
    expect(verifyGuardianDecision(edited)).toBe(false);
  });

  it("rejects when the plan is altered after the enclave attested it", async () => {
    const s = await solve(scannerPlan());
    const legs = s.executablePlan.legs.filter((l) => l.kind !== "PERP");
    const d = guard({ ...s, executablePlan: { ...s.executablePlan, legs } });
    expect(d.decision).toBe("REJECTED");
    expect(d.violations).toEqual(expect.arrayContaining(["TEE_ATTESTATION", "DELTA_NEUTRALITY"]));
  });

  it("rejects excessive slippage", async () => {
    const s = await solve(scannerPlan());
    const d = guard({ ...s, maxPriceImpactBps: 40 });
    expect(d.violations).toContain("SLIPPAGE_CEILING");
  });

  it("rejects a forged NEP-413 signature", async () => {
    const s = await solve(scannerPlan());
    const d = guard({ ...s, intent: { ...s.intent, signed: tamperSignature(s.intent.signed) } });
    expect(d.violations).toContain("NEP413_SIGNATURE");
  });

  it("rejects a tampered encrypted slice", async () => {
    const s = await solve(scannerPlan(), 4);
    const ct = fromBase64(s.envelope.slices[0].ciphertext);
    ct[ct.length - 1] ^= 0xff;
    const slices = [{ ...s.envelope.slices[0], ciphertext: toBase64(ct) }, ...s.envelope.slices.slice(1)];
    const d = guard({ ...s, envelope: { ...s.envelope, slices } });
    expect(d.violations).toContain("ENVELOPE_INTEGRITY");
  });

  it("rejects a stale attestation", async () => {
    const s = await solve(scannerPlan());
    const d = guard(s, new Date(Date.now() + 6 * 60_000));
    expect(d.violations).toContain("TEE_ATTESTATION");
  });
});

describe("Adversarial: compromised solver, payload swap, replay", () => {
  it("catches a solver that reports 0% delta while hiding a 10x order in slices and payload", async () => {
    const s = await solve(scannerPlan("NEAR", 50_000), 4, "spoofed_metrics");
    expect(s.compromised).toBe(true);
    // The metadata looks perfect...
    const m = computeRiskMetrics(s.executablePlan, s.maxPriceImpactBps);
    expect(m.netDeltaRatio).toBe(0);
    expect(computeOrderMetrics(s.order).net_delta_bps).toBe(0);
    // ...but the payload commits to a different order.
    const hidden: OrderParams = { ...s.order, spot_long_usd_cents: 5_000_000, perp_short_usd_cents: 0, perp_long_usd_cents: 45_000_000 };
    expect(s.hedgeOrderPayloadHex).toBe(computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, hidden));
    const d = guard(s);
    expect(d.decision).toBe("REJECTED");
    expect(d.violations).toEqual(expect.arrayContaining(["ENVELOPE_INTEGRITY", "ORDER_PAYLOAD_BINDING"]));
    const byId = Object.fromEntries(d.checks.map((c) => [c.id, c.pass]));
    expect(byId.DELTA_NEUTRALITY && byId.LEVERAGE_CEILING).toBe(true); // claimed metrics pass; binding catches it
    expect(d.checks.find((c) => c.id === "ORDER_PAYLOAD_BINDING")!.detail).toMatch(/PAYLOAD_COMMITMENT_MISMATCH/);
    expect(d.mpcSignRequest).toBeNull();
  });

  it("rejects a payload swapped after approval", async () => {
    const s = await solve(scannerPlan("ETH", 50_000));
    expect(guard(s).decision).toBe("APPROVED");
    const rogue = computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, { ...s.order, perp_short_usd_cents: 0, perp_long_usd_cents: 45_000_000 });
    const swapped = guard({ ...s, hedgeOrderPayloadHex: rogue });
    expect(swapped.decision).toBe("REJECTED");
    // binding fails, the enclave's report no longer matches, and the nonce was already spent
    expect(swapped.violations).toEqual(expect.arrayContaining(["ORDER_PAYLOAD_BINDING", "TEE_ATTESTATION", "REPLAY_AND_MPC_GATE"]));
  });

  it("rejects a payload swap even on a fresh, never-approved order", async () => {
    const s = await solve(scannerPlan("BTC", 50_000));
    const rogue = computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, { ...s.order, perp_long_usd_cents: 45_000_000 });
    const d = guard({ ...s, hedgeOrderPayloadHex: rogue });
    expect(d.violations).toContain("ORDER_PAYLOAD_BINDING");
    expect(d.violations).not.toContain("REPLAY_AND_MPC_GATE");
  });

  it("rejects legs that differ from the solver's own plan", async () => {
    const s = await solve(scannerPlan("SOL", 50_000));
    const order = { ...s.order, perp_short_usd_cents: s.order.perp_short_usd_cents - 500_000 };
    const d = guard({ ...s, order, hedgeOrderPayloadHex: computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, order) });
    expect(d.violations).toContain("ORDER_PAYLOAD_BINDING");
  });

  it("rejects replaying an approved order", async () => {
    const s = await solve(scannerPlan("NEAR", 50_000));
    expect(guard(s).decision).toBe("APPROVED");
    const replay = guard(s);
    expect(replay.decision).toBe("REJECTED");
    expect(replay.violations).toEqual(["REPLAY_AND_MPC_GATE"]);
    expect(replay.checks.find((c) => c.id === "REPLAY_AND_MPC_GATE")!.detail).toMatch(/NONCE_ALREADY_USED/);
  });

  it("rejects a nonce the contract has already accepted", async () => {
    const s = await solve(scannerPlan("NEAR", 50_000));
    const d = guard(s, undefined, s.order.nonce);
    expect(d.violations).toEqual(["REPLAY_AND_MPC_GATE"]);
  });
});

describe("TypeScript mirror of the Rust contract", () => {
  const hedged: OrderParams = {
    asset_symbol: "NEAR",
    treasury_usd_cents: 5_000_000,
    spot_long_usd_cents: 2_495_000,
    perp_short_usd_cents: 2_495_000,
    perp_long_usd_cents: 0,
    collateral_usd_cents: 5_000_000,
    quoted_slippage_bps: 2,
    nonce: 7,
  };

  it("builds the same canonical preimage as lib.rs (commitment_preimage_is_canonical)", () => {
    expect(commitmentPreimage("zerodelta-guard.testnet", hedged)).toBe(
      "zerodelta-hedge-v1|zerodelta-guard.testnet|NEAR|5000000|2495000|2495000|0|5000000|2|7",
    );
  });

  it("computes the same integer metrics as lib.rs (computes_metrics_from_raw_legs)", () => {
    expect(computeOrderMetrics(hedged)).toEqual({ net_delta_bps: 0, leverage_x100: 100 });
    const rogue = { ...hedged, spot_long_usd_cents: 4_970_000, perp_short_usd_cents: 0, perp_long_usd_cents: 45_000_000 };
    expect(computeOrderMetrics(rogue)).toEqual({ net_delta_bps: 99_940, leverage_x100: 1000 });
    const m = { ...hedged, treasury_usd_cents: 10_000_000, collateral_usd_cents: 10_000_000, spot_long_usd_cents: 5_200_000, perp_short_usd_cents: 4_800_000 };
    expect(computeOrderMetrics(m).net_delta_bps).toBe(400);
    expect(computeOrderMetrics({ ...m, perp_short_usd_cents: 4_799_999 }).net_delta_bps).toBe(401);
  });

  it("derives raw legs from a plan in integer cents", async () => {
    const s = await solve(scannerPlan("ETH", 50_000));
    const o = orderParamsFromPlan(s.executablePlan, s.maxPriceImpactBps, 1);
    expect(o.spot_long_usd_cents).toBe(o.perp_short_usd_cents);
    expect(o.treasury_usd_cents).toBe(5_000_000);
    expect(o.quoted_slippage_bps).toBe(Math.ceil(s.maxPriceImpactBps));
  });
});

describe("Swarm orchestrator (offline mode)", () => {
  it("runs the full rebalance pipeline with a valid hash-chained audit trail", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
    expect(run.economics.recommendation).toBe("TRADE");
    expect(run.guardian.decision).toBe("APPROVED");
    expect(run.settlement.status).toBe("SKIPPED_OFFLINE");
    expect(run.steps.map((s) => s.agent)).toEqual(["scanner", "solver", "guardian", "settlement"]);
    expect(verifyAuditChain(run.audit.events)).toBe(true);
    expect(run.audit.rootHash).toBe(run.audit.events.at(-1)!.hash);
    const tampered = run.audit.events.map((e, i) => (i === 3 ? { ...e, detail: e.detail, dataHash: hashObject("x") } : e));
    expect(verifyAuditChain(tampered)).toBe(false);
    // The ephemeral ed25519 private key and enclave/guardian secret keys never leave the server process.
    expect(JSON.stringify(run)).not.toMatch(/secretKey|secret_key|privateKey|keyPair/i);
  });

  it("Agents 1 and 2 negotiate a reslice when slice slippage is above target", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 1_000_000, sliceCount: 1 }, { live: false });
    expect(run.negotiation.length).toBeGreaterThan(1);
    expect(run.negotiation[0].action).toBe("RESLICE_REQUESTED");
    expect(run.negotiation.at(-1)!.action).toBe("ACCEPTED");
    expect(run.resolved.sliceCount).toBeGreaterThan(1);
    expect(run.negotiation.at(-1)!.observedSlippageBps).toBeLessThanOrEqual(SCANNER_ASSUMPTIONS.targetSliceImpactBps);
    const events = run.audit.events.map((e) => e.event);
    expect(events).toContain("SOLVER_SLIPPAGE_FEEDBACK");
    expect(events).toContain("SCANNER_RESLICE_ADJUSTMENT");
    // negotiation happens before Agent 3 decides (the decision event name depends on NO_TRADE)
    const decisionIdx = events.findIndex((e) => e === "INTENT_APPROVED" || e === "RISK_APPROVED_SETTLEMENT_WITHHELD");
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(events.indexOf("SCANNER_RESLICE_ADJUSTMENT")).toBeLessThan(decisionIdx);
    expect(run.guardian.decision).toBe("APPROVED");
  });

  it("AUTO mode picks the top-ranked market and auto-sizes slices", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: false });
    expect(run.resolved.pair).toBe(run.scanner.opportunityMatrix[0].asset);
    expect(run.resolved.initialSliceCount).toBe(run.scanner.recommendedSlices);
  });

  it("blocks the compromised-solver run before settlement", async () => {
    const run = await runSwarm({ mode: "spoofed_metrics", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: false });
    expect(run.guardian.decision).toBe("REJECTED");
    expect(run.guardian.violations).toContain("ORDER_PAYLOAD_BINDING");
    expect(run.settlement.status).toBe("BLOCKED_BY_GUARD");
    expect(run.audit.events.some((e) => e.event === "SOLVER_COMPROMISED")).toBe(true);
  });

  it("blocks the rogue run before settlement", async () => {
    const run = await runSwarm({ mode: "rogue", pair: "ETH", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
    expect(run.guardian.decision).toBe("REJECTED");
    expect(run.settlement.status).toBe("BLOCKED_BY_GUARD");
    expect(run.settlement.simulation).toBeNull();
    expect(run.audit.events.some((e) => e.event === "ROGUE_PLAN_INJECTED")).toBe(true);
  });
});

describe("Input validation and helpers", () => {
  it("clamps untrusted API input", () => {
    expect(parseSwarmRequest({ treasuryUsd: 5, sliceCount: 999, pair: "DOGE", mode: "x" })).toEqual({
      mode: "rebalance",
      pair: "AUTO",
      treasuryUsd: 10_000,
      sliceCount: 24,
    });
    expect(parseSwarmRequest({ mode: "spoofed_metrics", pair: "BTC", sliceCount: "auto" })).toMatchObject({ mode: "spoofed_metrics", pair: "BTC", sliceCount: "auto" });
    expect(parseSwarmRequest({}).sliceCount).toBe("auto");
    expect(parseSwarmRequest({ treasuryUsd: "abc" }).treasuryUsd).toBe(50_000);
    expect(parseSwarmRequest(null).mode).toBe("rebalance");
  });

  it("derives a checksummed EVM address from a secp256k1 key (known vector)", () => {
    // Known vector: secp256k1 private key = 1 -> generator point G -> 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf
    const gx = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const gy = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    const key = `secp256k1:${toBase58(new Uint8Array(Buffer.from(gx + gy, "hex")))}`;
    expect(evmAddressFromSecp256k1(key)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });
});

describe("On-chain testnet proof (offline checks)", () => {
  it("testnet-proof.json describes the locked v2 contract and five real transactions", () => {
    expect(TESTNET_PROOF.network).toBe("testnet");
    expect(TESTNET_PROOF.version).toBe(2);
    expect(TESTNET_PROOF.contract.accountId).toMatch(/^zerodelta-guard-[0-9a-f]{6}\.testnet$/);
    expect(TESTNET_PROOF.accounts.solver).toMatch(/^zerodelta-solver-[0-9a-f]{6}\.testnet$/);
    expect(TESTNET_PROOF.contract.policy).toEqual(EXPECTED_ONCHAIN_POLICY);
    expect(TESTNET_PROOF.contract.locked).toBe(true);
    expect(TESTNET_PROOF.transactions.map((t) => t.kind)).toEqual([
      "DEPLOY_REGISTER_AND_LOCK",
      "RECORD_AND_SIGN_APPROVED_REBALANCE",
      "ROGUE_REBALANCE_REJECTED",
      "PAYLOAD_SWAP_REJECTED",
      "REPLAY_REJECTED",
    ]);
    for (const tx of TESTNET_PROOF.transactions) {
      expect(fromBase58(tx.hash)).toHaveLength(32);
      expect(tx.explorerUrl).toBe(`https://testnet.nearblocks.io/txns/${tx.hash}`);
    }
    const sign = TESTNET_PROOF.transactions[1];
    expect(sign.signerId).toBe(TESTNET_PROOF.accounts.solver);
    expect(sign.expectedReceipt).toEqual({ predecessorId: TESTNET_PROOF.contract.accountId, receiverId: "v1.signer-prod.testnet", methodName: "sign" });
    expect(JSON.stringify(TESTNET_PROOF)).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|secretKey|private/i);
  });

  it("the recorded orders reproduce their payloads and expected rejections offline", () => {
    const c = TESTNET_PROOF.contract.accountId;
    const a = TESTNET_PROOF.approvedOrder;
    expect(computeHedgePayloadHex(c, a.order)).toBe(a.hedgeOrderPayloadHex);
    expect(computeOrderMetrics(a.order)).toEqual(a.contractMetrics);
    const rogue = TESTNET_PROOF.rogueAttempt;
    expect(computeHedgePayloadHex(c, rogue.order)).toBe(rogue.hedgeOrderPayloadHex); // honest payload, fails on math
    expect(computeOrderMetrics(rogue.order).net_delta_bps).toBeGreaterThan(EXPECTED_ONCHAIN_POLICY.max_delta_bps);
    const swap = TESTNET_PROOF.payloadSwapAttempt;
    expect(computeOrderMetrics(swap.order).net_delta_bps).toBe(0); // looks safe
    expect(computeHedgePayloadHex(c, swap.order)).not.toBe(swap.hedgeOrderPayloadHex); // but the payload is for another order
    expect(TESTNET_PROOF.replayAttempt.nonce).toBe(a.order.nonce);
  });

  it("committed contract WASM matches the on-chain code hash recorded at deploy time", () => {
    const wasm = new Uint8Array(readFileSync(TESTNET_PROOF.contract.wasmPath));
    expect(toBase58(sha256Bytes(wasm))).toBe(TESTNET_PROOF.contract.codeHash);
    expect(bytesToHex(sha256Bytes(wasm))).toBe(TESTNET_PROOF.contract.wasmSha256Hex);
  });

  it("the MPC signature recovers to the key derived for the contract (the sign() predecessor)", () => {
    expect(TESTNET_PROOF.mpcSignature.predecessor).toBe(TESTNET_PROOF.contract.accountId);
    expect(TESTNET_PROOF.mpcSignature.payloadHex).toBe(TESTNET_PROOF.approvedOrder.hedgeOrderPayloadHex);
    const v = verifyMpcSignature(TESTNET_PROOF.mpcSignature);
    expect(v).toMatchObject({ valid: true, recoveredMatchesDerivedKey: true, signatureVerifies: true });
    expect(evmAddressFromSecp256k1(TESTNET_PROOF.mpcSignature.derivedPublicKey)).toBe(TESTNET_PROOF.mpcSignature.evmAddress);
  });

  it("a tampered MPC signature or payload no longer verifies", () => {
    const sig = TESTNET_PROOF.mpcSignature;
    const flip = (hex: string) => (hex[hex.length - 1] === "0" ? hex.slice(0, -1) + "1" : hex.slice(0, -1) + "0");
    expect(verifyMpcSignature({ ...sig, payloadHex: flip(sig.payloadHex) }).valid).toBe(false);
    expect(verifyMpcSignature({ ...sig, signature: { ...sig.signature!, s: flip(sig.signature!.s) } }).valid).toBe(false);
  });

  it("the hedge key's predecessor is the deployed Risk Guard contract", () => {
    expect(GUARDIAN_NEAR_ACCOUNT).toBe(TESTNET_PROOF.contract.accountId);
    expect(RISK_GUARD_CONTRACT_ID).toBe(TESTNET_PROOF.contract.accountId);
  });
});
