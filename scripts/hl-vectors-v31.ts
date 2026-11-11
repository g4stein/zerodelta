/**
 * TS -> Rust parity vectors for Risk Guard v3.1.  `npm run hl:vectors:v31`
 *
 * Runs the verified TypeScript modules (exchangeSigning.ts with expiresAfter, fixedPoint.ts, v31Hedge.ts)
 * over a fixed, seeded set of orders and writes every intermediate value to
 * contracts/risk-guard-v31/tests/fixtures/hl_vectors_v31.json. The Rust tests must reproduce each value
 * byte-for-byte; tests/hlParity.test.ts fails if this file goes stale. Offline only.
 */
import { encode } from "@msgpack/msgpack";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFileSync } from "node:fs";
import { actionHash, HYPERLIQUID_PERPS, HYPERLIQUID_PERPS_TESTNET, l1SigningDigest } from "../src/lib/hyperliquid/exchangeSigning";
import { toE8 } from "../src/lib/hyperliquid/fixedPoint";
import { buildV31Hedge, coinsToE8, v31ExpiryViolations, v31NonceViolations, v31WindowSizeViolations, V31_SIZE_CAPS, type V31Market } from "../src/lib/hyperliquid/v31Hedge";
import { buildHlVectors } from "./hl-vectors";

export const HL_VECTORS_V31_PATH = "contracts/risk-guard-v31/tests/fixtures/hl_vectors_v31.json";

const marketsFor = (table: Record<string, { asset: number; szDecimals: number }>): V31Market[] =>
  Object.entries(table).map(([symbol, m]) => ({
    symbol,
    asset: m.asset,
    sz_decimals: m.szDecimals,
    max_order_size_e8: coinsToE8(V31_SIZE_CAPS[symbol].maxOrderCoins).toString(),
    window_size_cap_e8: coinsToE8(V31_SIZE_CAPS[symbol].windowCoins).toString(),
  }));

export const V31_PARITY = {
  contractId: "zerodelta-guard-v31.testnet",
  blockTimeMs: 1794405483425,
  policy: { price_band_bps: 100, notional_band_bps: 50, max_nonce_age_ms: 300_000, max_nonce_future_ms: 60_000, max_expiry_ms: 3_600_000, window_ms: 86_400_000 },
  markets: { testnet: marketsFor(HYPERLIQUID_PERPS_TESTNET), mainnet: marketsFor(HYPERLIQUID_PERPS) },
};

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Case = { symbol: string; short: number; limit: string; ref: string; why: string; expiryOffsetMs?: number; nonceOffset?: number };

function hedgeVectors() {
  const rnd = prng(20261112);
  const REFS: Record<string, string[]> = { BTC: ["74363", "74423.5", "7442.3"], ETH: ["1975.6", "1966.6"], SOL: ["92.704", "92.3"], NEAR: ["3.7498", "3.7311"] };
  const fixed: Case[] = [
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "approved" },
    { symbol: "ETH", short: 3000000, limit: "1966.6", ref: "1975.6", why: "approved" },
    { symbol: "SOL", short: 3327581, limit: "91.961", ref: "92.424", why: "approved (the recorded v3 order)" },
    { symbol: "NEAR", short: 3327335, limit: "3.7311", ref: "3.7498", why: "approved (the v2 order)" },
    { symbol: "BTC", short: 665551, limit: "72000", ref: "74363", why: "out of band" },
    { symbol: "BTC", short: 665551, limit: "74423.5", ref: "74363", why: "too many sig figs" },
    { symbol: "BTC", short: 100, limit: "74000", ref: "74363", why: "notional drift + below minimum" },
    { symbol: "BTC", short: 1, limit: "74000", ref: "74363", why: "size zero" },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "0", why: "no reference" },
    { symbol: "BTC", short: 665551, limit: "0", ref: "74363", why: "zero limit" },
    // the audit attack: limit = reference = a tiny price
    { symbol: "BTC", short: 665551, limit: "0.1", ref: "0.1", why: "inflation: tiny price (BTC)" },
    { symbol: "SOL", short: 3327581, limit: "46.2", ref: "46.2", why: "inflation: half price (SOL, 2x)" },
    { symbol: "SOL", short: 3327581, limit: "9.2", ref: "9.2", why: "inflation: tenth price (SOL, 10x)" },
    { symbol: "NEAR", short: 3327335, limit: "0.3", ref: "0.3", why: "inflation: tiny price (NEAR)" },
    { symbol: "ETH", short: 3000000, limit: "20", ref: "20", why: "inflation: tiny price (ETH)" },
    // size cap edges
    { symbol: "SOL", short: 7356880, limit: "91.961", ref: "92.424", why: "exactly the 800 SOL cap" },
    { symbol: "SOL", short: 7357000, limit: "91.961", ref: "92.424", why: "just over the 800 SOL cap" },
    // minimum order value
    { symbol: "ETH", short: 1000, limit: "2000", ref: "2000", why: "exactly $10" },
    { symbol: "ETH", short: 980, limit: "2000", ref: "2000", why: "$9.80 below minimum" },
    { symbol: "BTC", short: 900, limit: "74000", ref: "74000", why: "$9 below minimum" },
    // expiry
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "expired", expiryOffsetMs: 0 },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "expiry in the past", expiryOffsetMs: -5000 },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "expiry at the maximum", expiryOffsetMs: 3_600_000 },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "expiry one ms too far", expiryOffsetMs: 3_600_001 },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "expiry one ms ahead", expiryOffsetMs: 1 },
    // nonce
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "stale nonce", nonceOffset: -300_001 },
    { symbol: "BTC", short: 665551, limit: "74000", ref: "74363", why: "future nonce", nonceOffset: 60_001 },
  ];
  const random: Case[] = Array.from({ length: 40 }, () => {
    const symbol = ["BTC", "ETH", "SOL", "NEAR"][Math.floor(rnd() * 4)];
    const ref = REFS[symbol][Math.floor(rnd() * REFS[symbol].length)];
    const bps = Math.floor(rnd() * 160) - 80;
    const limit = Number((Number(ref) * (1 + bps / 10_000)).toPrecision(5)).toString();
    const short = [100000, 665551, 3327335, 6_000_000, 25_000_000, 123_456_789][Math.floor(rnd() * 6)];
    return { symbol, short, limit, ref, why: `random ${bps} bps` };
  });

  const policy = V31_PARITY.policy;
  const block = BigInt(V31_PARITY.blockTimeMs);
  return [...fixed, ...random].flatMap((c, i) =>
    (["testnet", "mainnet"] as const).map((hlNetwork) => {
      const market = V31_PARITY.markets[hlNetwork].find((m) => m.symbol === c.symbol)!;
      const nonce = V31_PARITY.blockTimeMs - 1000 - i + (c.nonceOffset ?? 0) + (c.nonceOffset ? 1000 + i : 0);
      const expiresAfterMs = V31_PARITY.blockTimeMs + (c.expiryOffsetMs ?? 600_000);
      const order = {
        asset_symbol: c.symbol,
        treasury_usd_cents: Math.ceil(c.short / 0.6),
        spot_long_usd_cents: c.short,
        perp_short_usd_cents: c.short,
        perp_long_usd_cents: 0,
        collateral_usd_cents: Math.ceil(c.short / 0.6),
        quoted_slippage_bps: 2,
        nonce,
      };
      const b = buildV31Hedge(V31_PARITY.contractId, hlNetwork, market, order, toE8(c.limit), toE8(c.ref), BigInt(expiresAfterMs), policy);
      const violations = [
        ...b.violations,
        ...v31NonceViolations(BigInt(nonce), 0n, block, BigInt(policy.max_nonce_age_ms), BigInt(policy.max_nonce_future_ms)),
        ...v31ExpiryViolations(BigInt(expiresAfterMs), block, BigInt(policy.max_expiry_ms)),
        ...v31WindowSizeViolations(market, 0n, b.sizeE8, BigInt(policy.window_ms)),
      ];
      return {
        why: c.why,
        hlNetwork,
        order,
        limitPxE8: toE8(c.limit).toString(),
        referencePxE8: toE8(c.ref).toString(),
        expiresAfterMs,
        sizeE8: b.sizeE8.toString(),
        priceDeviationBps: b.priceDeviationBps.toString(),
        notionalDriftBps: b.notionalDriftBps.toString(),
        actionJson: b.actionJson,
        msgpackHex: b.msgpackHex,
        connectionIdHex: b.connectionIdHex,
        digestHex: b.digestHex,
        commitmentHex: b.commitmentHex,
        violations,
      };
    }),
  );
}

export function buildHlVectorsV31() {
  const base = buildHlVectors();
  // Re-hash the 64 order actions with an expiresAfter on three out of four of them.
  const EXPIRIES: (string | null)[] = [null, "1794409521698", "9007199254740991", "18446744073709551615"];
  const orders = base.orders.map((o) => {
    const expiresAfter = EXPIRIES[o.id % 4];
    const action = { type: "order", orders: o.orders.map((x) => ({ a: x.asset, b: x.isBuy, p: x.p, s: x.s, r: x.reduceOnly, t: { limit: { tif: x.tif } } })), grouping: "na" };
    const conn = actionHash(action, BigInt(o.nonce), null, expiresAfter === null ? null : BigInt(expiresAfter));
    return { ...o, expiresAfter, connectionIdHex: bytesToHex(conn), digestHex: bytesToHex(l1SigningDigest(conn, o.isMainnet)), msgpackHex: bytesToHex(encode(action)) };
  });
  return {
    note: "Generated by scripts/hl-vectors-v31.ts from src/lib/hyperliquid/{exchangeSigning,fixedPoint,v31Hedge}.ts. Do not edit by hand.",
    msgpackLibrary: "@msgpack/msgpack 3.x default options",
    wire: base.wire,
    sizing: base.sizing,
    priceRules: base.priceRules,
    orders,
    v31Parity: V31_PARITY,
    hedges: hedgeVectors(),
  };
}

if (process.argv[1]?.endsWith("hl-vectors-v31.ts")) {
  const v = buildHlVectorsV31();
  writeFileSync(HL_VECTORS_V31_PATH, `${JSON.stringify(v, null, 1)}\n`);
  const counts: Record<string, number> = {};
  for (const h of v.hedges) counts[h.violations.length === 0 ? "approved" : h.violations[0].split(":")[0]] = (counts[h.violations.length === 0 ? "approved" : h.violations[0].split(":")[0]] ?? 0) + 1;
  console.log(`wrote ${HL_VECTORS_V31_PATH}: ${v.orders.length} actions (${v.orders.filter((o) => o.expiresAfter !== null).length} with expiresAfter), ${v.hedges.length} contract-level cases`, counts);
}
