/** Shared domain types for the ZeroDelta 3-agent swarm. */

export type PairId = "NEAR" | "SOL" | "ETH";
export type SwarmMode = "rebalance" | "rogue";

export interface PairConfig {
  id: PairId;
  label: string;
  perpSymbol: string;
  spotSymbol: string;
  /** NEAR Intents asset id of the spot leg (held in intents.near, withdrawable to its native chain). */
  spotAssetId: string;
  spotDecimals: number;
  spotChain: string;
  spotChainLabel: string;
}

export const USDC_NEAR_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_ARB_ASSET = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const USDC_DECIMALS = 6;

export const PAIRS: Record<PairId, PairConfig> = {
  NEAR: {
    id: "NEAR",
    label: "NEAR-PERP / wNEAR",
    perpSymbol: "NEAR",
    spotSymbol: "wNEAR",
    spotAssetId: "nep141:wrap.near",
    spotDecimals: 24,
    spotChain: "near",
    spotChainLabel: "NEAR",
  },
  SOL: {
    id: "SOL",
    label: "SOL-PERP / SOL",
    perpSymbol: "SOL",
    spotSymbol: "SOL",
    spotAssetId: "nep141:sol.omft.near",
    spotDecimals: 9,
    spotChain: "sol",
    spotChainLabel: "Solana",
  },
  ETH: {
    id: "ETH",
    label: "ETH-PERP / ETH",
    perpSymbol: "ETH",
    spotSymbol: "ETH",
    spotAssetId: "nep141:arb.omft.near",
    spotDecimals: 18,
    spotChain: "arb",
    spotChainLabel: "Arbitrum",
  },
};

export type LegKind = "SPOT" | "PERP" | "MARGIN";
export type LegSide = "LONG" | "SHORT" | "TRANSFER";

export interface Leg {
  id: string;
  kind: LegKind;
  side: LegSide;
  venue: string;
  chain: string;
  asset: string;
  assetId?: string;
  /** Gross USD size of the leg (always >= 0). */
  notionalUsd: number;
  /** Signed price exposure in USD: +long, -short, 0 for transfers. */
  deltaUsd: number;
}

export interface RebalancePlan {
  planId: string;
  pair: PairId;
  treasuryUsd: number;
  legs: Leg[];
  proposer: "scanner-agent" | "rogue-injection";
  rationale: string[];
  createdAt: string;
}

export interface SwarmRequest {
  mode: SwarmMode;
  treasuryUsd: number;
  pair: PairId;
  sliceCount: number;
}

export const LIMITS = {
  treasuryMinUsd: 10_000,
  treasuryMaxUsd: 1_000_000,
  sliceMin: 1,
  sliceMax: 24,
} as const;

/** Validates and clamps untrusted input coming from the HTTP API. */
export function parseSwarmRequest(input: unknown): SwarmRequest {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const mode: SwarmMode = body.mode === "rogue" ? "rogue" : "rebalance";
  const pair: PairId = body.pair === "SOL" || body.pair === "ETH" ? body.pair : "NEAR";
  const treasuryRaw = Number(body.treasuryUsd ?? 50_000);
  const sliceRaw = Number(body.sliceCount ?? 8);
  const treasuryUsd = Number.isFinite(treasuryRaw)
    ? Math.min(LIMITS.treasuryMaxUsd, Math.max(LIMITS.treasuryMinUsd, Math.round(treasuryRaw)))
    : 50_000;
  const sliceCount = Number.isFinite(sliceRaw)
    ? Math.min(LIMITS.sliceMax, Math.max(LIMITS.sliceMin, Math.round(sliceRaw)))
    : 8;
  return { mode, pair, treasuryUsd, sliceCount };
}
