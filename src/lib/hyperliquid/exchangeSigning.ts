/**
 * OFFLINE-ONLY Hyperliquid execution-readiness module.
 *
 * Reproduces the official Hyperliquid Python SDK's L1 action signing scheme
 * (hyperliquid-python-sdk `hyperliquid/utils/signing.py`: `order_request_to_order_wire`,
 * `action_hash`, `construct_phantom_agent`, `l1_payload`, `sign_l1_action`) and
 * checks a constructed order action against the hedge that ZeroDelta's Risk Guard
 * approved.
 *
 * IMPORTANT
 * - Nothing here talks to Hyperliquid or NEAR. It never submits an order and never
 *   asks the deployed Risk Guard / MPC contract for a signature.
 * - The deployed v2 contract signs `keccak256("zerodelta-hedge-v1|...")`, a ZeroDelta
 *   order commitment. That digest is NOT a Hyperliquid action digest, so the existing
 *   MPC signature cannot be submitted to Hyperliquid. See docs/HYPERLIQUID_EXECUTION_PATH.md.
 * - Correctness is checked against the official SDK's published test vectors in
 *   tests/hyperliquid.test.ts.
 */
import { encode } from "@msgpack/msgpack";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { OrderParams } from "../near/orderCommitment";
import { lotsToE8, sizeLots, toE8, wireE8 } from "./fixedPoint";

/** Perp asset index and size decimals from Hyperliquid `info {type: "meta"}` (fetched 2026-11-09). */
export const HYPERLIQUID_PERPS: Record<string, { asset: number; szDecimals: number }> = {
  BTC: { asset: 0, szDecimals: 5 },
  ETH: { asset: 1, szDecimals: 4 },
  SOL: { asset: 5, szDecimals: 2 },
  NEAR: { asset: 74, szDecimals: 1 },
};

/**
 * Hyperliquid TESTNET perp indices differ from mainnet. From
 * https://api.hyperliquid-testnet.xyz/info {type: "meta"} fetched 2026-11-11T13:58:03Z.
 * Never use mainnet indices for a testnet order; deploy scripts re-fetch and compare.
 */
export const HYPERLIQUID_PERPS_TESTNET: Record<string, { asset: number; szDecimals: number }> = {
  BTC: { asset: 3, szDecimals: 5 },
  ETH: { asset: 4, szDecimals: 4 },
  SOL: { asset: 0, szDecimals: 2 },
  NEAR: { asset: 54, szDecimals: 1 },
};
export const HYPERLIQUID_PERPS_TESTNET_FETCHED_AT = "2026-11-11T13:58:03Z";

export type Tif = "Alo" | "Ioc" | "Gtc";

/** Field order matters for msgpack: a, b, p, s, r, t (same as the SDK's OrderWire). */
export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } };
}

export interface OrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: "na";
}

/**
 * Port of the SDK's `float_to_wire`: 8-decimal rounding, error if that loses precision,
 * then strip trailing zeros (Decimal.normalize) without scientific notation.
 */
export function floatToWire(x: number): string {
  // toFixed switches to exponent notation at 1e21; the SDK never emits that. Refuse instead.
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) throw new Error(`float_to_wire out of range: ${x}`);
  let rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`float_to_wire causes rounding: ${x}`);
  if (/^-0(\.0+)?$/.test(rounded)) rounded = "0";
  if (rounded.includes(".")) rounded = rounded.replace(/0+$/, "").replace(/\.$/, "");
  return rounded;
}

/** Port of the SDK's `float_to_int_for_hashing` (x * 1e8, must be integral). */
export function floatToIntForHashing(x: number): number {
  const withDecimals = x * 1e8;
  const rounded = Math.round(withDecimals);
  if (Math.abs(rounded - withDecimals) >= 1e-3) throw new Error(`float_to_int causes rounding: ${x}`);
  return rounded;
}

export function orderWire(input: { asset: number; isBuy: boolean; limitPx: number; sz: number; reduceOnly: boolean; tif: Tif }): OrderWire {
  return { a: input.asset, b: input.isBuy, p: floatToWire(input.limitPx), s: floatToWire(input.sz), r: input.reduceOnly, t: { limit: { tif: input.tif } } };
}

export function orderAction(orders: OrderWire[]): OrderAction {
  return { type: "order", orders, grouping: "na" };
}

function u64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

/** keccak256(msgpack(action) || nonce_u64_be || vault flag [|| vault address]) — SDK `action_hash` without expiresAfter. */
export function actionHash(action: unknown, nonce: number | bigint, vaultAddress: string | null = null): Uint8Array {
  const packed = encode(action);
  const vault = vaultAddress === null ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), hexToBytes(vaultAddress.replace(/^0x/, "").toLowerCase()));
  return keccak_256(concatBytes(packed, u64be(nonce), vault));
}

const keccak = (b: Uint8Array) => keccak_256(b);
const pad32 = (b: Uint8Array) => concatBytes(new Uint8Array(32 - b.length), b);

const DOMAIN_TYPEHASH = keccak(utf8ToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const AGENT_TYPEHASH = keccak(utf8ToBytes("Agent(string source,bytes32 connectionId)"));
/** EIP-712 domain of L1 actions: name "Exchange", version "1", chainId 1337, verifyingContract 0x0. */
const DOMAIN_SEPARATOR = keccak(
  concatBytes(DOMAIN_TYPEHASH, keccak(utf8ToBytes("Exchange")), keccak(utf8ToBytes("1")), pad32(hexToBytes((1337).toString(16).padStart(4, "0"))), new Uint8Array(32)),
);

/** Phantom agent {source: "a" mainnet | "b" testnet, connectionId: actionHash}, EIP-712 digest. */
export function l1SigningDigest(connectionId: Uint8Array, isMainnet: boolean): Uint8Array {
  const structHash = keccak(concatBytes(AGENT_TYPEHASH, keccak(utf8ToBytes(isMainnet ? "a" : "b")), connectionId));
  return keccak(concatBytes(new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, structHash));
}

export interface L1Signature {
  r: string;
  s: string;
  v: number;
}

/** Signs an L1 action locally (RFC 6979, low-s), returning the SDK's {r, s, v} shape. Test keys only. */
export function signL1Action(privateKeyHex: string, action: unknown, nonce: number, isMainnet: boolean): L1Signature {
  const digest = l1SigningDigest(actionHash(action, nonce), isMainnet);
  const sig = secp256k1.sign(digest, hexToBytes(privateKeyHex.replace(/^0x/, "")), { prehash: false, format: "recovered" });
  // noble "recovered" format: [recovery, r(32), s(32)]
  return { r: `0x${BigInt(`0x${bytesToHex(sig.slice(1, 33))}`).toString(16)}`, s: `0x${BigInt(`0x${bytesToHex(sig.slice(33, 65))}`).toString(16)}`, v: 27 + sig[0] };
}

// ---------------------------------------------------------------------------
// Binding an executable action to the Risk-Guard-approved hedge
// ---------------------------------------------------------------------------

export interface HedgeBindingCheck {
  ok: boolean;
  violations: string[];
  notionalUsd: number;
  approvedNotionalUsd: number;
  deviationBps: number;
}

/**
 * Checks that a Hyperliquid order action is exactly the hedge the Risk Guard approved:
 * one order, the right market, a SELL (short), not reduce-only, Ioc, a limit price within
 * `priceBandBps` of a trusted reference price (mark/oracle), and size × reference price
 * within `toleranceBps` of the approved perp-short notional.
 *
 * The reference price matters: an IOC sell fills at the bid, so checking size × limit price
 * alone would let 100× the size through at 1/100 of the price.
 */
export function checkActionMatchesApprovedHedge(
  action: OrderAction,
  approved: Pick<OrderParams, "asset_symbol" | "perp_short_usd_cents" | "perp_long_usd_cents">,
  referencePx: number,
  toleranceBps = 50,
  priceBandBps = 100,
): HedgeBindingCheck {
  const v: string[] = [];
  const perp = HYPERLIQUID_PERPS[approved.asset_symbol];
  const approvedNotionalUsd = approved.perp_short_usd_cents / 100;
  if (!(referencePx > 0) || !Number.isFinite(referencePx)) v.push("NO_TRUSTED_REFERENCE_PRICE");
  if (!perp) v.push(`UNSUPPORTED_ASSET: ${approved.asset_symbol}`);
  if (approved.perp_long_usd_cents !== 0) v.push("APPROVED_ORDER_HAS_PERP_LONG");
  if (action.type !== "order" || action.grouping !== "na") v.push("NOT_A_PLAIN_ORDER_ACTION");
  if (action.orders.length !== 1) v.push(`EXPECTED_ONE_ORDER: got ${action.orders.length}`);
  const o = action.orders[0];
  let notionalUsd = 0;
  if (o) {
    if (perp && o.a !== perp.asset) v.push(`WRONG_MARKET: asset ${o.a} != ${perp.asset} (${approved.asset_symbol})`);
    if (o.b !== false) v.push("WRONG_SIDE: hedge must be a SELL (short)");
    if (o.r !== false) v.push("REDUCE_ONLY_NOT_ALLOWED");
    if (o.t?.limit?.tif !== "Ioc") v.push("TIF_MUST_BE_IOC");
    const decimals = o.s.includes(".") ? o.s.split(".")[1].length : 0;
    if (perp && decimals > perp.szDecimals) v.push(`SIZE_PRECISION: ${decimals} > ${perp.szDecimals} decimals`);
    const px = Number(o.p);
    if (referencePx > 0 && Math.abs(px - referencePx) / referencePx > priceBandBps / 10_000) {
      v.push(`PRICE_OUTSIDE_BAND: limit ${o.p} vs reference ${referencePx} (> ${priceBandBps} bps)`);
    }
    notionalUsd = Number(o.s) * (referencePx > 0 ? referencePx : px);
  }
  const deviationBps = approvedNotionalUsd > 0 ? (Math.abs(notionalUsd - approvedNotionalUsd) / approvedNotionalUsd) * 10_000 : Number.POSITIVE_INFINITY;
  if (!(deviationBps <= toleranceBps)) v.push(`NOTIONAL_MISMATCH: ${notionalUsd.toFixed(2)} vs approved ${approvedNotionalUsd.toFixed(2)} (${deviationBps.toFixed(1)} bps)`);
  return { ok: v.length === 0, violations: v, notionalUsd, approvedNotionalUsd, deviationBps };
}

/**
 * Builds the IOC short that corresponds to an approved order at a given limit price.
 * Size is the exact integer floor of notional / limit in whole lots (same as the v3 contract);
 * an earlier float version could under-count by one lot at boundaries.
 */
export function buildHedgeAction(approved: Pick<OrderParams, "asset_symbol" | "perp_short_usd_cents">, limitPx: number): OrderAction {
  const perp = HYPERLIQUID_PERPS[approved.asset_symbol];
  if (!perp) throw new Error(`unsupported asset ${approved.asset_symbol}`);
  const lots = sizeLots(approved.perp_short_usd_cents, toE8(limitPx), perp.szDecimals);
  const wire = orderWire({ asset: perp.asset, isBuy: false, limitPx, sz: 0, reduceOnly: false, tif: "Ioc" });
  return orderAction([{ ...wire, s: wireE8(lotsToE8(lots, perp.szDecimals)) }]);
}

/** Hex of the action hash, the value a future contract would have to bind to (see docs). */
export const actionHashHex = (action: unknown, nonce: number) => bytesToHex(actionHash(action, nonce));
