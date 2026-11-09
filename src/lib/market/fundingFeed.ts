/**
 * Live perpetual funding-rate feed.
 *
 * Source: Hyperliquid public info endpoint (no API key). Hyperliquid pays
 * funding every hour; `funding` is the current hourly rate as a decimal
 * (0.0000125 = 0.00125% per hour ≈ 10.95% APR).
 */
import { fetchWithTimeout } from "../near/rpcClient";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const FUNDING_INTERVALS_PER_YEAR = 24 * 365;

export interface PerpMarket {
  symbol: string;
  fundingHourly: number;
  markPx: number;
  oraclePx: number;
  premium: number;
  openInterestUsd: number;
  dayVolumeUsd: number;
  /** |mark − previous-day price| / previous-day price, as a fraction. */
  dayMoveAbs: number;
}

export interface FundingFeed {
  live: boolean;
  source: string;
  markets: Record<string, PerpMarket>;
  fetchedAt: string;
  latencyMs?: number;
  error?: string;
}

/** Snapshot used only when the live feed is unreachable. Values recorded 2026-11-08. */
export const FUNDING_SNAPSHOT: Record<string, PerpMarket> = {
  NEAR: { symbol: "NEAR", fundingHourly: 0.0000036816, markPx: 3.6482, oraclePx: 3.6505, premium: -0.0005917, openInterestUsd: 144_000_000, dayVolumeUsd: 72_000_000, dayMoveAbs: 0.045 },
  SOL: { symbol: "SOL", fundingHourly: 0.0000125, markPx: 89.451, oraclePx: 89.475, premium: -0.0002235, openInterestUsd: 432_000_000, dayVolumeUsd: 455_000_000, dayMoveAbs: 0.035 },
  ETH: { symbol: "ETH", fundingHourly: 0.0000125, markPx: 2232.15, oraclePx: 2233.03, premium: -0.0003269, openInterestUsd: 1_700_000_000, dayVolumeUsd: 2_080_000_000, dayMoveAbs: 0.025 },
  BTC: { symbol: "BTC", fundingHourly: 0.0000125, markPx: 75847, oraclePx: 75869.9, premium: -0.0002887, openInterestUsd: 3_150_000_000, dayVolumeUsd: 3_900_000_000, dayMoveAbs: 0.015 },
};

export const TRACKED_PERPS = ["NEAR", "SOL", "ETH", "BTC"] as const;

interface HlUniverse {
  universe: { name: string }[];
}
interface HlCtx {
  funding: string;
  markPx: string;
  oraclePx: string;
  premium: string | null;
  openInterest: string;
  dayNtlVlm: string;
  prevDayPx?: string;
}

export function fundingApr(fundingHourly: number): number {
  return fundingHourly * FUNDING_INTERVALS_PER_YEAR;
}

export async function fetchFundingFeed(timeoutMs = 8_000): Promise<FundingFeed> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      HYPERLIQUID_INFO_URL,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [meta, ctxs] = (await res.json()) as [HlUniverse, HlCtx[]];
    const markets: Record<string, PerpMarket> = {};
    meta.universe.forEach((asset, i) => {
      if (!(TRACKED_PERPS as readonly string[]).includes(asset.name)) return;
      const c = ctxs[i];
      const markPx = Number(c.markPx);
      markets[asset.name] = {
        symbol: asset.name,
        fundingHourly: Number(c.funding),
        markPx,
        oraclePx: Number(c.oraclePx),
        premium: Number(c.premium ?? 0),
        openInterestUsd: Number(c.openInterest) * markPx,
        dayVolumeUsd: Number(c.dayNtlVlm),
        dayMoveAbs: c.prevDayPx && Number(c.prevDayPx) > 0 ? Math.abs(markPx - Number(c.prevDayPx)) / Number(c.prevDayPx) : 0.03,
      };
    });
    if (Object.keys(markets).length === 0) throw new Error("no tracked markets in response");
    return { live: true, source: HYPERLIQUID_INFO_URL, markets, fetchedAt: new Date().toISOString(), latencyMs: Date.now() - started };
  } catch (err) {
    return {
      live: false,
      source: "bundled-snapshot-2026-11-08",
      markets: FUNDING_SNAPSHOT,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
