import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import { createEphemeralSigner, generateNonce, signNep413 } from "../src/lib/near/nep413";
import { ONECLICK_TOKEN_SNAPSHOT } from "../src/lib/near/rpcClient";
import { FUNDING_SNAPSHOT } from "../src/lib/market/fundingFeed";
import { probeEntryCosts, runScannerAgent } from "../src/lib/agents/scannerAgent";
import { getSolverEnclave, runSolverAgent } from "../src/lib/agents/solverAgent";
import { getGuardianIdentity, runGuardianAgent } from "../src/lib/agents/guardianAgent";
import { computeHedgePayloadHex, computeOrderMetrics, orderParamsFromPlan } from "../src/lib/near/orderCommitment";
import { computeReportData, signAttestation } from "../src/lib/crypto/attestation";
import { canonicalJson, fromBase64, hashObject, hexToBytes, sha256Hex, toBase64, utf8ToBytes } from "../src/lib/crypto/encoding";
import { runSwarm, verifyAuditChain } from "../src/lib/swarm/orchestrator";
import { verifyQuoteEvidence } from "../src/lib/market/quoteService";
import { verifyRecordedAcceptance, parseRecoveredAddress } from "../src/lib/hyperliquid/acceptance";

const tokens = { live: false, source: "test", tokens: ONECLICK_TOKEN_SNAPSHOT, count: ONECLICK_TOKEN_SNAPSHOT.length, chains: [], fetchedAt: "" };
const funding = { live: false, source: "test", markets: FUNDING_SNAPSHOT, fetchedAt: "" };
const costs = await probeEntryCosts(false, "test");
const plan = runScannerAgent({ pair: "ETH", treasuryUsd: 50000, tokens, funding, costs }).plan;
async function setup(live = false) {
  const signer = createEphemeralSigner();
  const solver = await runSolverAgent({ plan: structuredClone(plan), sliceCount: 4, tokens, signer, guardianBoxPublicKey: getGuardianIdentity().boxPublicKeyHex, live });
  const attest = () => { solver.attestation = signAttestation(getSolverEnclave(), computeReportData({ envelopeHash: solver.envelope.envelopeHash, intentPayloadHash: solver.intent.payloadHashHex, planHash: hashObject(solver.executablePlan), hedgeOrderPayloadHex: solver.hedgeOrderPayloadHex, quotesHash: hashObject(solver.quotes) })); };
  const rebind = () => { solver.planHash = hashObject(solver.executablePlan); solver.order = orderParamsFromPlan(solver.executablePlan, solver.maxPriceImpactBps, solver.order.nonce); solver.hedgeOrderPayloadHex = computeHedgePayloadHex(solver.commitmentContractId, solver.order); attest(); };
  const guard = (extra: Partial<Parameters<typeof runGuardianAgent>[0]> = {}) => runGuardianAgent({ runId: "review", solver, expectedSignerId: signer.accountId, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex], allowOfflineQuotes: !live, expected: { treasuryUsd: 50000, pair: "ETH" }, lastAcceptedNonce: 0, ...extra });
  return { solver, signer, attest, rebind, guard };
}
afterEach(() => vi.unstubAllGlobals());

describe("Canonical risk and independent quote evidence", () => {
  it("rejects a LONG disguised with negative delta even with consistent hashes", async () => {
    const { solver, rebind, guard } = await setup();
    solver.executablePlan.legs.find(l => l.kind === "PERP")!.side = "LONG";
    rebind();
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.metrics.netDeltaRatio).toBe(computeOrderMetrics(solver.order).net_delta_bps / 10000);
    expect(d.violations).toContain("DELTA_NEUTRALITY");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("enforces integer-rounded policy boundaries", async () => {
    const { solver, rebind, guard } = await setup();
    const spot = solver.executablePlan.legs.find(l => l.kind === "SPOT")!;
    solver.executablePlan.legs.find(l => l.kind === "PERP")!.notionalUsd = spot.notionalUsd - 1000.01;
    rebind();
    expect(computeOrderMetrics(solver.order).net_delta_bps).toBe(201);
    expect(guard().violations).toContain("DELTA_NEUTRALITY");
  });
  it("rejects quote minima altered together with a new signature and attestation", async () => {
    const { solver, signer, attest, guard } = await setup();
    const q = solver.quotes[0]; q.minAmountOut = "1";
    const msg = JSON.parse(solver.intent.signed.payload.message); msg.intents[0].diff[q.destinationAsset] = "1";
    Object.assign(solver.intent, signNep413(signer.keyPair, { message: JSON.stringify(msg), nonce: generateNonce(), recipient: "intents.near" }));
    attest();
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.violations).toContain("NEP413_SIGNATURE");
    expect(d.violations).toContain("SLIPPAGE_CEILING");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("does not launder failed quotes using unsigned validity flags", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const { solver, guard } = await setup(true);
    solver.quotes.forEach(q => { q.source = "1click-live"; q.validForAuthorization = true; });
    const d = guard();
    expect(d.attestation.reportDataBound).toBe(false);
    expect(d.violations).toContain("SLIPPAGE_CEILING");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("rejects a quote/report mismatch even after fresh re-attestation", async () => {
    const { solver, rebind, guard } = await setup();
    solver.quotes.forEach(q => { q.priceImpactBps = 900; q.validForAuthorization = true; });
    solver.maxPriceImpactBps = 0; rebind();
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.violations).toContain("SLIPPAGE_CEILING");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("rejects made-up receipt identifiers", async () => {
    const { solver, attest, guard } = await setup(); solver.quotes[0].evidenceId = "a".repeat(48); attest();
    expect(guard().violations).toContain("NEP413_SIGNATURE");
  });
  it("does not accept an offline receipt in a live guard", async () => {
    const { guard } = await setup(); expect(guard({ allowOfflineQuotes: false }).mpcSignRequest).toBeNull();
  });
  it("binds receipts to recipient, data and freshness", async () => {
    const { solver, signer } = await setup(); const q = solver.quotes[0];
    expect(verifyQuoteEvidence(q, signer.accountId, true, Date.now())).toBe(true);
    expect(verifyQuoteEvidence(q, "attacker", true, Date.now())).toBe(false);
    expect(verifyQuoteEvidence({ ...q, amountOutUsd: 999999 }, signer.accountId, true, Date.now())).toBe(false);
    expect(verifyQuoteEvidence(q, signer.accountId, true, Date.now() + 121000)).toBe(false);
  });
  it.each([NaN, Infinity, -1])("rejects a malformed plan amount %s without crashing", async value => {
    const { solver, guard } = await setup(); solver.executablePlan.legs[0].notionalUsd = value;
    expect(guard().decision).toBe("REJECTED"); expect(guard().mpcSignRequest).toBeNull();
  });
  it("rejects an arbitrary plan hash and signs only the actual plan's hash", async () => {
    const { solver, guard } = await setup(); solver.planHash = "f".repeat(64);
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.violations).toContain("ORDER_PAYLOAD_BINDING");
    expect(d.decisionRecord.planHash).toBe(hashObject(solver.executablePlan));
    expect(d.mpcSignRequest).toBeNull();
  });
});

describe("Encrypted execution slices", () => {
  const changes: [string, (x: any, i: number) => void][] = [
    ["wrong origin", x => { x.originAsset = "attacker-token"; }],
    ["wrong destination", x => { x.destinationAsset = "attacker-token"; }],
    ["zero minimum", x => { x.minAmountOut = "0"; }],
    ["mismatched minimum totals", x => { x.minAmountOut = "1"; }],
    ["negative input", x => { x.amountIn = "-1"; }],
    ["duplicate index", x => { x.index = 0; }],
    ["wrong leg", x => { x.legId = "hedge-margin"; }],
    ["negative release", x => { x.releaseAtOffsetSec = -1; }],
    ["nonintegral release", x => { x.releaseAtOffsetSec = .5; }],
    ["out-of-window release", x => { x.releaseAtOffsetSec = 100000; }],
    ["reordered release", x => { x.releaseAtOffsetSec = 1; }],
  ];
  it.each(changes)("rejects %s despite correct encryption and fresh attestation", async (_name, change) => {
    const { solver, attest, guard } = await setup(); const guardian = getGuardianIdentity(); const enclave = getSolverEnclave();
    solver.envelope.slices = solver.envelope.slices.map((entry, i) => {
      const opened = nacl.box.open(fromBase64(entry.ciphertext), fromBase64(entry.nonce), hexToBytes(solver.envelope.enclaveBoxPublicKey), guardian.boxKeyPair.secretKey)!;
      const x = JSON.parse(new TextDecoder().decode(opened)); change(x, i);
      const bytes = utf8ToBytes(canonicalJson(x)); const nonce = nacl.randomBytes(24);
      return { ...entry, commitment: sha256Hex(bytes), nonce: toBase64(nonce), ciphertext: toBase64(nacl.box(bytes, nonce, guardian.boxKeyPair.publicKey, enclave.boxKeyPair.secretKey)) };
    });
    const { envelopeHash, envelopeId, ...body } = solver.envelope; solver.envelope.envelopeHash = hashObject(body); attest();
    const d = guard(); expect(d.attestation.valid).toBe(true); expect(d.violations).toContain("ENVELOPE_INTEGRITY"); expect(d.mpcSignRequest).toBeNull();
  });
  it("rejects a declared slice count mismatch", async () => {
    const { solver, attest, guard } = await setup(); solver.envelope.sliceCount++; const { envelopeHash, envelopeId, ...body } = solver.envelope; solver.envelope.envelopeHash = hashObject(body); attest();
    expect(guard().violations).toContain("ENVELOPE_INTEGRITY");
  });
});

describe("Authenticated complete audit histories", () => {
  it("rejects explanations, prefix truncation, empty history and forged seals", async () => {
    const r = await runSwarm({ mode: "rebalance", pair: "ETH", treasuryUsd: 50000, sliceCount: 4 }, { live: false });
    const verify = (events = r.audit.events, seal = r.audit.seal, publicKey = r.guardian.guardianPublicKey, decisionHash = r.guardian.decisionHash) => verifyAuditChain(events, seal, publicKey, decisionHash);
    expect(verify()).toBe(true);
    const edited = structuredClone(r.audit.events); edited[0].detail = "a different explanation";
    expect(verify(edited)).toBe(false);
    expect(verify(r.audit.events.slice(0, 2))).toBe(false);
    expect(verify([])).toBe(false);
    expect(verify(r.audit.events, { ...r.audit.seal, rootHash: "0".repeat(64) })).toBe(false);
    expect(verify(r.audit.events, { ...r.audit.seal, signature: "0".repeat(128) })).toBe(false);
    expect(verify(r.audit.events, r.audit.seal, "0".repeat(64))).toBe(false);
    expect(verify(r.audit.events, r.audit.seal, r.guardian.guardianPublicKey, "0".repeat(64))).toBe(false);
  });
});

describe("Recorded exchange evidence must be recomputed", () => {
  const proof = JSON.parse(readFileSync("testnet-proof.json", "utf8"));
  const record = JSON.parse(readFileSync("hl-acceptance.json", "utf8"));
  it("accepts the real preserved record", () => expect(verifyRecordedAcceptance(proof, record)).toEqual([]));
  const mutations: [string, (r: any) => void][] = [
    ["corrupt raw response", r => { r.results.forEach((x: any) => { x.rawResponse = "CORRUPT"; }); }],
    ["zero recovered addresses", r => { r.results.forEach((x: any) => { x.recoveredAddress = "0x" + "0".repeat(40); }); }],
    ["missing controls", r => { r.results = r.results.slice(0, 1); }],
    ["missing results", r => { delete r.results; }],
    ["duplicate real signature", r => { r.results[1].request.signature = r.results[0].request.signature; }],
    ["altered action", r => { r.results[0].request.action.orders[0].s = "999"; }],
    ["altered nonce", r => { r.results[0].request.nonce++; }],
    ["altered expiry", r => { r.results[0].request.expiresAfter++; }],
    ["unexpected request field", r => { r.results[0].request.unknown = true; }],
    ["duplicate nonce response", r => { r.results[0].rawResponse = JSON.stringify({ status: "err", response: "Invalid nonce: duplicate nonce" }); }],
    ["changed role", r => { r.results[1].role = "real"; }],
    ["false agreement flag", r => { r.results[0].hyperliquidAgreesWithLocalRecovery = false; }],
  ];
  it.each(mutations)("rejects %s despite other saved PASS flags", (_name, change) => {
    const r = structuredClone(record); change(r); expect(verifyRecordedAcceptance(proof, r).length).toBeGreaterThan(0);
  });
  it("rejects a changed action even if both proof and record are edited together", () => {
    const p = structuredClone(proof); const r = structuredClone(record);
    p.approvedHedge.exchangeRequest.action.orders[0].s = "999";
    r.results.forEach((x: any) => { x.request.action = structuredClone(p.approvedHedge.exchangeRequest.action); });
    expect(verifyRecordedAcceptance(p, r)).toContain("exchange request does not rebuild the signed digest");
  });
  it("handles null and malformed JSON without throwing", () => {
    expect(parseRecoveredAddress("null")).toBeNull(); expect(parseRecoveredAddress("{" )).toBeNull(); expect(verifyRecordedAcceptance(null, null).length).toBeGreaterThan(0);
  });
});
