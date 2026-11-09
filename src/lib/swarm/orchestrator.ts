/**
 * Swarm orchestrator.
 *
 *   Agent 1 (Scanner) probes live costs for every candidate, ranks the
 *   opportunity matrix, sizes the plan and proposes a slice count.
 *   Agent 2 (Solver) quotes, slices, commits the order and signs the intent.
 *   If its measured slice slippage is above Agent 1's target, the two agents
 *   negotiate (SOLVER_SLIPPAGE_FEEDBACK -> SCANNER_RESLICE_ADJUSTMENT) and
 *   re-solve, up to 3 times, before anything reaches Agent 3.
 *   Agent 3 (Risk Guard) checks 8 invariants; the deployed testnet contract
 *   independently recomputes the same order (`check_order_params`).
 *
 * Settlement is a dry run: `intents.near` executes the signed intent through
 * `simulate_intents`, and the guard-gated MPC request is prepared but not
 * broadcast. The one-time on-chain proof transactions live in testnet-proof.json.
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
import {
  buildRogueDirectionalPlan,
  probeEntryCosts,
  proposeReslice,
  runScannerAgent,
  SCANNER_ASSUMPTIONS,
  type CostProbe,
  type ScannerResult,
} from "../agents/scannerAgent";
import { getSolverEnclave, runSolverAgent, type SolverResult } from "../agents/solverAgent";
import {
  GUARDIAN_NEAR_ACCOUNT,
  HEDGE_DERIVATION_PATH,
  RISK_POLICY,
  getGuardianIdentity,
  runGuardianAgent,
  type GuardianDecision,
} from "../agents/guardianAgent";
import { hashObject, sha256Hex } from "../crypto/encoding";
import { checkOrderOnchain, getOnchainLastNonce, type OnchainOrderCheck } from "../near/riskGuardContract";
import { LIMITS, PAIRS, type PairId, type RebalancePlan, type SwarmRequest } from "./types";

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
  status: "DRY_RUN_SETTLED" | "BLOCKED_BY_GUARD" | "SKIPPED_OFFLINE" | "VERIFIER_REJECTED" | "NO_TRADE";
  simulation: IntentSimulation | null;
  allocation: AllocationRow[];
  notes: string[];
}

export interface NegotiationRound {
  round: number;
  sliceCount: number;
  observedSlippageBps: number;
  targetBps: number;
  ceilingBps: number;
  action: "ACCEPTED" | "RESLICE_REQUESTED" | "AT_SLICE_LIMIT" | "NOT_NEGOTIATED";
  nextSliceCount?: number;
  quoteSources: string[];
  note: string;
}

export interface SwarmRun {
  runId: string;
  mode: SwarmRequest["mode"];
  request: SwarmRequest;
  /** What the swarm actually ran after Agent 1's choices and the negotiation. */
  resolved: { pair: PairId; sliceCount: number; initialSliceCount: number; hedgeLeverage: number };
  costProbes: Record<PairId, CostProbe>;
  negotiation: NegotiationRound[];
  /**
   * Agent 1's economic recommendation. When NO_TRADE and not overridden, the risk
   * pipeline still runs (so it can be inspected) but no settlement or sign request
   * is prepared. Attack modes always run: they are labelled simulations.
   */
  economics: { recommendation: "TRADE" | "NO_TRADE"; reason: string; overridden: boolean; settlementWithheld: boolean };
  live: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sources: { tokens: Omit<OneClickTokenFeed, "tokens">; funding: Omit<FundingFeed, "markets"> };
  scanner: ScannerResult;
  injectedPlan: RebalancePlan | null;
  solver: SolverResult;
  guardian: GuardianDecision;
  /** The deployed contract's own evaluation of this run's raw order (null offline). */
  onchainCheck: OnchainOrderCheck | null;
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

function buildAllocation(solver: SolverResult, approved: boolean, treasuryUsd: number, hedgeLeverage: number): AllocationRow[] {
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
    role: `Perp ${perp.side.toLowerCase()} hedge (${hedgeLeverage}x margin)`,
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

const MAX_RESLICE_ROUNDS = 3;

export async function runSwarm(request: SwarmRequest, options: RunOptions = {}): Promise<SwarmRun> {
  const live = options.live ?? !isOfflineEnv();
  const started = new Date();
  const t0 = performance.now();
  const runId = sha256Hex(`${started.toISOString()}:${Math.random()}`).slice(0, 12);
  const audit = new AuditTrail();
  const steps: AgentStep[] = [];
  audit.record(
    "orchestrator",
    "RUN_STARTED",
    `${request.mode} | pair ${request.pair} | ${usd(request.treasuryUsd)} | slices ${request.sliceCount} | live=${live}`,
    request,
  );
  const signer = createEphemeralSigner();
  const lastNoncePromise = live ? getOnchainLastNonce() : Promise.resolve(0);

  // ---- Market data + live cost probes ---------------------------------------
  const [tokens, funding, costProbes] = live
    ? await Promise.all([fetchOneClickTokens(), fetchFundingFeed(), probeEntryCosts(true, signer.accountId)])
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
        await probeEntryCosts(false, signer.accountId),
      ];
  audit.record(
    "orchestrator",
    "MARKET_DATA_LOADED",
    `1Click tokens: ${tokens.count} (${tokens.live ? "live" : tokens.source}); funding: ${funding.live ? "live Hyperliquid" : funding.source}; cost probes: ${Object.values(costProbes)
      .map((c) => `${c.asset} ${c.entryCostBps}bps/${c.source}`)
      .join(", ")}`,
    { tokens: tokens.count, funding: funding.markets, costProbes },
  );

  // ---- Agent 1: autonomous scanner -----------------------------------------
  const scan = await timed(() => runScannerAgent({ pair: request.pair, treasuryUsd: request.treasuryUsd, tokens, funding, costs: costProbes, requireLiveData: live }));
  const scanner = scan.value;
  const sel = scanner.selected;
  steps.push({
    agent: "scanner",
    title: "Autonomous Opportunity Scanner",
    status: "completed",
    startedAt: scan.startedAt,
    durationMs: scan.durationMs,
    summary: `Ranked ${scanner.opportunityMatrix.length} markets; ${scanner.selection.mode === "auto" ? "chose" : "user chose"} ${sel.asset} (${sel.netCarryAprPct}% net carry, ${sel.hedgeLeverage}x hedge, ${scanner.recommendedSlices} slices)`,
  });
  audit.record(
    "scanner",
    "OPPORTUNITIES_RANKED",
    scanner.opportunityMatrix.map((o) => `#${o.rank} ${o.asset} net ${o.netCarryAprPct}%`).join(" | ") + ` -> ${scanner.selection.reason}`,
    scanner.opportunityMatrix,
  );
  audit.record("scanner", "PLAN_PROPOSED", `plan ${scanner.plan.planId}; ${scanner.sliceRationale}`, scanner.plan);
  const noTrade = scanner.recommendation === "NO_TRADE" && request.mode === "rebalance";
  const economics = {
    recommendation: scanner.recommendation,
    reason: scanner.recommendationReason,
    overridden: noTrade && request.simulateUnprofitable === true,
    settlementWithheld: noTrade && request.simulateUnprofitable !== true,
  };
  audit.record(
    "scanner",
    scanner.recommendation === "TRADE" ? "TRADE_RECOMMENDED" : "NO_TRADE_RECOMMENDED",
    `${scanner.recommendationReason}${economics.overridden ? " Demo override: settlement simulated anyway." : ""}`,
    economics,
  );

  let plan = scanner.plan;
  let injectedPlan: RebalancePlan | null = null;
  if (request.mode === "rogue") {
    injectedPlan = buildRogueDirectionalPlan(sel.asset, request.treasuryUsd);
    plan = injectedPlan;
    audit.record("orchestrator", "ROGUE_PLAN_INJECTED", "hallucinated unhedged 10x long replaces the scanner plan", injectedPlan);
  }
  if (request.mode === "spoofed_metrics") {
    audit.record("orchestrator", "SOLVER_COMPROMISED", "Agent 2 will report hedged legs but hide a 10x order in its slices and MPC payload", null);
  }

  // ---- Agent 2 + negotiation with Agent 1 -----------------------------------
  const guardianId = getGuardianIdentity();
  const initialSliceCount = request.mode === "rogue" ? 1 : request.sliceCount === "auto" ? scanner.recommendedSlices : request.sliceCount;
  const negotiation: NegotiationRound[] = [];
  const target = SCANNER_ASSUMPTIONS.targetSliceImpactBps;
  let slices = initialSliceCount;
  const solve = await timed(async () => {
    let result: SolverResult | null = null;
    for (let round = 1; round <= MAX_RESLICE_ROUNDS + 1; round++) {
      result = await runSolverAgent({
        plan,
        sliceCount: slices,
        tokens,
        signer,
        guardianBoxPublicKey: guardianId.boxPublicKeyHex,
        live,
        slippageToleranceBps: request.mode === "rogue" ? 300 : 25,
        compromise: request.mode === "spoofed_metrics" ? "spoofed_metrics" : undefined,
      });
      const observed = result.maxPriceImpactBps;
      const base = { round, sliceCount: slices, observedSlippageBps: observed, targetBps: target, ceilingBps: RISK_POLICY.maxSlippageBps, quoteSources: result.quotes.map((q) => q.source) };
      if (request.mode === "rogue") {
        negotiation.push({ ...base, action: "NOT_NEGOTIATED", note: "Injected plan bypasses Agent 1, so there is no negotiation." });
        break;
      }
      audit.record("solver", "SOLVER_SLIPPAGE_FEEDBACK", `round ${round}: ${slices} slices -> ${observed} bps slice slippage (target ${target}, ceiling ${RISK_POLICY.maxSlippageBps})`, base);
      if (observed <= target) {
        negotiation.push({ ...base, action: "ACCEPTED", note: `${observed} bps <= ${target} bps target: Agent 1 accepts ${slices} slices.` });
        break;
      }
      if (slices >= LIMITS.sliceMax || round > MAX_RESLICE_ROUNDS) {
        negotiation.push({ ...base, action: "AT_SLICE_LIMIT", note: `Still ${observed} bps at ${slices} slices; sent to Agent 3 as-is.` });
        break;
      }
      const next = proposeReslice(slices, observed);
      negotiation.push({ ...base, action: "RESLICE_REQUESTED", nextSliceCount: next, note: `Impact ~ sqrt(slice): ${slices} x (${observed}/${target})^2 -> ${next} slices.` });
      audit.record("scanner", "SCANNER_RESLICE_ADJUSTMENT", `round ${round}: ${slices} -> ${next} slices to cut slice slippage below ${target} bps`, { from: slices, to: next, observed, target });
      slices = next;
    }
    return result!;
  });
  const solver = solve.value;
  const rounds = negotiation.length;
  steps.push({
    agent: "solver",
    title: "Confidential TEE Solver",
    status: "completed",
    startedAt: solve.startedAt,
    durationMs: solve.durationMs,
    summary: `${rounds} negotiation round${rounds === 1 ? "" : "s"} -> ${solver.envelope.sliceCount} encrypted slices at ${solver.maxPriceImpactBps} bps; order nonce ${solver.order.nonce}; NEP-413 intent signed by ${solver.signer.accountId.slice(0, 10)}…`,
  });
  audit.record("solver", "QUOTES_RECEIVED", solver.quotes.map((q) => `${q.legId}: ${q.source}, impact ${q.priceImpactBps} bps`).join("; "), solver.quotes);
  audit.record("solver", "ENVELOPE_SEALED", `envelope ${solver.envelope.envelopeId} (${solver.envelope.sliceCount} slices)`, solver.envelope);
  audit.record("solver", "INTENT_SIGNED", `NEP-413 payload hash ${solver.intent.payloadHashHex.slice(0, 16)}…`, solver.intent.signed);
  audit.record("solver", "ORDER_COMMITTED", `keccak256(order) ${solver.hedgeOrderPayloadHex.slice(0, 16)}… nonce ${solver.order.nonce}`, { order: solver.order, payload: solver.hedgeOrderPayloadHex });
  audit.record("solver", "ATTESTATION_ISSUED", `measurement ${solver.attestation.report.measurement.slice(0, 16)}…`, solver.attestation);

  // ---- Agent 3: risk guard ---------------------------------------------------
  // null in live mode = the read failed; the guard then fails invariant 8 (fail closed).
  const lastAcceptedNonce = await lastNoncePromise;
  const guard = await timed(() =>
    runGuardianAgent({
      runId,
      solver,
      trustedEnclaveKeys: [getSolverEnclave().publicKeyHex],
      lastAcceptedNonce,
      expected: { treasuryUsd: request.treasuryUsd, pair: sel.asset },
      economics: { recommendation: economics.recommendation, withhold: economics.settlementWithheld },
    }),
  );
  const guardian = guard.value;
  // "Withheld" only describes runs the guard approved; a rejected run is simply blocked.
  economics.settlementWithheld = economics.settlementWithheld && guardian.decision === "APPROVED";
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
  audit.record(
    "guardian",
    !approved ? "INTENT_REJECTED" : economics.settlementWithheld ? "RISK_APPROVED_SETTLEMENT_WITHHELD" : "INTENT_APPROVED",
    `decision hash ${guardian.decisionHash.slice(0, 16)}…${economics.settlementWithheld ? " (NO_TRADE: no sign request)" : ""}`,
    guardian.decisionRecord,
  );

  // Independent check by the deployed contract (free view call) on the solver's raw order.
  const onchainCheckPromise: Promise<OnchainOrderCheck | null> = live
    ? checkOrderOnchain(solver.order, solver.hedgeOrderPayloadHex)
    : Promise.resolve(null);

  // ---- Settlement (dry run) -------------------------------------------------
  let mpcAccount: DerivedMpcAccount | null = null;
  const st = await timed(async (): Promise<Settlement> => {
    if (!approved) {
      return {
        status: "BLOCKED_BY_GUARD",
        simulation: null,
        allocation: buildAllocation(solver, false, request.treasuryUsd, sel.hedgeLeverage),
        notes: [
          "The signed intent was never sent to intents.near.",
          "No record_rebalance call was prepared, so the contract never asks the MPC network to sign.",
          `Violations: ${guardian.violations.join(", ")}`,
        ],
      };
    }
    if (economics.settlementWithheld) {
      return {
        status: "NO_TRADE",
        simulation: null,
        allocation: buildAllocation(solver, false, request.treasuryUsd, sel.hedgeLeverage),
        notes: [
          "Agent 1 recommends NO_TRADE, so ZeroDelta stays in USDC: no intent was sent and no record_rebalance call was prepared.",
          scanner.recommendationReason,
          "The solver and Risk Guard still ran so the pipeline can be inspected. Tick the demo override to simulate settlement anyway.",
        ],
      };
    }
    if (!live) {
      return {
        status: "SKIPPED_OFFLINE",
        simulation: null,
        allocation: buildAllocation(solver, true, request.treasuryUsd, sel.hedgeLeverage),
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
      allocation: buildAllocation(solver, true, request.treasuryUsd, sel.hedgeLeverage),
      notes: [
        simulation.status === "SIGNATURE_ACCEPTED_UNFUNDED"
          ? "intents.near (mainnet) accepted the NEP-413 signature and stopped at the balance check, as expected for an unfunded demo account."
          : simulation.status === "EXECUTED"
            ? "intents.near (mainnet) executed the intent in simulation."
            : `intents.near simulation status: ${simulation.status}${simulation.panicMessage ? ` (${simulation.panicMessage})` : ""}`,
        derived.live
          ? `Hedge key belongs to the Risk Guard contract ${GUARDIAN_NEAR_ACCOUNT}: ${derived.evmAddress} (path ${HEDGE_DERIVATION_PATH}). Only the contract can request signatures for it.`
          : `MPC derivation unavailable: ${derived.error}`,
        "This run's record_rebalance call is prepared, not broadcast. The same flow ran once on testnet; see the On-chain proof tab.",
      ],
    };
  });
  const settlement = st.value;
  const onchainCheck = await onchainCheckPromise;
  if (onchainCheck) {
    const agrees = onchainCheck.live ? onchainCheck.approved === approved : null;
    audit.record(
      "guardian",
      "ONCHAIN_ORDER_CHECK",
      onchainCheck.live
        ? `${onchainCheck.contractId}.check_order_params -> ${onchainCheck.approved ? "APPROVED" : `REJECTED (${onchainCheck.violations?.join("; ")})`}; contract-computed delta ${onchainCheck.netDeltaBps} bps, leverage ${onchainCheck.leverageX100}; agrees with Agent 3: ${agrees}`
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
    request,
    resolved: { pair: sel.asset, sliceCount: solver.sliceCount, initialSliceCount, hedgeLeverage: sel.hedgeLeverage },
    costProbes,
    negotiation,
    economics,
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
