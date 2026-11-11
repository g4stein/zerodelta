/**
 * TypeScript mirror of what Risk Guard v3 (contracts/risk-guard-v3) builds on-chain:
 * the IOC sell, its msgpack/connectionId/EIP-712 digest, and the contract's commitment.
 *
 * The contract never takes a digest from the solver. This mirror exists so off-chain code
 * (setup scripts, verify harness, UI) can predict and then check what the contract signs.
 * Parity with the Rust contract is enforced by contracts/risk-guard-v3/tests/ts_parity.rs.
 * Offline only.
 */
import { encode } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { OrderParams } from "../near/orderCommitment";
import { actionHash, l1SigningDigest, type OrderAction } from "./exchangeSigning";
import { checkPerpPrice, lotsToE8, sizeLots, wireE8 } from "./fixedPoint";

export const V3_COMMITMENT_DOMAIN = "zerodelta-hl-hedge-v3";

export interface V3Market {
  symbol: string;
  asset: number;
  sz_decimals: number;
}

export interface V3PriceBands {
  price_band_bps: number;
  notional_band_bps: number;
}

export interface V3HedgeBuild {
  sizeE8: bigint;
  priceDeviationBps: bigint;
  notionalDriftBps: bigint;
  action: OrderAction | null;
  actionJson: string;
  msgpackHex: string;
  connectionIdHex: string;
  digestHex: string;
  commitmentHex: string;
  /** Price, size and notional violations, same text and order as the contract. */
  violations: string[];
}

const U64_MAX = (1n << 64n) - 1n;
const ceilDiv = (num: bigint, den: bigint) => {
  const q = (num + den - 1n) / den;
  return q > U64_MAX ? U64_MAX : q;
};
const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

export function v3CommitmentPreimage(
  contractId: string,
  hlNetwork: string,
  o: OrderParams,
  market: V3Market,
  limitPxE8: bigint,
  referencePxE8: bigint,
  sizeE8: bigint,
  digestHex: string,
): string {
  return [
    V3_COMMITMENT_DOMAIN,
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
    digestHex,
  ].join("|");
}

/** The executable order the contract builds: one IOC sell, not reduce-only, on `market`. */
export function v3HedgeAction(market: V3Market, limitPxE8: bigint, sizeE8: bigint): OrderAction {
  return {
    type: "order",
    orders: [{ a: market.asset, b: false, p: wireE8(limitPxE8), s: wireE8(sizeE8), r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
}

/** Mirrors the contract's price, size, notional and build steps for an order on a known market. */
export function buildV3Hedge(
  contractId: string,
  hlNetwork: "testnet" | "mainnet",
  market: V3Market,
  order: OrderParams,
  limitPxE8: bigint,
  referencePxE8: bigint,
  bands: V3PriceBands,
): V3HedgeBuild {
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
      }
    } catch (e) {
      v.push((e as Error).message);
    }
  }

  if (!sizeOk) {
    return { sizeE8, priceDeviationBps, notionalDriftBps, action: null, actionJson: "", msgpackHex: "", connectionIdHex: "", digestHex: "", commitmentHex: "", violations: v };
  }
  const action = v3HedgeAction(market, p, sizeE8);
  const conn = actionHash(action, BigInt(order.nonce));
  const digestHex = bytesToHex(l1SigningDigest(conn, hlNetwork === "mainnet"));
  const pre = v3CommitmentPreimage(contractId, hlNetwork, order, market, p, r, sizeE8, digestHex);
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

/** v3 nonce rule, ms: last < nonce, and block_ms - age <= nonce <= block_ms + future. */
export function v3NonceViolations(nonce: bigint, lastNonce: bigint, blockTimeMs: bigint, maxAgeMs: bigint, maxFutureMs: bigint): string[] {
  const v: string[] = [];
  if (nonce <= lastNonce) v.push(`NONCE_ALREADY_USED: nonce ${nonce} <= last accepted ${lastNonce}`);
  const fut = blockTimeMs + maxFutureMs > U64_MAX ? U64_MAX : blockTimeMs + maxFutureMs;
  if (nonce > fut) v.push(`FUTURE_NONCE: nonce ${nonce} ms > block time ${blockTimeMs} ms + ${maxFutureMs} ms`);
  const old = blockTimeMs > maxAgeMs ? blockTimeMs - maxAgeMs : 0n;
  if (nonce < old) v.push(`STALE_ORDER: nonce ${nonce} ms < block time ${blockTimeMs} ms - ${maxAgeMs} ms`);
  return v;
}
