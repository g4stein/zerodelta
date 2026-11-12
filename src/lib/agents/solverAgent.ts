/**
 * Agent 2 — Order Solver (simulated TEE) & NEP-413 Intent Crafter.
 *
 * 1. Prices every on-chain leg with a live NEAR Intents 1Click dry quote
 *    (falls back to a deterministic local quote if the API is unreachable).
 * 2. Sizes the perp hedge to the *quoted* spot fill so net delta is exactly 0.
 * 3. Slices the spot order (equal TWAP) and encrypts each slice to the Risk
 *    Guard's X25519 key with nacl.box. Only ciphertext + SHA-256 commitments
 *    are public, so a mempool observer cannot read size or timing.
 * 4. Builds and signs a NEP-413 `token_diff` intent for `intents.near`.
 * 5. Derives the raw order legs (integer cents) and the 32-byte hedge payload
 *    `keccak256(canonical order)` that the Risk Guard contract will recompute
 *    and that NEAR Chain Signatures will sign, with a fresh anti-replay nonce.
 * 6. Issues a (simulated) TEE attestation binding its code measurement to the
 *    exact intent, envelope, plan and hedge payload.
 *
 * `compromise: "spoofed_metrics"` simulates a hijacked solver: it reports the
 * hedged legs, but its encrypted slices spend the whole treasury and its MPC
 * payload commits to a 10x long. Agent 3 and the contract must catch this.
 */
import nacl from "tweetnacl";
import { quoteLeg, splitAmount } from "../market/quoteService";
import {
  buildIntentMessage,
  generateNonce,
  INTENTS_CONTRACT,
  signNep413,
  type EphemeralSigner,
  type IntentMessage,
  type Nep413SignResult,
} from "../near/nep413";
import { type OneClickTokenFeed } from "../near/rpcClient";
import {
  computeReportData,
  createEnclave,
  signAttestation,
  type Enclave,
  type SignedAttestation,
} from "../crypto/attestation";
import { bytesToHex, canonicalJson, hashObject, hexToBytes, sha256Hex, toBase64, utf8ToBytes } from "../crypto/encoding";
import { PAIRS, USDC_DECIMALS, USDC_NEAR_ASSET, type Leg, type RebalancePlan } from "../swarm/types";
import { computeHedgePayloadHex, nextOrderNonce, orderParamsFromPlan, toCents, type OrderParams } from "../near/orderCommitment";
import { RISK_GUARD_CONTRACT_ID } from "../near/deployment";

export interface LegQuote {
  evidenceId: string;
  legId: string;
  source: "1click-live" | "local-fallback";
  originAsset: string;
  destinationAsset: string;
  slices: number;
  /** Totals across all slices, in smallest units. */
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  amountInUsd: number;
  amountOutUsd: number;
  amountOutFormatted: string;
  appFeeBps: number;
  /**
   * Size-driven slippage: how much worse the slice's rate is than a $100 reference
   * quote taken at the same moment, in bps. Checked by the guard's slippage ceiling.
   */
  priceImpactBps: number;
  /** All-in cost vs 1Click's USD reference price (spread + fee + impact), in bps. */
  totalCostBps: number;
  slippageToleranceBps: number;
  quoteSignature?: string;
  correlationId?: string;
  liveError?: string;
  /** False when a live quote or its independent reference could not be validated. */
  validForAuthorization: boolean;
}

export interface OrderSlice {
  index: number;
  legId: string;
  originAsset: string;
  destinationAsset: string;
  amountIn: string;
  minAmountOut: string;
  releaseAtOffsetSec: number;
}

export interface EncryptedSlice {
  index: number;
  commitment: string; // sha256(canonical(slice))
  nonce: string; // base64, 24 bytes
  ciphertext: string; // base64
}

export interface ConfidentialEnvelope {
  envelopeId: string;
  scheme: "nacl.box x25519-xsalsa20-poly1305";
  enclaveBoxPublicKey: string;
  recipientBoxPublicKey: string;
  sliceCount: number;
  slices: EncryptedSlice[];
  envelopeHash: string;
}

export interface SolverResult {
  executablePlan: RebalancePlan;
  quotes: LegQuote[];
  maxPriceImpactBps: number;
  envelope: ConfidentialEnvelope;
  intent: Nep413SignResult & { message: IntentMessage };
  attestation: SignedAttestation;
  planHash: string;
  signer: { accountId: string; publicKey: string };
  /** Raw order legs submitted to the Risk Guard contract (claimed by the solver). */
  order: OrderParams;
  /** 32-byte payload (hex) the solver asks NEAR Chain Signatures to sign. */
  hedgeOrderPayloadHex: string;
  /** The contract the payload is committed to (domain separation). */
  commitmentContractId: string;
  sliceCount: number;
  compromised: boolean;
  /**
   * Only set in the spoofed_metrics simulation, so the dashboard can show what the attacker
   * really encoded. Agent 3 and the contract never read this field.
   */
  simulationOnlyHiddenOrder?: OrderParams;
}

let solverEnclave: Enclave | undefined;
/** Enclave identity is created once per process, like an enclave booting. */
export function getSolverEnclave(): Enclave {
  solverEnclave ??= createEnclave();
  return solverEnclave;
}

function encryptSlices(
  slices: OrderSlice[],
  enclave: Enclave,
  recipientBoxPublicKey: Uint8Array,
): ConfidentialEnvelope {
  const encrypted: EncryptedSlice[] = slices.map((slice) => {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const plaintext = utf8ToBytes(canonicalJson(slice));
    const box = nacl.box(plaintext, nonce, recipientBoxPublicKey, enclave.boxKeyPair.secretKey);
    return { index: slice.index, commitment: sha256Hex(plaintext), nonce: toBase64(nonce), ciphertext: toBase64(box) };
  });
  const body = {
    scheme: "nacl.box x25519-xsalsa20-poly1305" as const,
    enclaveBoxPublicKey: enclave.boxPublicKeyHex,
    recipientBoxPublicKey: bytesToHex(recipientBoxPublicKey),
    sliceCount: slices.length,
    slices: encrypted,
  };
  const envelopeHash = hashObject(body);
  return { envelopeId: envelopeHash.slice(0, 16), ...body, envelopeHash };
}

export async function runSolverAgent(input: {
  plan: RebalancePlan;
  sliceCount: number;
  tokens: OneClickTokenFeed;
  signer: EphemeralSigner;
  guardianBoxPublicKey: string;
  live: boolean;
  slippageToleranceBps?: number;
  intentTtlMs?: number;
  compromise?: "spoofed_metrics";
}): Promise<SolverResult> {
  const { plan, tokens, signer } = input;
  const cfg = PAIRS[plan.pair];
  const enclave = getSolverEnclave();
  const tolerance = input.slippageToleranceBps ?? 25;
  const spotLeg = plan.legs.find((l) => l.kind === "SPOT");
  const marginLeg = plan.legs.find((l) => l.kind === "MARGIN");
  if (!spotLeg) throw new Error("plan has no spot leg");

  const [spotQuote, marginQuote] = await Promise.all([
    quoteLeg({
      leg: spotLeg,
      destinationAsset: cfg.spotAssetId,
      destinationDecimals: cfg.spotDecimals,
      slices: input.sliceCount,
      tokens,
      recipient: signer.accountId,
      slippageToleranceBps: tolerance,
      live: input.live,
    }),
    marginLeg
      ? quoteLeg({
          leg: marginLeg,
          destinationAsset: marginLeg.assetId!,
          destinationDecimals: USDC_DECIMALS,
          // The margin bridge is TWAP'd with the same slice count, so reslicing lowers its impact too.
          slices: input.sliceCount,
          tokens,
          recipient: signer.accountId,
          slippageToleranceBps: tolerance,
          live: input.live,
        })
      : Promise.resolve(undefined),
  ]);
  const quotes = [spotQuote, ...(marginQuote ? [marginQuote] : [])];

  // Size legs to quoted fills. A hedge short is matched to the spot fill value, so
  // the executable plan is delta-neutral by construction. Unhedged legs pass through.
  const spotFillUsd = spotQuote.amountOutUsd;
  const legs: Leg[] = plan.legs.map((leg) => {
    if (leg.kind === "SPOT") return { ...leg, notionalUsd: spotFillUsd, deltaUsd: spotFillUsd };
    if (leg.kind === "MARGIN" && marginQuote) return { ...leg, notionalUsd: marginQuote.amountOutUsd };
    if (leg.kind === "PERP" && leg.side === "SHORT") return { ...leg, notionalUsd: spotFillUsd, deltaUsd: -spotFillUsd };
    return { ...leg };
  });
  const executablePlan: RebalancePlan = { ...plan, legs };
  const planHash = hashObject(executablePlan);
  const maxPriceImpactBps = Math.max(...quotes.map((q) => q.priceImpactBps));
  const compromised = input.compromise === "spoofed_metrics";

  // Raw order legs + payload commitment (what the contract recomputes and MPC signs).
  const nonce = nextOrderNonce();
  const order = orderParamsFromPlan(executablePlan, maxPriceImpactBps, nonce);
  const hiddenOrder: OrderParams = {
    ...order,
    spot_long_usd_cents: toCents(plan.treasuryUsd),
    perp_short_usd_cents: 0,
    perp_long_usd_cents: toCents(plan.treasuryUsd * 9),
  };
  const hedgeOrderPayloadHex = computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, compromised ? hiddenOrder : order);

  // Equal TWAP slicing of the spot order. A compromised solver quietly slices the whole treasury.
  const spotIn = compromised ? BigInt(Math.round(plan.treasuryUsd)) * 10n ** BigInt(USDC_DECIMALS) : BigInt(spotQuote.amountIn);
  const amountsIn = splitAmount(spotIn, input.sliceCount);
  const minOuts = splitAmount(BigInt(spotQuote.minAmountOut), input.sliceCount);
  const jitterSeed = hexToBytes(sha256Hex(`${plan.planId}:${signer.accountId}`));
  const slices: OrderSlice[] = amountsIn.map((amountIn, i) => ({
    index: i,
    legId: spotLeg.id,
    originAsset: spotQuote.originAsset,
    destinationAsset: spotQuote.destinationAsset,
    amountIn: amountIn.toString(),
    minAmountOut: minOuts[i].toString(),
    releaseAtOffsetSec: i * 30 + (jitterSeed[i % 32] % 15),
  }));
  const envelope = encryptSlices(slices, enclave, hexToBytes(input.guardianBoxPublicKey));

  // NEP-413 intent for intents.near: give USDC, receive spot (+ hedge margin USDC on Arbitrum).
  const usdcOut = quotes.reduce((s, q) => s + BigInt(q.amountIn), 0n);
  const diff: Record<string, string> = { [USDC_NEAR_ASSET]: `-${usdcOut}` };
  for (const q of quotes) diff[q.destinationAsset] = (BigInt(diff[q.destinationAsset] ?? "0") + BigInt(q.minAmountOut)).toString();
  const message: IntentMessage = {
    signer_id: signer.accountId,
    deadline: new Date(Date.now() + (input.intentTtlMs ?? 10 * 60_000)).toISOString(),
    intents: [{ intent: "token_diff", diff }],
  };
  const signed = signNep413(signer.keyPair, {
    message: buildIntentMessage(message),
    nonce: generateNonce(),
    recipient: INTENTS_CONTRACT,
  });

  const reportData = computeReportData({
    envelopeHash: envelope.envelopeHash,
    intentPayloadHash: signed.payloadHashHex,
    planHash,
    hedgeOrderPayloadHex,
    quotesHash: hashObject(quotes),
  });
  const attestation = signAttestation(enclave, reportData);

  return {
    executablePlan,
    quotes,
    maxPriceImpactBps,
    envelope,
    intent: { ...signed, message },
    attestation,
    planHash,
    signer: { accountId: signer.accountId, publicKey: signer.publicKey },
    order,
    hedgeOrderPayloadHex,
    commitmentContractId: RISK_GUARD_CONTRACT_ID,
    sliceCount: input.sliceCount,
    compromised,
    ...(compromised ? { simulationOnlyHiddenOrder: hiddenOrder } : {}),
  };
}
