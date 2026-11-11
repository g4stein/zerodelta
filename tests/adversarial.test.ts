/**
 * Adversarial and robustness tests for the off-chain swarm (deterministic, offline).
 * Each test states the invariant or failure mode it attacks.
 * The on-chain equivalents live in contracts/risk-guard/tests/adversarial.rs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEphemeralSigner, generateNonce, signNep413, buildIntentMessage } from "../src/lib/near/nep413";
import { ONECLICK_TOKEN_SNAPSHOT, nearRpc, simulateIntents, viewAccount, type OneClickTokenFeed } from "../src/lib/near/rpcClient";
import { FUNDING_SNAPSHOT, type FundingFeed } from "../src/lib/market/fundingFeed";
import { probeEntryCosts, runScannerAgent } from "../src/lib/agents/scannerAgent";
import { getSolverEnclave, runSolverAgent, type SolverResult } from "../src/lib/agents/solverAgent";
import { ORDER_MAX_AGE_MS, getGuardianIdentity, runGuardianAgent } from "../src/lib/agents/guardianAgent";
import { createEnclave, signAttestation } from "../src/lib/crypto/attestation";
import { checkOrderOnchain, getOnchainGuardState, verifyProofTx, TESTNET_PROOF } from "../src/lib/near/riskGuardContract";
import { computeHedgePayloadHex, nextOrderNonce, orderParamsFromPlan } from "../src/lib/near/orderCommitment";
import { RISK_GUARD_CONTRACT_ID } from "../src/lib/near/deployment";
import { runSwarm } from "../src/lib/swarm/orchestrator";
import { parseSwarmRequest, type PairId, type RebalancePlan } from "../src/lib/swarm/types";

const tokens: OneClickTokenFeed = { live: false, source: "test", tokens: ONECLICK_TOKEN_SNAPSHOT, count: ONECLICK_TOKEN_SNAPSHOT.length, chains: [], fetchedAt: "" };
const funding: FundingFeed = { live: false, source: "test", markets: FUNDING_SNAPSHOT, fetchedAt: "" };
const costs = await probeEntryCosts(false, "offline");

const plan = (pair: PairId = "ETH", treasuryUsd = 50_000) => runScannerAgent({ pair, treasuryUsd, tokens, funding, costs }).plan;
const solve = (p: RebalancePlan, sliceCount = 4): Promise<SolverResult> =>
  runSolverAgent({ plan: p, sliceCount, tokens, signer: createEphemeralSigner(), guardianBoxPublicKey: getGuardianIdentity().boxPublicKeyHex, live: false });
const guard = (solver: SolverResult, extra: Partial<Parameters<typeof runGuardianAgent>[0]> = {}) =>
  runGuardianAgent({ runId: "adv", solver, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex], ...extra });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Economics: Agent 1 must not present a losing trade as a recommendation", () => {
  const allNegative: FundingFeed = {
    ...funding,
    markets: Object.fromEntries(Object.entries(funding.markets).map(([k, m]) => [k, { ...m, fundingHourly: -0.00001 }])),
  };

  it("AUTO mode returns NO_TRADE when every market has negative funding", () => {
    const r = runScannerAgent({ pair: "AUTO", treasuryUsd: 50_000, tokens, funding: allNegative, costs });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.recommendationReason).toMatch(/^NO_TRADE/);
    expect(r.opportunityMatrix.every((o) => !o.eligible)).toBe(true);
  });

  it("a manual pick of an unprofitable market is NO_TRADE, not a recommendation", () => {
    const r = runScannerAgent({ pair: "NEAR", treasuryUsd: 50_000, tokens, funding, costs }); // snapshot NEAR carry < costs
    expect(r.selected.netCarryAprPct).toBeLessThan(0);
    expect(r.recommendation).toBe("NO_TRADE");
  });

  it("live mode refuses to recommend on snapshot data", () => {
    const r = runScannerAgent({ pair: "AUTO", treasuryUsd: 50_000, tokens, funding, costs, requireLiveData: true });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.recommendationReason).toMatch(/live funding or the live 1Click cost probe for \w+ is unavailable/);
  });

  it("the orchestrator withholds settlement and the sign request on NO_TRADE", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 4 }, { live: false });
    expect(run.economics).toMatchObject({ recommendation: "NO_TRADE", settlementWithheld: true, overridden: false });
    expect(run.settlement.status).toBe("NO_TRADE");
    expect(run.settlement.simulation).toBeNull();
    expect(run.guardian.mpcSignRequest).toBeNull();
    expect(run.audit.events.some((e) => e.event === "NO_TRADE_RECOMMENDED")).toBe(true);
  });

  it("the demo override runs settlement but stays labelled as an override", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 4, simulateUnprofitable: true }, { live: false });
    expect(run.economics).toMatchObject({ recommendation: "NO_TRADE", overridden: true, settlementWithheld: false });
    expect(run.settlement.status).toBe("SKIPPED_OFFLINE");
    expect(run.guardian.mpcSignRequest).not.toBeNull();
  });

  it("treasury APR is net carry on the deployed spot fraction, not on hedge notional alone", () => {
    const r = runScannerAgent({ pair: "AUTO", treasuryUsd: 100_000, tokens, funding, costs });
    const spot = r.plan.legs.find((l) => l.kind === "SPOT")!.notionalUsd;
    expect(r.expectedTreasuryAprPct).toBeCloseTo((r.selected.netCarryAprPct * spot) / 100_000, 2);
    expect(r.expectedTreasuryAprPct).toBeLessThan(r.selected.netCarryAprPct);
  });

  it("only boolean true enables the override over HTTP", () => {
    expect(parseSwarmRequest({ simulateUnprofitable: "yes" }).simulateUnprofitable).toBeUndefined();
    expect(parseSwarmRequest({ simulateUnprofitable: true }).simulateUnprofitable).toBe(true);
  });
});

describe("Post-merge audit regressions", () => {
  it("an unreadable on-chain last_nonce fails the replay invariant (fail closed)", async () => {
    const s = await solve(plan());
    const d = guard(s, { lastAcceptedNonce: null });
    expect(d.decision).toBe("REJECTED");
    expect(d.checks.find((c) => c.id === "REPLAY_AND_MPC_GATE")!.detail).toMatch(/ONCHAIN_NONCE_UNAVAILABLE/);
    expect(d.mpcSignRequest).toBeNull();
  });

  it("a live run with every network call failing is never approved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const run = await runSwarm({ mode: "rebalance", pair: "ETH", treasuryUsd: 50_000, sliceCount: 4, simulateUnprofitable: true }, { live: true });
    expect(run.guardian.decision).toBe("REJECTED");
    expect(run.guardian.violations).toContain("REPLAY_AND_MPC_GATE");
    expect(run.guardian.mpcSignRequest).toBeNull();
    expect(run.economics.recommendation).toBe("NO_TRADE"); // snapshot data is never a recommendation
  });

  it("settlementWithheld is only reported for runs the guard approved", async () => {
    // manual NEAR on snapshot data is NO_TRADE; force a guard rejection with a stale clock
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 4 }, { live: false });
    expect(run.economics.recommendation).toBe("NO_TRADE");
    expect(run.economics.settlementWithheld).toBe(run.guardian.decision === "APPROVED");
  });

  it("a withheld approval is recorded in the signed decision and the audit trail", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 4 }, { live: false });
    expect(run.guardian.decision).toBe("APPROVED");
    expect(run.guardian.decisionRecord).toMatchObject({ economicRecommendation: "NO_TRADE", signRequestWithheld: true });
    expect(run.audit.events.map((e) => e.event)).toContain("RISK_APPROVED_SETTLEMENT_WITHHELD");
    expect(run.audit.events.map((e) => e.event)).not.toContain("INTENT_APPROVED");
  });

  it("an unknown pair is rejected, not thrown", async () => {
    const s = await solve(plan());
    const bad = { ...s, executablePlan: { ...s.executablePlan, pair: "DOGE" as PairId } };
    const d = guard(bad);
    expect(d.decision).toBe("REJECTED");
    expect(d.violations).toEqual(expect.arrayContaining(["ENVELOPE_INTEGRITY", "ORDER_PAYLOAD_BINDING"]));
  });

  it("TRADE requires a live cost probe for the chosen market, not just any market", () => {
    const liveFunding = { ...funding, live: true };
    const mixed = { ...costs, BTC: { ...costs.BTC, source: "1click-live" as const } };
    const r = runScannerAgent({ pair: "ETH", treasuryUsd: 50_000, tokens, funding: liveFunding, costs: mixed, requireLiveData: true });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.recommendationReason).toMatch(/ETH is unavailable/);
    const liveEth = { ...costs, ETH: { ...costs.ETH, source: "1click-live" as const } };
    const ok = runScannerAgent({ pair: "ETH", treasuryUsd: 50_000, tokens, funding: liveFunding, costs: liveEth, requireLiveData: true });
    expect(ok.recommendation).toBe(ok.selected.eligible ? "TRADE" : "NO_TRADE");
  });
});

describe("Invariant 7: the solver cannot change what it was asked to trade", () => {
  it("rejects a solver that inflates the treasury in its own plan", async () => {
    const s = await solve(plan("ETH", 50_000));
    const d = guard(s, { expected: { treasuryUsd: 25_000, pair: "ETH" } });
    expect(d.violations).toContain("ORDER_PAYLOAD_BINDING");
    expect(d.checks.find((c) => c.id === "ORDER_PAYLOAD_BINDING")!.detail).toMatch(/TREASURY_MISMATCH/);
  });

  it("rejects a solver that silently switches the asset", async () => {
    const s = await solve(plan("ETH", 50_000));
    const d = guard(s, { expected: { treasuryUsd: 50_000, pair: "BTC" } });
    expect(d.checks.find((c) => c.id === "ORDER_PAYLOAD_BINDING")!.detail).toMatch(/ASSET_MISMATCH/);
  });

  it("approves when the trusted inputs match", async () => {
    const s = await solve(plan("ETH", 50_000));
    expect(guard(s, { expected: { treasuryUsd: 50_000, pair: "ETH" } }).decision).toBe("APPROVED");
  });

  it("rejects a payload committed to a different contract", async () => {
    const s = await solve(plan("BTC"));
    const d = guard({ ...s, hedgeOrderPayloadHex: computeHedgePayloadHex("attacker.testnet", s.order), commitmentContractId: "attacker.testnet" });
    expect(d.violations).toContain("ORDER_PAYLOAD_BINDING");
  });
});

describe("Invariant 8: nonces (stale, future, concurrent, collisions, integer range)", () => {
  it("rejects an order whose nonce is older than the freshness window", async () => {
    const s = await solve(plan());
    const later = new Date(Math.floor(s.order.nonce / 1000) + ORDER_MAX_AGE_MS + 1_000);
    const d = guard(s, { now: later });
    expect(d.checks.find((c) => c.id === "REPLAY_AND_MPC_GATE")!.detail).toMatch(/STALE_ORDER/);
  });

  it("rejects a nonce far in the future", async () => {
    const s = await solve(plan());
    const order = { ...s.order, nonce: (Date.now() + 10 * 60_000) * 1000 };
    const d = guard({ ...s, order, hedgeOrderPayloadHex: computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, order) });
    expect(d.checks.find((c) => c.id === "REPLAY_AND_MPC_GATE")!.detail).toMatch(/FUTURE_NONCE/);
  });

  it("concurrent runs that finish out of order do not reject each other", async () => {
    const [a, b, c] = await Promise.all([solve(plan("ETH")), solve(plan("BTC")), solve(plan("SOL"))]);
    expect(new Set([a.order.nonce, b.order.nonce, c.order.nonce]).size).toBe(3);
    // approve newest first, then the older ones
    const sorted = [a, b, c].sort((x, y) => y.order.nonce - x.order.nonce);
    for (const s of sorted) expect(guard(s).decision).toBe("APPROVED");
    for (const s of sorted) expect(guard(s).violations).toEqual(["REPLAY_AND_MPC_GATE"]);
  });

  it("nonces stay strictly increasing within the same millisecond", () => {
    const t = Date.now() + 5_000;
    const n = [nextOrderNonce(t), nextOrderNonce(t), nextOrderNonce(t)];
    expect(n[1]).toBe(n[0] + 1);
    expect(n[2]).toBe(n[1] + 1);
    expect(Number.isSafeInteger(n[2])).toBe(true);
  });

  it("refuses unsafe integers instead of silently rounding them", async () => {
    const s = await solve(plan());
    expect(() => orderParamsFromPlan(s.executablePlan, 1, 2 ** 53)).toThrow(/safe integer/);
    expect(() => orderParamsFromPlan({ ...s.executablePlan, treasuryUsd: 1e14 }, 1, 1)).toThrow(/safe integer/);
    const d = guard({ ...s, order: { ...s.order, nonce: 2 ** 53 + 2 } });
    expect(d.violations).toContain("REPLAY_AND_MPC_GATE");
  });
});

describe("Intent and attestation tampering", () => {
  it("rejects an intent addressed to a different contract", async () => {
    const s = await solve(plan());
    const signer = createEphemeralSigner();
    const forged = signNep413(signer.keyPair, { message: s.intent.signed.payload.message, nonce: generateNonce(), recipient: "evil.near" });
    const d = guard({ ...s, intent: { ...s.intent, ...forged } });
    expect(d.violations).toContain("NEP413_SIGNATURE");
  });

  it("rejects an intent whose signer_id is not the signing key's account", async () => {
    const s = await solve(plan());
    const other = createEphemeralSigner();
    const forged = signNep413(other.keyPair, { message: s.intent.signed.payload.message, nonce: generateNonce(), recipient: "intents.near" });
    const d = guard({ ...s, intent: { ...s.intent, ...forged } });
    expect(d.checks.find((c) => c.id === "NEP413_SIGNATURE")!.detail).toMatch(/signer_id/);
  });

  it("rejects an attestation signed by an untrusted enclave key", async () => {
    const s = await solve(plan());
    const impostor = createEnclave();
    const att = signAttestation(impostor, s.attestation.report.reportData);
    const d = guard({ ...s, attestation: att });
    expect(d.attestation.enclaveKeyTrusted).toBe(false);
    expect(d.violations).toContain("TEE_ATTESTATION");
  });

  it("rejects an envelope with an altered slice commitment", async () => {
    const s = await solve(plan(), 3);
    const slices = s.envelope.slices.map((x, i) => (i === 1 ? { ...x, commitment: "00".repeat(32) } : x));
    expect(guard({ ...s, envelope: { ...s.envelope, slices } }).violations).toContain("ENVELOPE_INTEGRITY");
  });

  it("rejects an envelope with a dropped slice", async () => {
    const s = await solve(plan(), 3);
    const d = guard({ ...s, envelope: { ...s.envelope, slices: s.envelope.slices.slice(0, 2) } });
    expect(d.violations).toContain("ENVELOPE_INTEGRITY");
  });
});

describe("Network failures degrade safely (mocked fetch, no real network)", () => {
  const msg = buildIntentMessage({ signer_id: "x", deadline: new Date().toISOString(), intents: [] });

  it("a semantic RPC error (UNKNOWN_ACCOUNT) is authoritative and not retried elsewhere", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Server error", cause: { name: "UNKNOWN_ACCOUNT" } } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const r = await nearRpc("testnet", "query", {});
    expect(r).toMatchObject({ ok: false, error: "UNKNOWN_ACCOUNT" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the deprecated-endpoint -429 response fails over to the next endpoint", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      return call === 1
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -429, message: "WARNING! THIS ENDPOINT IS DEPRECATED!" } }), { status: 200 })
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { chain_id: "testnet" } }), { status: 200 });
    }));
    const r = await nearRpc<{ chain_id: string }>("testnet", "status", []);
    expect(r.ok && r.result.chain_id).toBe("testnet");
    expect(call).toBe(2);
  });

  it("unavailable RPC: reads return labelled failures instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const r = await nearRpc("testnet", "status", []);
    expect(r.ok).toBe(false);
    expect((await viewAccount("testnet", "x.testnet")).live).toBe(false);
    const c = await checkOrderOnchain(TESTNET_PROOF.approvedOrder.order, TESTNET_PROOF.approvedOrder.hedgeOrderPayloadHex);
    expect(c.live).toBe(false);
    expect(c.approved).toBeUndefined(); // never defaults to "approved"
    const sim = await simulateIntents([signNep413(createEphemeralSigner().keyPair, { message: msg, nonce: generateNonce(), recipient: "intents.near" }).signed]);
    expect(sim.status).toBe("UNREACHABLE");
  });

  it("malformed RPC JSON: contract state and tx checks fail closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { nonsense: true } }), { status: 200 })));
    const state = await getOnchainGuardState();
    expect(state.live).toBe(false);
    expect(state.locked).toBeUndefined();
    const v = await verifyProofTx(TESTNET_PROOF.transactions[1]);
    expect(v.matchesExpectation).toBe(false);
  });

  it("an RPC error object is reported as an error, not success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "rate limited", cause: { name: "TOO_MANY_REQUESTS" } } }), { status: 200 })));
    const r = await nearRpc("testnet", "status", []);
    // rate limits are transient: every endpoint is tried, then the failure is reported
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.match(/TOO_MANY_REQUESTS/g)?.length).toBe(2);
    const v = await verifyProofTx(TESTNET_PROOF.transactions[0]);
    expect(v.found).toBe(false);
    expect(v.matchesExpectation).toBe(false);
  });

  it("an offline run reports that the on-chain check did not happen", async () => {
    const run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: false });
    expect(run.onchainCheck).toBeNull();
    expect(run.settlement.status).toBe("SKIPPED_OFFLINE");
  });
});
