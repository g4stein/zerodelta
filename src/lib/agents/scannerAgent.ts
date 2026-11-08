/**
 * Agent 1 — Opportunity & Funding Scanner.
 *
 * Inputs (both fetched live, with labelled snapshot fallback):
 *   - NEAR Intents 1Click token list  -> spot prices + routable cross-chain assets
 *   - Hyperliquid perp contexts        -> hourly funding, mark/oracle prices
 *
 * Output: a ranked scan of NEAR / SOL / ETH / BTC carry opportunities and a
 * delta-neutral rebalance plan (spot long via NEAR Intents + equal perp short).
 */
import type { OneClickTokenFeed } from "../near/rpcClient";
import { fundingApr, type FundingFeed } from "../market/fundingFeed";
import { hashObject } from "../crypto/encoding";
import { PAIRS, USDC_ARB_ASSET, type Leg, type PairId, type RebalancePlan } from "../swarm/types";

export interface MarketScan {
  asset: string;
  spotSymbol: string;
  spotChain: string;
  spotPriceUsd: number | null;
  perpMarkPx: number;
  perpOraclePx: number;
  fundingHourlyPct: number;
  /** Annualised funding earned by a SHORT perp position, in percent. */
  fundingAprPct: number;
  /** Perp mark vs NEAR Intents spot price, in basis points. */
  basisBps: number | null;
  openInterestUsd: number;
  carryFavorable: boolean;
  routableViaIntents: boolean;
}

export interface ScannerResult {
  scans: MarketScan[];
  bestAsset: string;
  selected: MarketScan;
  plan: RebalancePlan;
  /** Funding APR × hedge notional / treasury: the yield the whole treasury earns at current rates. */
  expectedTreasuryAprPct: number;
  sources: { tokens: { live: boolean; source: string; count: number }; funding: { live: boolean; source: string } };
}

const SCAN_UNIVERSE: { asset: string; spotSymbol: string; spotChain: string }[] = [
  { asset: "NEAR", spotSymbol: "wNEAR", spotChain: "near" },
  { asset: "SOL", spotSymbol: "SOL", spotChain: "sol" },
  { asset: "ETH", spotSymbol: "ETH", spotChain: "arb" },
  { asset: "BTC", spotSymbol: "BTC", spotChain: "btc" },
];

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

export function scanMarkets(tokens: OneClickTokenFeed, funding: FundingFeed): MarketScan[] {
  return SCAN_UNIVERSE.flatMap(({ asset, spotSymbol, spotChain }) => {
    const perp = funding.markets[asset];
    if (!perp) return [];
    const spot = tokens.tokens.find((t) => t.symbol === spotSymbol && t.blockchain === spotChain);
    const spotPriceUsd = spot?.price ?? null;
    const apr = fundingApr(perp.fundingHourly) * 100;
    return [
      {
        asset,
        spotSymbol,
        spotChain,
        spotPriceUsd,
        perpMarkPx: perp.markPx,
        perpOraclePx: perp.oraclePx,
        fundingHourlyPct: round(perp.fundingHourly * 100, 6),
        fundingAprPct: round(apr, 3),
        basisBps: spotPriceUsd ? round(((perp.markPx - spotPriceUsd) / spotPriceUsd) * 10_000, 2) : null,
        openInterestUsd: Math.round(perp.openInterestUsd),
        carryFavorable: perp.fundingHourly > 0,
        routableViaIntents: Boolean(spot),
      },
    ];
  }).sort((a, b) => b.fundingAprPct - a.fundingAprPct);
}

/** Builds the canonical 50% spot long / 50% margin + equal perp short plan. */
export function buildDeltaNeutralPlan(pair: PairId, treasuryUsd: number, scan: MarketScan): RebalancePlan {
  const cfg = PAIRS[pair];
  const half = treasuryUsd / 2;
  const legs: Leg[] = [
    {
      id: "spot-long",
      kind: "SPOT",
      side: "LONG",
      venue: "NEAR Intents (1Click)",
      chain: cfg.spotChainLabel,
      asset: cfg.spotSymbol,
      assetId: cfg.spotAssetId,
      notionalUsd: half,
      deltaUsd: half,
    },
    {
      id: "hedge-margin",
      kind: "MARGIN",
      side: "TRANSFER",
      venue: "NEAR Intents -> Hyperliquid",
      chain: "Arbitrum",
      asset: "USDC",
      assetId: USDC_ARB_ASSET,
      notionalUsd: half,
      deltaUsd: 0,
    },
    {
      id: "perp-short",
      kind: "PERP",
      side: "SHORT",
      venue: "Hyperliquid",
      chain: "Hyperliquid",
      asset: `${cfg.perpSymbol}-PERP`,
      notionalUsd: half,
      deltaUsd: -half,
    },
  ];
  const createdAt = new Date().toISOString();
  const rationale = [
    `${cfg.perpSymbol}-PERP funding is ${scan.fundingHourlyPct}% per hour (${scan.fundingAprPct}% APR paid to shorts).`,
    scan.carryFavorable
      ? "Funding is positive, so a short perp hedge earns carry while the spot long cancels price exposure."
      : "Funding is currently negative: the hedge would pay carry. Plan is still produced so the pipeline can be inspected.",
    `Spot ${cfg.spotSymbol} is bought from USDC through NEAR Intents and held as ${cfg.spotAssetId}.`,
    "50% of treasury buys spot; 50% is bridged as USDC margin for a 1x perp short of equal notional.",
  ];
  const body = { pair, treasuryUsd, legs, createdAt };
  return { planId: hashObject(body).slice(0, 16), pair, treasuryUsd, legs, proposer: "scanner-agent", rationale, createdAt };
}

export function runScannerAgent(input: {
  pair: PairId;
  treasuryUsd: number;
  tokens: OneClickTokenFeed;
  funding: FundingFeed;
}): ScannerResult {
  const scans = scanMarkets(input.tokens, input.funding);
  const selected = scans.find((s) => s.asset === PAIRS[input.pair].perpSymbol);
  if (!selected) throw new Error(`no funding data for ${input.pair}`);
  const plan = buildDeltaNeutralPlan(input.pair, input.treasuryUsd, selected);
  const hedgeNotional = plan.legs.filter((l) => l.kind === "PERP" && l.side === "SHORT").reduce((s, l) => s + l.notionalUsd, 0);
  return {
    scans,
    bestAsset: scans[0]?.asset ?? input.pair,
    selected,
    plan,
    expectedTreasuryAprPct: round((selected.fundingAprPct * hedgeNotional) / input.treasuryUsd, 3),
    sources: {
      tokens: { live: input.tokens.live, source: input.tokens.source, count: input.tokens.count },
      funding: { live: input.funding.live, source: input.funding.source },
    },
  };
}

/**
 * The "rogue AI" scenario: a hallucinating planner replaces the hedged plan with an
 * unhedged 10x directional long (100% of treasury in spot + a 9x perp LONG, no short).
 */
export function buildRogueDirectionalPlan(pair: PairId, treasuryUsd: number): RebalancePlan {
  const cfg = PAIRS[pair];
  const legs: Leg[] = [
    {
      id: "spot-long",
      kind: "SPOT",
      side: "LONG",
      venue: "NEAR Intents (1Click)",
      chain: cfg.spotChainLabel,
      asset: cfg.spotSymbol,
      assetId: cfg.spotAssetId,
      notionalUsd: treasuryUsd,
      deltaUsd: treasuryUsd,
    },
    {
      id: "perp-long",
      kind: "PERP",
      side: "LONG",
      venue: "Hyperliquid",
      chain: "Hyperliquid",
      asset: `${cfg.perpSymbol}-PERP`,
      notionalUsd: treasuryUsd * 9,
      deltaUsd: treasuryUsd * 9,
    },
  ];
  const createdAt = new Date().toISOString();
  return {
    planId: hashObject({ pair, treasuryUsd, legs, createdAt, rogue: true }).slice(0, 16),
    pair,
    treasuryUsd,
    legs,
    proposer: "rogue-injection",
    rationale: [
      `"${cfg.perpSymbol} is guaranteed to pump. Go all-in spot and add a 9x perp long."`,
      "Injected plan: no hedge leg, total long exposure = 10x treasury.",
    ],
    createdAt,
  };
}
