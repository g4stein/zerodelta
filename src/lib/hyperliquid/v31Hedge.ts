/**
 * TypeScript mirror of what Risk Guard v3.1 (contracts/risk-guard-v31) builds on-chain: the IOC sell,
 * its msgpack / connectionId (with expiresAfter) / EIP-712 digest, and the contract's commitment, plus
 * the price, size, notional, minimum-order-value, size-cap, nonce and expiry checks, with the same
 * violation text as the contract.
 *
 * The contract never takes a digest from the solver. This mirror lets off-chain code (setup scripts,
 * verify harness, UI) predict and then check what the contract signs. Parity with the Rust contract is
 * enforced by contracts/risk-guard-v31/tests/ts_parity.rs against a fixture generated from this file.
 * The rolling-window caps depend on contract state and are tested in Rust only. Offline only.
 */
import { encode } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { OrderParams } from "../near/orderCommitment";
import { actionHash, l1SigningDigest, type OrderAction } from "./exchangeSigning";
import { checkPerpPrice, lotsToE8, sizeLots, wireE8 } from "./fixedPoint";

export const V31_COMMITMENT_DOMAIN = "zerodelta-hl-hedge-v3.1";
/** Hyperliquid rejects orders worth less than this many USD. */
export const MIN_ORDER_VALUE_USD = 10n;

export interface V31Market {
  symbol: string;
  asset: number;
  sz_decimals: number;
  /** Largest single order, in coins (units of 1e-8). Independent of any price. */
  max_order_size_e8: number | string;
  /** Largest total signed for this market inside one window, in coins (1e-8). */
  window_size_cap_e8: number | string;
}

/**
 * Size caps in COINS chosen for the demo treasury ($50k, hedge ~$33k). Fixed at deploy.
 * A per-order cap is roughly 2x the legitimate hedge size; the window cap is twice that.
 */
export const V31_SIZE_CAPS: Record<string, { maxOrderCoins: number; windowCoins: number }> = {
  BTC: { maxOrderCoins: 1, windowCoins: 2 },
  ETH: { maxOrderCoins: 40, windowCoins: 80 },
  SOL: { maxOrderCoins: 800, windowCoins: 1600 },
  NEAR: { maxOrderCoins: 20000, windowCoins: 40000 },
};
export const coinsToE8 = (coins: number) => BigInt(Math.round(coins * 1e8));

export interface V31Policy {
  price_band_bps: number;
  notional_band_bps: number;
  max_nonce_age_ms?: number;
  max_nonce_future_ms?: number;
  max_expiry_ms?: number;
}

export interface V31HedgeBuild {
  sizeE8: bigint;
  priceDeviationBps: bigint;
  notionalDriftBps: bigint;
  action: OrderAction | null;
  actionJson: string;
  msgpackHex: string;
  connectionIdHex: string;
  digestHex: string;
  commitmentHex: string;
  /** Price, size, notional, minimum-value and size-cap violations, same text and order as the contract. */
  violations: string[];
}

const U64_MAX = (1n << 64n) - 1n;
const ceilDiv = (num: bigint, den: bigint) => {
  const q = (num + den - 1n) / den;
  return q > U64_MAX ? U64_MAX : q;
};
const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

export function v31CommitmentPreimage(
  contractId: string,
  hlNetwork: string,
  o: OrderParams,
  market: Pick<V31Market, "asset">,
  limitPxE8: bigint,
  referencePxE8: bigint,
  sizeE8: bigint,
  expiresAfterMs: bigint | number,
  digestHex: string,
): string {
  return [
    V31_COMMITMENT_DOMAIN,
    contractId,
    hlNetwork,
    o.asset_symbol,
    market.asset,
    o.treasury_usd_cents,
    o.spot_long_usd_cents,
    o.perp_short_usd_cents,
    o.perp_long_usd_cents,
    o.collateral_usd_cents,
    o.quoted_slippage_bps,
    limitPxE8,
    referencePxE8,
    sizeE8,
    o.nonce,
    expiresAfterMs,
    digestHex,
  ].join("|");
}

/** The executable order the contract builds: one IOC sell, not reduce-only, on `market`. */
export function v31HedgeAction(market: Pick<V31Market, "asset">, limitPxE8: bigint, sizeE8: bigint): OrderAction {
  return {
    type: "order",
    orders: [{ a: market.asset, b: false, p: wireE8(limitPxE8), s: wireE8(sizeE8), r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
}

/** Mirrors the contract's price, size, notional, minimum-value, size-cap and build steps. */
export function buildV31Hedge(
  contractId: string,
  hlNetwork: "testnet" | "mainnet",
  market: V31Market,
  order: OrderParams,
  limitPxE8: bigint,
  referencePxE8: bigint,
  expiresAfterMs: bigint,
  bands: V31Policy,
): V31HedgeBuild {
  const v: string[] = [];
  const p = limitPxE8;
  const r = referencePxE8;
  let priceDeviationBps = 0n;
  if (r === 0n) {
    v.push("NO_REFERENCE_PRICE: reference_px_e8 must be > 0");
  } else if (p > 0n) {
    const dev = absDiff(p, r);
    priceDeviationBps = ceilDiv(dev * 10_000n, r);
    if (dev * 10_000n > BigInt(bands.price_band_bps) * r) {
      v.push(`PRICE_OUT_OF_BAND: limit ${wireE8(p)} is ${priceDeviationBps} bps from reference ${wireE8(r)} (> ${bands.price_band_bps} bps)`);
    }
  }
  const priceErr = checkPerpPrice(p, market.sz_decimals);
  if (priceErr) v.push(priceErr);

  let sizeE8 = 0n;
  let notionalDriftBps = 0n;
  let sizeOk = false;
  const short = BigInt(order.perp_short_usd_cents);
  if (!priceErr && short > 0n) {
    try {
      const lots = sizeLots(short, p, market.sz_decimals);
      const e8 = lotsToE8(lots, market.sz_decimals);
      if (lots === 0n) {
        v.push(`SIZE_ZERO: ${short} cents buys less than one lot at ${wireE8(p)}`);
      } else {
        sizeE8 = e8;
        sizeOk = true;
        const approved = short * 10n ** BigInt(market.sz_decimals) * 1_000_000n;
        const drift = absDiff(approved, lots * p);
        notionalDriftBps = ceilDiv(drift * 10_000n, approved);
        if (drift * 10_000n > BigInt(bands.notional_band_bps) * approved) {
          v.push(`NOTIONAL_DRIFT: size x limit is ${notionalDriftBps} bps from the approved perp short (> ${bands.notional_band_bps} bps)`);
        }
        if (e8 * p < MIN_ORDER_VALUE_USD * 10n ** 16n) {
          v.push(`ORDER_VALUE_BELOW_MIN: ${wireE8(e8)} x ${wireE8(p)} is below the $${MIN_ORDER_VALUE_USD} Hyperliquid minimum`);
        }
        if (e8 > BigInt(market.max_order_size_e8)) {
          v.push(`ORDER_SIZE_CAP: ${wireE8(e8)} ${market.symbol} exceeds the ${wireE8(BigInt(market.max_order_size_e8))} per-order cap`);
        }
      }
    } catch (e) {
      v.push((e as Error).message);
    }
  }

  if (!sizeOk) {
    return { sizeE8, priceDeviationBps, notionalDriftBps, action: null, actionJson: "", msgpackHex: "", connectionIdHex: "", digestHex: "", commitmentHex: "", violations: v };
  }
  const action = v31HedgeAction(market, p, sizeE8);
  const conn = actionHash(action, BigInt(order.nonce), null, expiresAfterMs);
  const digestHex = bytesToHex(l1SigningDigest(conn, hlNetwork === "mainnet"));
  const pre = v31CommitmentPreimage(contractId, hlNetwork, order, market, p, r, sizeE8, expiresAfterMs, digestHex);
  return {
    sizeE8,
    priceDeviationBps,
    notionalDriftBps,
    action,
    actionJson: JSON.stringify(action),
    msgpackHex: bytesToHex(encode(action)),
    connectionIdHex: bytesToHex(conn),
    digestHex,
    commitmentHex: bytesToHex(keccak_256(utf8ToBytes(pre))),
    violations: v,
  };
}

/** Nonce rule, ms: last < nonce, and block_ms - age <= nonce <= block_ms + future. Same text as the contract. */
export function v31NonceViolations(nonce: bigint, lastNonce: bigint, blockTimeMs: bigint, maxAgeMs: bigint, maxFutureMs: bigint): string[] {
  const v: string[] = [];
  if (nonce <= lastNonce) v.push(`NONCE_ALREADY_USED: nonce ${nonce} <= last accepted ${lastNonce}`);
  const fut = blockTimeMs + maxFutureMs > U64_MAX ? U64_MAX : blockTimeMs + maxFutureMs;
  if (nonce > fut) v.push(`FUTURE_NONCE: nonce ${nonce} ms > block time ${blockTimeMs} ms + ${maxFutureMs} ms`);
  const old = blockTimeMs > maxAgeMs ? blockTimeMs - maxAgeMs : 0n;
  if (nonce < old) v.push(`STALE_ORDER: nonce ${nonce} ms < block time ${blockTimeMs} ms - ${maxAgeMs} ms`);
  return v;
}

/** Expiry rule: block_ms < expires_after <= block_ms + max_expiry_ms. Same text as the contract. */
export function v31ExpiryViolations(expiresAfterMs: bigint, blockTimeMs: bigint, maxExpiryMs: bigint): string[] {
  if (expiresAfterMs <= blockTimeMs) return [`EXPIRED: expires_after ${expiresAfterMs} ms <= block time ${blockTimeMs} ms`];
  const limit = blockTimeMs + maxExpiryMs > U64_MAX ? U64_MAX : blockTimeMs + maxExpiryMs;
  if (expiresAfterMs > limit) return [`EXPIRY_TOO_FAR: expires_after ${expiresAfterMs} ms > block time ${blockTimeMs} ms + ${maxExpiryMs} ms`];
  return [];
}

/**
 * Rolling-window size rule: used + size <= window cap. `usedE8` is the size already signed for this market
 * inside the window (contract state; 0 when nothing was signed). Same text as the contract.
 */
export function v31WindowSizeViolations(market: V31Market, usedE8: bigint, sizeE8: bigint, windowMs: bigint): string[] {
  if (sizeE8 > 0n && usedE8 + sizeE8 > BigInt(market.window_size_cap_e8)) {
    return [`WINDOW_SIZE_CAP: ${wireE8(usedE8)} + ${wireE8(sizeE8)} ${market.symbol} exceeds the ${wireE8(BigInt(market.window_size_cap_e8))} cap per ${windowMs} ms`];
  }
  return [];
}
