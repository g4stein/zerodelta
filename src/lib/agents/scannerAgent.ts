/**
 * Agent 1 — Autonomous Opportunity & Funding Scanner.
 *
 * Every run it evaluates ALL candidate carry trades (NEAR, SOL, ETH, BTC), not
 * just the one a user picked:
 *
 *   gross carry APR     live Hyperliquid funding paid to shorts, annualised
 *   round-trip cost     2 × live 1Click entry cost ($100 reference quote: spread + fees)
 *                       + 2 × perp taker fee
 *   net carry APR       gross − round-trip cost amortised over the holding horizon
 *   breakeven days      days of funding needed to pay back the round trip
 *
 * It ranks the matrix, picks the best eligible market (or records that the user
 * overrode it), sizes the position (hedge leverage from the live 24h move), and
 * recommends a TWAP slice count from live liquidity: a $10k probe quote gives the
 * price-impact curve, and slices are sized so each one stays under 40% of the
 * guard's slippage ceiling.
 */
import { fetchOneClickQuote, type OneClickTokenFeed } from "../near/rpcClient";
import { fundingApr, type FundingFeed, type PerpMarket } from "../market/fundingFeed";
import { hashObject } from "../crypto/encoding";
import {
  LIMITS,
  PAIRS,
  PAIR_IDS,
  USDC_ARB_ASSET,
  USDC_DECIMALS,
  USDC_NEAR_ASSET,
  type Leg,
  type PairId,
  type PairSelection,
  type RebalancePlan,
} from "../swarm/types";

export const SCANNER_ASSUMPTIONS = {
  holdingDays: 30,
  /** Hyperliquid base-tier taker fee (0.045%). */
  perpTakerFeeBps: 4.5,
  /** Each slice should stay under this much size-driven slippage (40% of the 25 bps ceiling). */
  targetSliceImpactBps: 10,
  /** A slice should not exceed this share of the perp's 24h volume. */
  maxSliceShareOfPerpVolume: 0.0005,
  /** Hedge leverage is capped so liquidation sits ≥ this many 24h moves away. */
  liquidationBufferMoves: 10,
  maxHedgeLeverage: 2,
  probeQuoteUsd: 10_000,
  referenceQuoteUsd: 100,
} as const;

/** Offline model: fixed spread plus square-root impact. */
const LOCAL_ENTRY_COST_BPS = 15;
const localImpactAt = (usd: number) => 10 * Math.sqrt(usd / 100_000);

export interface CostProbe {
  asset: PairId;
  source: "1click-live" | "local-model";
  /** All-in cost of a $100 USDC -> spot swap (spread + fees), bps. */
  entryCostBps: number;
  /** Extra slippage of a $10k slice vs the $100 reference, bps. */
  impactBpsAt10k: number;
  error?: string;
}

export interface Opportunity {
  rank: number;
  asset: PairId;
  pairLabel: string;
  spotChain: string;
  routableViaIntents: boolean;
  spotPriceUsd: number | null;
  perpMarkPx: number;
  basisBps: number | null;
  fundingHourlyPct: number;
  grossCarryAprPct: number;
  entryCostBps: number;
  estimatedRoundTripCostBps: number;
  amortizedCostAprPct: number;
  netCarryAprPct: number;
  breakevenDays: number | null;
  hedgeLeverage: number;
  spotFraction: number;
  treasuryNetAprPct: number;
  recommendedSlices: number;
  maxSliceUsd: number;
  costSource: CostProbe["source"];
  eligible: boolean;
  verdict: string;
}

export interface ScannerResult {
  /**
   * TRADE: the chosen market has positive estimated net carry on live data.
   * NO_TRADE: no candidate (or the manually chosen one) earns positive net carry,
   * or live data is missing. The plan is still built so the pipeline can be inspected,
   * but the orchestrator withholds settlement unless a demo override is set.
   */
  recommendation: "TRADE" | "NO_TRADE";
  recommendationReason: string;
  opportunityMatrix: Opportunity[];
  selected: Opportunity;
  selection: { mode: "auto" | "manual"; requested: PairSelection; chosen: PairId; bestByNetCarry: PairId; reason: string };
  plan: RebalancePlan;
  recommendedSlices: number;
  sliceRationale: string;
  expectedTreasuryAprPct: number;
  assumptions: typeof SCANNER_ASSUMPTIONS;
  sources: { tokens: { live: boolean; source: string; count: number }; funding: { live: boolean; source: string }; costs: CostProbe["source"][] };
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

function spotToken(tokens: OneClickTokenFeed, asset: PairId) {
  const cfg = PAIRS[asset];
  return tokens.tokens.find((t) => t.assetId === cfg.spotAssetId) ?? tokens.tokens.find((t) => t.symbol === cfg.spotSymbol && t.blockchain === cfg.spotChain);
}

/** Measures live entry cost and price impact for every candidate (2 dry 1Click quotes each). */
export async function probeEntryCosts(live: boolean, recipient: string): Promise<Record<PairId, CostProbe>> {
  const local = (asset: PairId, error?: string): CostProbe => ({
    asset,
    source: "local-model",
    entryCostBps: LOCAL_ENTRY_COST_BPS,
    impactBpsAt10k: round(localImpactAt(SCANNER_ASSUMPTIONS.probeQuoteUsd), 2),
    error,
  });
  if (!live) return Object.fromEntries(PAIR_IDS.map((a) => [a, local(a)])) as Record<PairId, CostProbe>;
  const quote = (asset: PairId, usd: number) =>
    fetchOneClickQuote({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 50,
      originAsset: USDC_NEAR_ASSET,
      depositType: "INTENTS",
      destinationAsset: PAIRS[asset].spotAssetId,
      amount: String(BigInt(usd) * 10n ** BigInt(USDC_DECIMALS)),
      refundTo: recipient,
      refundType: "INTENTS",
      recipient,
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
  const results = await Promise.all(
    PAIR_IDS.map(async (asset): Promise<CostProbe> => {
      const [ref, probe] = await Promise.all([quote(asset, SCANNER_ASSUMPTIONS.referenceQuoteUsd), quote(asset, SCANNER_ASSUMPTIONS.probeQuoteUsd)]);
      if (!ref.quote || !probe.quote) return local(asset, ref.error ?? probe.error);
      const inUsd = Number(ref.quote.amountInUsd);
      const outUsd = Number(ref.quote.amountOutUsd);
      const refRate = Number(ref.quote.amountOut) / SCANNER_ASSUMPTIONS.referenceQuoteUsd;
      const probeRate = probe.quote ? Number(probe.quote.amountOut) / SCANNER_ASSUMPTIONS.probeQuoteUsd : refRate;
      return {
        asset,
        source: "1click-live",
        entryCostBps: round(Math.max(0, ((inUsd - outUsd) / inUsd) * 10_000), 2),
        impactBpsAt10k: round(Math.max(0, ((refRate - probeRate) / refRate) * 10_000), 2),
        error: probe.quote ? undefined : `probe quote unavailable: ${probe.error}`,
      };
    }),
  );
  return Object.fromEntries(results.map((r) => [r.asset, r])) as Record<PairId, CostProbe>;
}

/** Hedge leverage so the short's liquidation is ≥ N daily moves away (1x … 2x). */
export function chooseHedgeLeverage(dayMoveAbs: number): number {
  const { liquidationBufferMoves, maxHedgeLeverage } = SCANNER_ASSUMPTIONS;
  const raw = 1 / (liquidationBufferMoves * Math.max(dayMoveAbs, 0.005));
  return round(Math.min(maxHedgeLeverage, Math.max(1, raw)), 2);
}

/** Largest slice that stays under the target impact and the perp-volume share. */
export function maxSliceUsd(impactBpsAt10k: number, perpDayVolumeUsd: number): number {
  const { targetSliceImpactBps, probeQuoteUsd, maxSliceShareOfPerpVolume } = SCANNER_ASSUMPTIONS;
  // impact(x) ≈ k·√x  =>  x_max = (target / k)²
  const k = impactBpsAt10k / Math.sqrt(probeQuoteUsd);
  const byImpact = k > 0 ? (targetSliceImpactBps / k) ** 2 : Number.POSITIVE_INFINITY;
  const byVolume = perpDayVolumeUsd > 0 ? perpDayVolumeUsd * maxSliceShareOfPerpVolume : Number.POSITIVE_INFINITY;
  const cap = Math.min(byImpact, byVolume);
  return Number.isFinite(cap) ? Math.max(500, Math.round(cap)) : 1_000_000;
}

export function recommendSlices(spotNotionalUsd: number, sliceCapUsd: number): number {
  return Math.min(LIMITS.sliceMax, Math.max(LIMITS.sliceMin, Math.ceil(spotNotionalUsd / sliceCapUsd)));
}

export function evaluateOpportunity(
  asset: PairId,
  treasuryUsd: number,
  perp: PerpMarket,
  cost: CostProbe,
  tokens: OneClickTokenFeed,
): Omit<Opportunity, "rank"> {
  const cfg = PAIRS[asset];
  const { holdingDays, perpTakerFeeBps } = SCANNER_ASSUMPTIONS;
  const spot = spotToken(tokens, asset);
  const grossCarryAprPct = round(fundingApr(perp.fundingHourly) * 100, 3);
  const estimatedRoundTripCostBps = round(2 * cost.entryCostBps + 2 * perpTakerFeeBps, 2);
  const amortizedCostAprPct = round((estimatedRoundTripCostBps / 100) * (365 / holdingDays), 3);
  const netCarryAprPct = round(grossCarryAprPct - amortizedCostAprPct, 3);
  const breakevenDays = grossCarryAprPct > 0 ? round((estimatedRoundTripCostBps / 100 / grossCarryAprPct) * 365, 1) : null;
  const hedgeLeverage = chooseHedgeLeverage(perp.dayMoveAbs);
  const spotFraction = round(hedgeLeverage / (1 + hedgeLeverage), 4);
  const sliceCap = maxSliceUsd(cost.impactBpsAt10k, perp.dayVolumeUsd);
  const eligible = Boolean(spot) && grossCarryAprPct > 0 && netCarryAprPct > 0;
  const verdict = !spot
    ? "not routable through NEAR Intents"
    : grossCarryAprPct <= 0
      ? "funding is negative: shorts pay"
      : netCarryAprPct <= 0
        ? `costs (${estimatedRoundTripCostBps} bps round trip) exceed ${holdingDays}-day carry`
        : `earns ${netCarryAprPct}% net; breakeven in ${breakevenDays} days`;
  return {
    asset,
    pairLabel: cfg.label,
    spotChain: cfg.spotChainLabel,
    routableViaIntents: Boolean(spot),
    spotPriceUsd: spot?.price ?? null,
    perpMarkPx: perp.markPx,
    basisBps: spot?.price ? round(((perp.markPx - spot.price) / spot.price) * 10_000, 2) : null,
    fundingHourlyPct: round(perp.fundingHourly * 100, 6),
    grossCarryAprPct,
    entryCostBps: cost.entryCostBps,
    estimatedRoundTripCostBps,
    amortizedCostAprPct,
    netCarryAprPct,
    breakevenDays,
    hedgeLeverage,
    spotFraction,
    treasuryNetAprPct: round(netCarryAprPct * spotFraction, 3),
    recommendedSlices: recommendSlices(treasuryUsd * spotFraction, sliceCap),
    maxSliceUsd: sliceCap,
    costSource: cost.source,
    eligible,
    verdict,
  };
}

/** Builds the delta-neutral plan: spot long + perp short of equal notional, margin for the short. */
export function buildDeltaNeutralPlan(pair: PairId, treasuryUsd: number, opp: Pick<Opportunity, "spotFraction" | "hedgeLeverage" | "grossCarryAprPct" | "netCarryAprPct" | "fundingHourlyPct">): RebalancePlan {
  const cfg = PAIRS[pair];
  const spotUsd = round(treasuryUsd * opp.spotFraction, 2);
  const marginUsd = round(treasuryUsd - spotUsd, 2);
  const legs: Leg[] = [
    { id: "spot-long", kind: "SPOT", side: "LONG", venue: "NEAR Intents (1Click)", chain: cfg.spotChainLabel, asset: cfg.spotSymbol, assetId: cfg.spotAssetId, notionalUsd: spotUsd, deltaUsd: spotUsd },
    { id: "hedge-margin", kind: "MARGIN", side: "TRANSFER", venue: "NEAR Intents -> Hyperliquid", chain: "Arbitrum", asset: "USDC", assetId: USDC_ARB_ASSET, notionalUsd: marginUsd, deltaUsd: 0 },
    { id: "perp-short", kind: "PERP", side: "SHORT", venue: "Hyperliquid", chain: "Hyperliquid", asset: `${cfg.perpSymbol}-PERP`, notionalUsd: spotUsd, deltaUsd: -spotUsd },
  ];
  const createdAt = new Date().toISOString();
  const rationale = [
    `${cfg.perpSymbol}-PERP funding is ${opp.fundingHourlyPct}% per hour (${opp.grossCarryAprPct}% gross APR to shorts, ${opp.netCarryAprPct}% net of costs).`,
    `Hedge runs at ${opp.hedgeLeverage}x, so ${(opp.spotFraction * 100).toFixed(1)}% of treasury buys spot and the rest is margin for an equal-notional short.`,
    `Spot ${cfg.spotSymbol} is bought from USDC through NEAR Intents and held as ${cfg.spotAssetId}.`,
  ];
  const body = { pair, treasuryUsd, legs, createdAt };
  return { planId: hashObject(body).slice(0, 16), pair, treasuryUsd, legs, proposer: "scanner-agent", rationale, createdAt };
}

export function runScannerAgent(input: {
  pair: PairSelection;
  treasuryUsd: number;
  tokens: OneClickTokenFeed;
  funding: FundingFeed;
  costs: Record<PairId, CostProbe>;
  /** When true (live mode), a recommendation needs live funding and at least one live cost probe. */
  requireLiveData?: boolean;
}): ScannerResult {
  const evaluated = PAIR_IDS.flatMap((asset) => {
    const perp = input.funding.markets[PAIRS[asset].perpSymbol];
    return perp ? [evaluateOpportunity(asset, input.treasuryUsd, perp, input.costs[asset], input.tokens)] : [];
  });
  if (evaluated.length === 0) throw new Error("no funding data for any candidate");
  // Eligible first, then by net carry.
  const ranked = [...evaluated].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.netCarryAprPct - a.netCarryAprPct);
  const opportunityMatrix: Opportunity[] = ranked.map((o, i) => ({ ...o, rank: i + 1 }));
  const best = opportunityMatrix[0];
  const manual = input.pair !== "AUTO";
  const selected = manual ? opportunityMatrix.find((o) => o.asset === input.pair) : best;
  if (!selected) throw new Error(`no funding data for ${input.pair}`);
  const reason = manual
    ? selected.asset === best.asset
      ? `Manual choice ${selected.asset} is also the best net carry.`
      : `Manual override: ${selected.asset} (${selected.netCarryAprPct}% net) instead of ${best.asset} (${best.netCarryAprPct}% net).`
    : best.eligible
      ? `${best.asset} ranks #1 of ${opportunityMatrix.length}: ${best.netCarryAprPct}% net carry after ${best.estimatedRoundTripCostBps} bps round-trip costs.`
      : `No candidate has positive net carry right now; ${best.asset} is the least negative. A real treasury would stay in USDC; the plan is produced so the pipeline can be inspected.`;
  const plan = buildDeltaNeutralPlan(selected.asset, input.treasuryUsd, selected);
  // The chosen market itself must have live funding and a live 1Click cost probe.
  const liveDataOk = !input.requireLiveData || (input.funding.live && input.costs[selected.asset]?.source === "1click-live");
  const recommendation: ScannerResult["recommendation"] = selected.eligible && liveDataOk ? "TRADE" : "NO_TRADE";
  const recommendationReason = !liveDataOk
    ? `NO_TRADE: live funding or the live 1Click cost probe for ${selected.asset} is unavailable; ZeroDelta does not recommend trades on snapshot or modelled data.`
    : selected.eligible
      ? `TRADE: ${selected.asset} earns an estimated ${selected.netCarryAprPct}% net carry (${selected.treasuryNetAprPct}% on the whole treasury). Estimate, not a guarantee: funding changes hourly.`
      : `NO_TRADE: ${selected.asset} ${selected.verdict}. ${manual ? "The manual choice" : "No candidate"} has positive estimated net carry, so a real treasury would stay in USDC.`;
  const spotUsd = input.treasuryUsd * selected.spotFraction;
  return {
    recommendation,
    recommendationReason,
    opportunityMatrix,
    selected,
    selection: { mode: manual ? "manual" : "auto", requested: input.pair, chosen: selected.asset, bestByNetCarry: best.asset, reason },
    plan,
    recommendedSlices: selected.recommendedSlices,
    sliceRationale: `$${Math.round(spotUsd).toLocaleString("en-US")} spot / max $${selected.maxSliceUsd.toLocaleString("en-US")} per slice (live impact ${input.costs[selected.asset].impactBpsAt10k} bps at $10k, target <= ${SCANNER_ASSUMPTIONS.targetSliceImpactBps} bps) = ${selected.recommendedSlices} slices`,
    expectedTreasuryAprPct: selected.treasuryNetAprPct,
    assumptions: SCANNER_ASSUMPTIONS,
    sources: {
      tokens: { live: input.tokens.live, source: input.tokens.source, count: input.tokens.count },
      funding: { live: input.funding.live, source: input.funding.source },
      costs: [...new Set(Object.values(input.costs).map((c) => c.source))],
    },
  };
}

/**
 * Agent 1's response to Agent 2's slippage feedback: impact scales with √(slice size),
 * so hitting the target needs slices × (observed / target)².
 */
export function proposeReslice(currentSlices: number, observedImpactBps: number): number {
  const target = SCANNER_ASSUMPTIONS.targetSliceImpactBps;
  const next = Math.ceil(currentSlices * (observedImpactBps / target) ** 2);
  return Math.min(LIMITS.sliceMax, Math.max(currentSlices + 1, next));
}

/**
 * The "rogue AI" scenario: a hallucinating planner replaces the hedged plan with an
 * unhedged 10x directional long (100% of treasury in spot + a 9x perp LONG, no short).
 */
export function buildRogueDirectionalPlan(pair: PairId, treasuryUsd: number): RebalancePlan {
  const cfg = PAIRS[pair];
  const legs: Leg[] = [
    { id: "spot-long", kind: "SPOT", side: "LONG", venue: "NEAR Intents (1Click)", chain: cfg.spotChainLabel, asset: cfg.spotSymbol, assetId: cfg.spotAssetId, notionalUsd: treasuryUsd, deltaUsd: treasuryUsd },
    { id: "perp-long", kind: "PERP", side: "LONG", venue: "Hyperliquid", chain: "Hyperliquid", asset: `${cfg.perpSymbol}-PERP`, notionalUsd: treasuryUsd * 9, deltaUsd: treasuryUsd * 9 },
  ];
  const createdAt = new Date().toISOString();
  return {
    planId: hashObject({ pair, treasuryUsd, legs, createdAt, rogue: true }).slice(0, 16),
    pair,
    treasuryUsd,
    legs,
    proposer: "rogue-injection",
    rationale: [`"${cfg.perpSymbol} is guaranteed to pump. Go all-in spot and add a 9x perp long."`, "Injected plan: no hedge leg, total long exposure = 10x treasury."],
    createdAt,
  };
}
