/**
 * Swarm orchestrator: runs Scanner -> Confidential Solver -> Risk Guard ->
 * (dry-run) settlement, and records a hash-chained audit trail.
 *
 * Settlement is a dry run: the signed intent is executed by the real
 * `intents.near` contract through its `simulate_intents` view method, the
 * deployed testnet Risk Guard contract re-checks the metrics (`check_rebalance`),
 * and the Chain Signatures request is prepared but not broadcast. No funds move.
 * The one-time on-chain proof transactions live in testnet-proof.json.
 */
import { createEphemeralSigner } from "../near/nep413";
import {
  fetchOneClickTokens,
  getMpcDerivedAccount,
  simulateIntents,
  ONECLICK_TOKEN_SNAPSHOT,
  type DerivedMpcAccount,
  type IntentSimulation,
  type OneClickTokenFeed,
} from "../near/rpcClient";
import { fetchFundingFeed, FUNDING_SNAPSHOT, type FundingFeed } from "../market/fundingFeed";
import { buildRogueDirectionalPlan, runScannerAgent, type ScannerResult } from "../agents/scannerAgent";
import { getSolverEnclave, runSolverAgent, type SolverResult } from "../agents/solverAgent";
import {
  GUARDIAN_NEAR_ACCOUNT,
  HEDGE_DERIVATION_PATH,
  getGuardianIdentity,
  runGuardianAgent,
  type GuardianDecision,
} from "../agents/guardianAgent";
import { hashObject, sha256Hex } from "../crypto/encoding";
import { checkRebalanceOnchain, toOnchainMetrics, type OnchainPolicyCheck } from "../near/riskGuardContract";
import { PAIRS, type RebalancePlan, type SwarmRequest } from "./types";

export type AgentName = "orchestrator" | "scanner" | "solver" | "guardian" | "settlement";

export interface AuditEvent {
  seq: number;
  at: string;
  agent: AgentName;
  event: string;
  detail: string;
  dataHash: string;
  prevHash: string;
  hash: string;
}

export interface AgentStep {
  agent: Exclude<AgentName, "orchestrator">;
  title: string;
  status: "completed" | "approved" | "rejected" | "blocked" | "skipped";
  startedAt: string;
  durationMs: number;
  summary: string;
}

export interface AllocationRow {
  chain: string;
  venue: string;
  asset: string;
  amount: string;
  usd: number;
  deltaUsd: number;
  role: string;
}

export interface Settlement {
  status: "DRY_RUN_SETTLED" | "BLOCKED_BY_GUARD" | "SKIPPED_OFFLINE" | "VERIFIER_REJECTED";
  simulation: IntentSimulation | null;
  allocation: AllocationRow[];
  notes: string[];
}

export interface SwarmRun {
  runId: string;
  mode: SwarmRequest["mode"];
  request: SwarmRequest;
  live: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sources: { tokens: Omit<OneClickTokenFeed, "tokens">; funding: Omit<FundingFeed, "markets"> };
  scanner: ScannerResult;
  injectedPlan: RebalancePlan | null;
  solver: SolverResult;
  guardian: GuardianDecision;
  /** Result of the deployed testnet contract's check_rebalance view on this run's metrics (null offline). */
  onchainCheck: OnchainPolicyCheck | null;
  mpcAccount: DerivedMpcAccount | null;
  settlement: Settlement;
  steps: AgentStep[];
  audit: { events: AuditEvent[]; rootHash: string };
}

export interface RunOptions {
  /** When false, no network calls are made and bundled snapshots / local quotes are used. */
  live?: boolean;
}

export function isOfflineEnv(): boolean {
  return process.env.ZERODELTA_OFFLINE === "1";
}

class AuditTrail {
  events: AuditEvent[] = [];
  private prev = "0".repeat(64);
  record(agent: AgentName, event: string, detail: string, data: unknown = null) {
    const at = new Date().toISOString();
    const dataHash = hashObject(data);
    const seq = this.events.length;
    const hash = sha256Hex(`${this.prev}|${seq}|${at}|${agent}|${event}|${dataHash}`);
    this.events.push({ seq, at, agent, event, detail, dataHash, prevHash: this.prev, hash });
    this.prev = hash;
  }
  get rootHash() {
    return this.prev;
  }
}

/** Recomputes the audit chain; returns true if no event was altered, removed or reordered. */
export function verifyAuditChain(events: AuditEvent[]): boolean {
  let prev = "0".repeat(64);
  return events.every((e, i) => {
    const ok =
      e.seq === i &&
      e.prevHash === prev &&
      e.hash === sha256Hex(`${prev}|${e.seq}|${e.at}|${e.agent}|${e.event}|${e.dataHash}`);
    prev = e.hash;
    return ok;
  });
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; startedAt: string; durationMs: number }> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const value = await fn();
  return { value, startedAt, durationMs: Math.round(performance.now() - t0) };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function buildAllocation(solver: SolverResult, approved: boolean, treasuryUsd: number): AllocationRow[] {
  if (!approved) {
    return [
      {
        chain: "NEAR",
        venue: "NEAR Intents",
        asset: "USDC",
        amount: treasuryUsd.toLocaleString("en-US"),
        usd: treasuryUsd,
        deltaUsd: 0,
        role: "Unchanged — intent blocked before signing",
      },
    ];
  }
  const cfg = PAIRS[solver.executablePlan.pair];
  const spotQ = solver.quotes.find((q) => q.legId === "spot-long")!;
  const marginQ = solver.quotes.find((q) => q.legId === "hedge-margin");
  const perp = solver.executablePlan.legs.find((l) => l.kind === "PERP")!;
  const inUsd = solver.quotes.reduce((s, q) => s + q.amountInUsd, 0);
  const outUsd = solver.quotes.reduce((s, q) => s + q.amountOutUsd, 0);
  const rows: AllocationRow[] = [
    {
      chain: cfg.spotChainLabel,
      venue: "NEAR Intents (1Click)",
      asset: cfg.spotSymbol,
      amount: spotQ.amountOutFormatted,
      usd: spotQ.amountOutUsd,
      deltaUsd: spotQ.amountOutUsd,
      role: "Spot long",
    },
  ];
  if (marginQ) {
    rows.push({
      chain: "Arbitrum",
      venue: "NEAR Intents -> Hyperliquid bridge",
      asset: "USDC",
      amount: marginQ.amountOutFormatted,
      usd: marginQ.amountOutUsd,
      deltaUsd: 0,
      role: "Hedge margin",
    });
  }
  rows.push({
    chain: "Hyperliquid",
    venue: "Hyperliquid perps (via Chain Signatures)",
    asset: perp.asset,
    amount: `${usd(perp.notionalUsd)} notional`,
    usd: 0,
    deltaUsd: perp.deltaUsd,
    role: `Perp ${perp.side.toLowerCase()} hedge (1x)`,
  });
  rows.push({
    chain: "NEAR",
    venue: "NEAR Intents solvers",
    asset: "USDC",
    amount: `${usd(inUsd - outUsd)}`,
    usd: -(inUsd - outUsd),
    deltaUsd: 0,
    role: "Execution cost (fees + price impact)",
  });
  return rows;
}

export async function runSwarm(request: SwarmRequest, options: RunOptions = {}): Promise<SwarmRun> {
  const live = options.live ?? !isOfflineEnv();
  const started = new Date();
  const t0 = performance.now();
  const runId = sha256Hex(`${started.toISOString()}:${Math.random()}`).slice(0, 12);
  const audit = new AuditTrail();
  const steps: AgentStep[] = [];
  audit.record("orchestrator", "RUN_STARTED", `${request.mode} | ${PAIRS[request.pair].label} | ${usd(request.treasuryUsd)} | ${request.sliceCount} slices | live=${live}`, request);

  // ---- Market data ----------------------------------------------------------
  const [tokens, funding] = live
    ? await Promise.all([fetchOneClickTokens(), fetchFundingFeed()])
    : [
        {
          live: false,
          source: "offline-mode-snapshot",
          tokens: ONECLICK_TOKEN_SNAPSHOT,
          count: ONECLICK_TOKEN_SNAPSHOT.length,
          chains: [...new Set(ONECLICK_TOKEN_SNAPSHOT.map((t) => t.blockchain))],
          fetchedAt: new Date().toISOString(),
        } satisfies OneClickTokenFeed,
        { live: false, source: "offline-mode-snapshot", markets: FUNDING_SNAPSHOT, fetchedAt: new Date().toISOString() } satisfies FundingFeed,
      ];
  audit.record("orchestrator", "MARKET_DATA_LOADED", `1Click tokens: ${tokens.count} (${tokens.live ? "live" : tokens.source}); funding: ${funding.live ? "live Hyperliquid" : funding.source}`, {
    tokens: tokens.count,
    funding: funding.markets,
  });

  // ---- Agent 1: Scanner -----------------------------------------------------
  const scan = await timed(() => runScannerAgent({ pair: request.pair, treasuryUsd: request.treasuryUsd, tokens, funding }));
  const scanner = scan.value;
  steps.push({
    agent: "scanner",
    title: "Opportunity & Funding Scanner",
    status: "completed",
    startedAt: scan.startedAt,
    durationMs: scan.durationMs,
    summary: `${scanner.selected.asset}-PERP funding ${scanner.selected.fundingAprPct}% APR -> proposed 50/50 spot-long / perp-short plan (${scanner.expectedTreasuryAprPct}% APR on treasury)`,
  });
  audit.record("scanner", "PLAN_PROPOSED", `plan ${scanner.plan.planId}`, scanner.plan);

  let plan = scanner.plan;
  let injectedPlan: RebalancePlan | null = null;
  if (request.mode === "rogue") {
    injectedPlan = buildRogueDirectionalPlan(request.pair, request.treasuryUsd);
    plan = injectedPlan;
    audit.record("orchestrator", "ROGUE_PLAN_INJECTED", "hallucinated unhedged 10x long replaces the scanner plan", injectedPlan);
  }

  // ---- Agent 2: Confidential solver ----------------------------------------
  const guardianId = getGuardianIdentity();
  const signer = createEphemeralSigner();
  const sliceCount = request.mode === "rogue" ? 1 : request.sliceCount;
  const solve = await timed(() =>
    runSolverAgent({
      plan,
      sliceCount,
      tokens,
      signer,
      guardianBoxPublicKey: guardianId.boxPublicKeyHex,
      live,
      slippageToleranceBps: request.mode === "rogue" ? 300 : 25,
    }),
  );
  const solver = solve.value;
  steps.push({
    agent: "solver",
    title: "Confidential TEE Solver",
    status: "completed",
    startedAt: solve.startedAt,
    durationMs: solve.durationMs,
    summary: `${solver.envelope.sliceCount} encrypted slices, ${solver.quotes.map((q) => `${q.legId} via ${q.source}`).join(", ")}; NEP-413 intent signed by ${solver.signer.accountId.slice(0, 10)}…`,
  });
  audit.record("solver", "QUOTES_RECEIVED", solver.quotes.map((q) => `${q.legId}: ${q.source}, impact ${q.priceImpactBps} bps`).join("; "), solver.quotes);
  audit.record("solver", "ENVELOPE_SEALED", `envelope ${solver.envelope.envelopeId} (${solver.envelope.sliceCount} slices)`, solver.envelope);
  audit.record("solver", "INTENT_SIGNED", `NEP-413 payload hash ${solver.intent.payloadHashHex.slice(0, 16)}…`, solver.intent.signed);
  audit.record("solver", "ATTESTATION_ISSUED", `measurement ${solver.attestation.report.measurement.slice(0, 16)}…`, solver.attestation);

  // ---- Agent 3: Risk guard --------------------------------------------------
  const guard = await timed(() =>
    runGuardianAgent({ runId, solver, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex] }),
  );
  const guardian = guard.value;
  const approved = guardian.decision === "APPROVED";
  steps.push({
    agent: "guardian",
    title: "Delta Risk Guard",
    status: approved ? "approved" : "rejected",
    startedAt: guard.startedAt,
    durationMs: guard.durationMs,
    summary: approved
      ? `All ${guardian.checks.length} invariants hold (net delta ${(guardian.metrics.netDeltaRatio * 100).toFixed(2)}%, leverage ${guardian.metrics.leverage.toFixed(2)}x)`
      : `REJECTED: ${guardian.violations.join(", ")}`,
  });
  audit.record("guardian", approved ? "INTENT_APPROVED" : "INTENT_REJECTED", `decision hash ${guardian.decisionHash.slice(0, 16)}…`, guardian.decisionRecord);

  // ---- Independent on-chain policy check (deployed testnet Risk Guard) -------
  // Runs the deployed contract's own check_rebalance logic on the guardian's metrics.
  const onchainCheckPromise: Promise<OnchainPolicyCheck | null> = live
    ? checkRebalanceOnchain(toOnchainMetrics(guardian.metrics))
    : Promise.resolve(null);

  // ---- Settlement (dry run) -------------------------------------------------
  let mpcAccount: DerivedMpcAccount | null = null;
  const st = await timed(async (): Promise<Settlement> => {
    if (!approved) {
      return {
        status: "BLOCKED_BY_GUARD",
        simulation: null,
        allocation: buildAllocation(solver, false, request.treasuryUsd),
        notes: [
          "The signed intent was never sent to intents.near.",
          "No Chain Signatures request was created for the hedge leg.",
          `Violations: ${guardian.violations.join(", ")}`,
        ],
      };
    }
    if (!live) {
      return {
        status: "SKIPPED_OFFLINE",
        simulation: null,
        allocation: buildAllocation(solver, true, request.treasuryUsd),
        notes: ["Offline mode: intents.near simulation and MPC key derivation were skipped."],
      };
    }
    const [simulation, derived] = await Promise.all([
      simulateIntents([solver.intent.signed]),
      getMpcDerivedAccount(HEDGE_DERIVATION_PATH, GUARDIAN_NEAR_ACCOUNT),
    ]);
    mpcAccount = derived;
    const sigOk = simulation.status === "EXECUTED" || simulation.status === "SIGNATURE_ACCEPTED_UNFUNDED";
    return {
      status: sigOk ? "DRY_RUN_SETTLED" : simulation.status === "UNREACHABLE" ? "SKIPPED_OFFLINE" : "VERIFIER_REJECTED",
      simulation,
      allocation: buildAllocation(solver, true, request.treasuryUsd),
      notes: [
        simulation.status === "SIGNATURE_ACCEPTED_UNFUNDED"
          ? "intents.near (mainnet) accepted the NEP-413 signature and stopped at the balance check, as expected for an unfunded demo account."
          : simulation.status === "EXECUTED"
            ? "intents.near (mainnet) executed the intent in simulation."
            : `intents.near simulation status: ${simulation.status}${simulation.panicMessage ? ` (${simulation.panicMessage})` : ""}`,
        derived.live
          ? `Hedge account controlled via Chain Signatures: ${derived.evmAddress} (derived live by ${HEDGE_DERIVATION_PATH}).`
          : `MPC derivation unavailable: ${derived.error}`,
        "This run's MPC sign request is prepared, not broadcast. The same request was executed once on testnet; see the On-chain proof tab.",
      ],
    };
  });
  const settlement = st.value;
  const onchainCheck = await onchainCheckPromise;
  if (onchainCheck) {
    const agrees = onchainCheck.live ? onchainCheck.approved === approved : null;
    audit.record(
      "guardian",
      "ONCHAIN_POLICY_CHECK",
      onchainCheck.live
        ? `${onchainCheck.contractId}.check_rebalance -> ${onchainCheck.approved ? "APPROVED" : `REJECTED (${onchainCheck.violations?.join("; ")})`}; agrees with off-chain guard: ${agrees}`
        : `on-chain check unavailable: ${onchainCheck.error}`,
      onchainCheck,
    );
  }
  steps.push({
    agent: "settlement",
    title: "Dry-run Settlement",
    status: settlement.status === "DRY_RUN_SETTLED" ? "completed" : settlement.status === "BLOCKED_BY_GUARD" ? "blocked" : "skipped",
    startedAt: st.startedAt,
    durationMs: st.durationMs,
    summary: settlement.notes[0],
  });
  audit.record("settlement", settlement.status, settlement.notes.join(" "), { simulation: settlement.simulation, mpcAccount });

  const finished = new Date();
  audit.record("orchestrator", "RUN_FINISHED", `decision ${guardian.decision}`, { decisionHash: guardian.decisionHash });
  const { tokens: _t, ...tokenMeta } = tokens;
  const { markets: _m, ...fundingMeta } = funding;
  return {
    runId,
    mode: request.mode,
    request: { ...request, sliceCount },
    live,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.round(performance.now() - t0),
    sources: { tokens: tokenMeta, funding: fundingMeta },
    scanner,
    injectedPlan,
    solver,
    guardian,
    onchainCheck,
    mpcAccount,
    settlement,
    steps,
    audit: { events: audit.events, rootHash: audit.rootHash },
  };
}
