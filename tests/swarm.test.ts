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
import { EXPECTED_ONCHAIN_POLICY, TESTNET_PROOF, toOnchainMetrics, verifyMpcSignature } from "../src/lib/near/riskGuardContract";
import { ONECLICK_TOKEN_SNAPSHOT, evmAddressFromSecp256k1, type OneClickTokenFeed } from "../src/lib/near/rpcClient";
import { FUNDING_SNAPSHOT, fundingApr, type FundingFeed } from "../src/lib/market/fundingFeed";
import { buildRogueDirectionalPlan, runScannerAgent } from "../src/lib/agents/scannerAgent";
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

async function solve(plan: RebalancePlan, sliceCount = 8): Promise<SolverResult> {
  return runSolverAgent({
    plan,
    sliceCount,
    tokens,
    signer: createEphemeralSigner(),
    guardianBoxPublicKey: getGuardianIdentity().boxPublicKeyHex,
    live: false,
  });
}

function scannerPlan(pair: PairId = "NEAR", treasuryUsd = 50_000) {
  return runScannerAgent({ pair, treasuryUsd, tokens, funding }).plan;
}

function guard(solver: SolverResult, now?: Date) {
  return runGuardianAgent({ runId: "test", solver, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex], now });
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

  it("ranks markets and proposes a 50/50 delta-neutral plan", () => {
    const r = runScannerAgent({ pair: "SOL", treasuryUsd: 100_000, tokens, funding });
    expect(r.scans.map((s) => s.asset).sort()).toEqual(["BTC", "ETH", "NEAR", "SOL"]);
    expect(r.scans[0].fundingAprPct).toBeGreaterThanOrEqual(r.scans.at(-1)!.fundingAprPct);
    const legs = Object.fromEntries(r.plan.legs.map((l) => [l.id, l]));
    expect(legs["spot-long"].notionalUsd).toBe(50_000);
    expect(legs["hedge-margin"].notionalUsd).toBe(50_000);
    expect(legs["perp-short"].deltaUsd).toBe(-50_000);
    expect(r.plan.legs.reduce((s, l) => s + l.deltaUsd, 0)).toBe(0);
    expect(r.expectedTreasuryAprPct).toBeCloseTo(r.selected.fundingAprPct / 2, 6);
  });
});

describe("Delta-neutral risk invariants (Agent 3 math)", () => {
  it("scanner plan is exactly delta-neutral at 1.0x leverage", () => {
    const m = computeRiskMetrics(scannerPlan(), 5);
    expect(m.netDeltaUsd).toBe(0);
    expect(m.netDeltaRatio).toBe(0);
    expect(m.leverage).toBeCloseTo(1.0, 10);
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
  it("approves the hedged plan and prepares a Chain Signatures sign request", async () => {
    const d = guard(await solve(scannerPlan("ETH", 50_000)));
    expect(d.decision).toBe("APPROVED");
    expect(d.violations).toEqual([]);
    expect(d.mpcSignRequest?.contractId).toBe("v1.signer-prod.testnet");
    expect(d.mpcSignRequest?.args.request.payload_v2.Ecdsa).toMatch(/^[0-9a-f]{64}$/);
    expect(d.mpcSignRequest?.args.request.domain_id).toBe(0);
    expect(verifyGuardianDecision(d)).toBe(true);
  });

  it("rejects the rogue unhedged 10x long even though all cryptography is valid", async () => {
    const d = guard(await solve(buildRogueDirectionalPlan("NEAR", 50_000), 1));
    expect(d.decision).toBe("REJECTED");
    expect(d.violations).toEqual(expect.arrayContaining(["DELTA_NEUTRALITY", "LEVERAGE_CEILING"]));
    const byId = Object.fromEntries(d.checks.map((c) => [c.id, c.pass]));
    expect(byId.TEE_ATTESTATION && byId.NEP413_SIGNATURE && byId.ENVELOPE_INTEGRITY).toBe(true);
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

describe("Swarm orchestrator (offline mode)", () => {
  it("runs the full rebalance pipeline with a valid hash-chained audit trail", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
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
      pair: "NEAR",
      treasuryUsd: 10_000,
      sliceCount: 24,
    });
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
  it("rounds metrics up into the contract's integer units", () => {
    expect(toOnchainMetrics({ netDeltaRatio: 0, leverage: 0.9978, maxPriceImpactBps: 1.19 })).toEqual({ net_delta_bps: 0, leverage_x100: 100, slippage_bps: 2 });
    expect(toOnchainMetrics({ netDeltaRatio: 0.02, leverage: 3, maxPriceImpactBps: 25 })).toEqual({ net_delta_bps: 200, leverage_x100: 300, slippage_bps: 25 });
    expect(toOnchainMetrics({ netDeltaRatio: 0.02001, leverage: 3.001, maxPriceImpactBps: 25.01 })).toEqual({ net_delta_bps: 201, leverage_x100: 301, slippage_bps: 26 });
  });

  it("testnet-proof.json describes the deployed contract and four real transactions", () => {
    expect(TESTNET_PROOF.network).toBe("testnet");
    expect(TESTNET_PROOF.contract.accountId).toMatch(/^zerodelta-guard-[0-9a-f]{6}\.testnet$/);
    expect(TESTNET_PROOF.accounts.solver).toMatch(/^zerodelta-solver-[0-9a-f]{6}\.testnet$/);
    expect(TESTNET_PROOF.contract.policy).toEqual(EXPECTED_ONCHAIN_POLICY);
    expect(TESTNET_PROOF.transactions.map((t) => t.kind)).toEqual([
      "DEPLOY_AND_REGISTER_POLICY",
      "RECORD_APPROVED_REBALANCE",
      "ROGUE_REBALANCE_REJECTED",
      "MPC_SIGN_HEDGE",
    ]);
    for (const tx of TESTNET_PROOF.transactions) {
      expect(fromBase58(tx.hash)).toHaveLength(32);
      expect(tx.explorerUrl).toBe(`https://testnet.nearblocks.io/txns/${tx.hash}`);
    }
    expect(JSON.stringify(TESTNET_PROOF)).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|secretKey|private/i);
  });

  it("committed contract WASM matches the on-chain code hash recorded at deploy time", () => {
    const wasm = new Uint8Array(readFileSync(TESTNET_PROOF.contract.wasmPath));
    expect(toBase58(sha256Bytes(wasm))).toBe(TESTNET_PROOF.contract.codeHash);
    expect(bytesToHex(sha256Bytes(wasm))).toBe(TESTNET_PROOF.contract.wasmSha256Hex);
  });

  it("the recorded MPC signature recovers to the guard account's derived secp256k1 key", () => {
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

  it("the guardian's Chain Signatures predecessor is the real funded guard account", () => {
    expect(GUARDIAN_NEAR_ACCOUNT).toBe(TESTNET_PROOF.accounts.guard);
  });
});
