/**
 * TypeScript mirror of the Risk Guard contract's order math and payload commitment
 * (contracts/risk-guard/src/lib.rs). Both sides must produce identical results;
 * `npm run verify` checks this against the deployed contract.
 *
 *   preimage = "zerodelta-hedge-v1|<contract>|<asset>|<treasury>|<spot>|<perpShort>|<perpLong>|<collateral>|<slippage>|<nonce>"
 *   payload  = keccak256(preimage)          (32 bytes, signed by NEAR Chain Signatures)
 *   net_delta_bps  = ceil(|spot + perpLong − perpShort| × 10 000 / treasury)
 *   leverage_x100  = ceil((spot + perpShort + perpLong) × 100 / collateral)
 */
import { keccak256Hex } from "../crypto/encoding";
import { PAIRS, type RebalancePlan } from "../swarm/types";

export const COMMITMENT_DOMAIN = "zerodelta-hedge-v1";

/** Raw order legs exactly as the contract receives them. USD amounts are integer cents. */
export interface OrderParams {
  asset_symbol: string;
  treasury_usd_cents: number;
  spot_long_usd_cents: number;
  perp_short_usd_cents: number;
  perp_long_usd_cents: number;
  collateral_usd_cents: number;
  quoted_slippage_bps: number;
  nonce: number;
}

export interface OrderMetrics {
  net_delta_bps: number;
  leverage_x100: number;
}

export const toCents = (usd: number) => Math.max(0, Math.round(usd * 100));

const ceilDiv = (num: bigint, den: bigint) => (num + den - 1n) / den;

/** Same integer math as the contract (BigInt, rounded up). */
export function computeOrderMetrics(o: OrderParams): OrderMetrics {
  const spot = BigInt(o.spot_long_usd_cents);
  const long = spot + BigInt(o.perp_long_usd_cents);
  const short = BigInt(o.perp_short_usd_cents);
  const diff = long > short ? long - short : short - long;
  const treasury = BigInt(Math.max(1, o.treasury_usd_cents));
  const collateral = BigInt(Math.max(1, o.collateral_usd_cents));
  return {
    net_delta_bps: Number(ceilDiv(diff * 10_000n, treasury)),
    leverage_x100: Number(ceilDiv((spot + short + BigInt(o.perp_long_usd_cents)) * 100n, collateral)),
  };
}

export function commitmentPreimage(contractId: string, o: OrderParams): string {
  return [
    COMMITMENT_DOMAIN,
    contractId,
    o.asset_symbol,
    o.treasury_usd_cents,
    o.spot_long_usd_cents,
    o.perp_short_usd_cents,
    o.perp_long_usd_cents,
    o.collateral_usd_cents,
    o.quoted_slippage_bps,
    o.nonce,
  ].join("|");
}

export function computeHedgePayloadHex(contractId: string, o: OrderParams): string {
  return keccak256Hex(commitmentPreimage(contractId, o));
}

/** Derives the raw order legs from a plan, the way both the solver and the guardian must. */
export function orderParamsFromPlan(plan: RebalancePlan, maxPriceImpactBps: number, nonce: number): OrderParams {
  const sum = (pred: (l: RebalancePlan["legs"][number]) => boolean) =>
    plan.legs.filter(pred).reduce((s, l) => s + toCents(l.notionalUsd), 0);
  const treasury = toCents(plan.treasuryUsd);
  if (!Number.isSafeInteger(nonce) || nonce <= 0) throw new Error(`nonce ${nonce} is not a positive safe integer`);
  const order: OrderParams = {
    asset_symbol: PAIRS[plan.pair].perpSymbol,
    treasury_usd_cents: treasury,
    spot_long_usd_cents: sum((l) => l.kind === "SPOT" && l.side === "LONG"),
    perp_short_usd_cents: sum((l) => l.kind === "PERP" && l.side === "SHORT"),
    perp_long_usd_cents: sum((l) => l.kind === "PERP" && l.side === "LONG"),
    collateral_usd_cents: treasury,
    quoted_slippage_bps: Math.max(0, Math.ceil(maxPriceImpactBps - 1e-9)) + 0,
    nonce,
  };
  for (const [k, v] of Object.entries(order)) {
    if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`${k} = ${v} is not a safe integer`);
  }
  return order;
}

let lastNonce = 0;
/** Strictly increasing, JSON-safe u64 nonce (microsecond clock, bumped on collisions). */
export function nextOrderNonce(now = Date.now()): number {
  const candidate = now * 1000;
  lastNonce = Math.max(candidate, lastNonce + 1);
  // Date.now() * 1000 stays below Number.MAX_SAFE_INTEGER until the year 2255.
  if (!Number.isSafeInteger(lastNonce)) throw new Error("nonce overflowed the safe integer range");
  return lastNonce;
}

export function sameOrder(a: OrderParams, b: OrderParams): boolean {
  return commitmentPreimage("", a) === commitmentPreimage("", b);
}
