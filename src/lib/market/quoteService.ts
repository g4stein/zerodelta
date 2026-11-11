/** Trusted in-process quote adapter. The solver receives copies; it cannot register arbitrary evidence.
 * This is a module boundary check, not hardware isolation or a vendor-signed quote. */
import { fetchOneClickQuote, type OneClickTokenFeed } from "../near/rpcClient";
import { USDC_DECIMALS, USDC_NEAR_ASSET, type Leg } from "../swarm/types";
import { hashObject, randomBytes, bytesToHex } from "../crypto/encoding";
import type { LegQuote } from "../agents/solverAgent";

const pow10 = (d: number) => 10n ** BigInt(d);

function formatUnits(amount: bigint, decimals: number, dp = 6): string {
  const whole = amount / pow10(decimals);
  const frac = (amount % pow10(decimals)).toString().padStart(decimals, "0").slice(0, dp);
  return `${whole}.${frac}`.replace(/\.?0+$/, "") || "0";
}

export function splitAmount(total: bigint, parts: number): bigint[] {
  const base = total / BigInt(parts);
  const out = Array.from({ length: parts }, () => base);
  out[parts - 1] += total - base * BigInt(parts);
  return out;
}

function tokenInfo(tokens: OneClickTokenFeed, assetId: string) {
  return tokens.tokens.find((t) => t.assetId === assetId);
}

/** Deterministic square-root impact model used only when the live API is unavailable. */
export function localImpactBps(sliceUsd: number): number {
  return Math.round(10 * Math.sqrt(sliceUsd / 100_000) * 100) / 100;
}
/** Assumed fixed spread + fee for the offline fallback quote. */
export const LOCAL_SPREAD_BPS = 15;
/** Size of the reference quote used to separate fixed spread from size-driven slippage. */
export const REFERENCE_QUOTE_USDC = 100n * 10n ** BigInt(USDC_DECIMALS);

const round2 = (n: number) => Math.round(n * 100) / 100;

async function fetchLegQuote(args: {
  leg: Leg;
  destinationAsset: string;
  destinationDecimals: number;
  slices: number;
  tokens: OneClickTokenFeed;
  recipient: string;
  slippageToleranceBps: number;
  live: boolean;
}): Promise<Omit<LegQuote, "evidenceId">> {
  const { leg, destinationAsset, destinationDecimals, slices, tokens, recipient, slippageToleranceBps } = args;
  const totalIn = BigInt(Math.round(leg.notionalUsd * 10 ** USDC_DECIMALS));
  const parts = splitAmount(totalIn, slices);
  const sampleIn = parts[0];
  const base = {
    legId: leg.id,
    originAsset: USDC_NEAR_ASSET,
    destinationAsset,
    slices,
    amountIn: totalIn.toString(),
    slippageToleranceBps,
  };

  let liveError: string | undefined;
  if (args.live) {
    const request = (amount: bigint) =>
      fetchOneClickQuote({
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: slippageToleranceBps,
        originAsset: USDC_NEAR_ASSET,
        depositType: "INTENTS",
        destinationAsset,
        amount: amount.toString(),
        refundTo: recipient,
        refundType: "INTENTS",
        recipient,
        recipientType: "INTENTS",
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    // Quote one real slice, plus a $100 reference quote at the same moment.
    const [r, ref] = await Promise.all([request(sampleIn), request(REFERENCE_QUOTE_USDC)]);
    // fetchOneClickQuote validates amounts and provider timestamps before returning live data.
    if (r.live && ref.live && r.quote && ref.quote) {
      // Remaining equal slices are scaled from the live slice quote.
      const scale = (v: bigint) => (v * totalIn) / sampleIn;
      const out = scale(BigInt(r.quote.amountOut));
      const minOut = scale(BigInt(r.quote.minAmountOut));
      const inUsd = (Number(r.quote.amountInUsd) * Number(totalIn)) / Number(sampleIn);
      const outUsd = (Number(r.quote.amountOutUsd) * Number(totalIn)) / Number(sampleIn);
      const sliceRate = Number(r.quote.amountOut) / Number(sampleIn);
      const refRate = Number(ref.quote.amountOut) / Number(REFERENCE_QUOTE_USDC);
      return {
        ...base,
        source: "1click-live",
        validForAuthorization: true,
        amountOut: out.toString(),
        minAmountOut: minOut.toString(),
        amountInUsd: inUsd,
        amountOutUsd: outUsd,
        amountOutFormatted: formatUnits(out, destinationDecimals),
        appFeeBps: r.appFeeBps,
        priceImpactBps: Math.max(0, round2(((refRate - sliceRate) / refRate) * 10_000)),
        totalCostBps: round2(((inUsd - outUsd) / inUsd) * 10_000),
        quoteSignature: r.quoteSignature,
        correlationId: r.correlationId,
      };
    }
    liveError = r.error ?? ref.error ?? "live quote or reference contains invalid amounts";
  }

  const inPrice = tokenInfo(tokens, USDC_NEAR_ASSET)?.price ?? 1;
  const outPrice = tokenInfo(tokens, destinationAsset)?.price ?? 1;
  const inUsd = (Number(totalIn) / 10 ** USDC_DECIMALS) * inPrice;
  const impact = localImpactBps(inUsd / slices);
  const outUsd = inUsd * (1 - (impact + LOCAL_SPREAD_BPS) / 10_000);
  const out = BigInt(Math.floor((outUsd / outPrice) * 10 ** Math.min(destinationDecimals, 15))) * pow10(Math.max(0, destinationDecimals - 15));
  const minOut = (out * BigInt(10_000 - slippageToleranceBps)) / 10_000n;
  return {
    ...base,
    source: "local-fallback",
    validForAuthorization: !args.live,
    amountOut: out.toString(),
    minAmountOut: minOut.toString(),
    amountInUsd: inUsd,
    amountOutUsd: outUsd,
    amountOutFormatted: formatUnits(out, destinationDecimals),
    appFeeBps: 0,
    priceImpactBps: impact,
    totalCostBps: round2(impact + LOCAL_SPREAD_BPS),
    liveError,
  };
}


const evidence = new Map<string, { hash: string; recipient: string; live: boolean; valid: boolean; at: number }>();
const MAX_EVIDENCE = 2000;
const MAX_AGE_MS = 120000;

export async function quoteLeg(args: Parameters<typeof fetchLegQuote>[0]): Promise<LegQuote> {
  const quote = await fetchLegQuote(args);
  const evidenceId = bytesToHex(randomBytes(24));
  const result = { ...quote, evidenceId };
  evidence.set(evidenceId, { hash: hashObject(result), recipient: args.recipient, live: args.live, valid: quote.validForAuthorization, at: Date.now() });
  for (const [id, record] of evidence) {
    if (Date.now() - record.at > MAX_AGE_MS || evidence.size > MAX_EVIDENCE) evidence.delete(id);
    else break;
  }
  return result;
}

/** No receipt registration API is exposed. The expected identity comes from the orchestrator. */
export function verifyQuoteEvidence(quote: LegQuote, expectedRecipient: string, allowOffline: boolean, nowMs: number): boolean {
  const record = evidence.get(quote.evidenceId);
  return Boolean(record && record.valid && record.recipient === expectedRecipient && (record.live || allowOffline) && nowMs >= record.at - 5000 && nowMs - record.at <= MAX_AGE_MS && record.hash === hashObject(quote));
}
