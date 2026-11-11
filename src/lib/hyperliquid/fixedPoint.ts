/**
 * Exact fixed-point helpers for Hyperliquid prices and sizes, in units of 1e-8 (the precision of
 * the SDK's float_to_wire). Integer-only, mirrored by contracts/risk-guard-v3/src/hl.rs.
 */

export const E8 = 100_000_000n;
export const MAX_PERP_DECIMALS = 6;
export const MAX_PRICE_SIG_FIGS = 5;

/** A decimal string or a JS number (via toFixed(8), exactly what floatToWire rounds to) -> e8 integer. */
export function toE8(x: number | string): bigint {
  const s = typeof x === "number" ? x.toFixed(8) : x;
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(`not a non-negative decimal with <= 8 decimals: ${s}`);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * E8 + BigInt(f.padEnd(8, "0"));
}

/** float_to_wire on an e8 integer: no exponent, no trailing zeros. */
export function wireE8(v: bigint): string {
  const int = v / E8;
  const frac = v % E8;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

export function decimalsE8(v: bigint): number {
  let frac = v % E8;
  if (frac === 0n) return 0;
  let d = 8;
  while (frac % 10n === 0n) {
    frac /= 10n;
    d -= 1;
  }
  return d;
}

export function sigFigsE8(v: bigint): number {
  const int = v / E8;
  const dec = decimalsE8(v);
  if (int > 0n) return int.toString().length + dec;
  let frac = v % E8;
  while (frac !== 0n && frac % 10n === 0n) frac /= 10n;
  return frac === 0n ? 0 : frac.toString().length;
}

/** Hyperliquid perp price rules; returns the violation (same text as the contract) or null. */
export function checkPerpPrice(pxE8: bigint, szDecimals: number): string | null {
  if (pxE8 === 0n) return "PRICE_ZERO";
  if (szDecimals > MAX_PERP_DECIMALS) return `SZ_DECIMALS_TOO_LARGE: ${szDecimals}`;
  if (pxE8 % E8 === 0n) return null;
  const maxDec = MAX_PERP_DECIMALS - szDecimals;
  const dec = decimalsE8(pxE8);
  if (dec > maxDec) return `PRICE_TOO_MANY_DECIMALS: ${wireE8(pxE8)} has ${dec} > ${maxDec} decimals`;
  const sf = sigFigsE8(pxE8);
  if (sf > MAX_PRICE_SIG_FIGS) return `PRICE_TOO_MANY_SIG_FIGS: ${wireE8(pxE8)} has ${sf} > ${MAX_PRICE_SIG_FIGS} significant figures`;
  return null;
}

const U64_MAX = (1n << 64n) - 1n;

/** Whole lots (10^-szDecimals) for a USD-cent notional at a price: floor(notional / price). */
export function sizeLots(notionalUsdCents: bigint | number, pxE8: bigint, szDecimals: number): bigint {
  if (pxE8 === 0n) throw new Error("PRICE_ZERO");
  if (szDecimals > 8) throw new Error(`SZ_DECIMALS_TOO_LARGE: ${szDecimals}`);
  const lots = (BigInt(notionalUsdCents) * 10n ** BigInt(szDecimals) * 1_000_000n) / pxE8;
  if (lots > U64_MAX) throw new Error("SIZE_OVERFLOW");
  return lots;
}

export function lotsToE8(lots: bigint, szDecimals: number): bigint {
  if (szDecimals > 8) throw new Error(`SZ_DECIMALS_TOO_LARGE: ${szDecimals}`);
  const v = lots * 10n ** BigInt(8 - szDecimals);
  if (v > U64_MAX) throw new Error("SIZE_OVERFLOW");
  return v;
}
