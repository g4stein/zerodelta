/**
 * Agent 3 — Deterministic Risk Policy Guard.
 *
 * The guard is pure, deterministic code (no LLM). It recomputes every number
 * itself from the executable plan, the decrypted order slices, the signed
 * NEP-413 intent and the TEE attestation, then either:
 *   - APPROVES: emits a signed approval and the NEAR Chain Signatures `sign`
 *     request for the hedge leg (v1.signer-prod.testnet), or
 *   - REJECTS: emits a signed rejection proof listing the violated invariants.
 *
 * Invariants:
 *   1. Delta neutrality   |Σ deltaUsd| / treasuryUsd           <= 0.02
 *   2. Leverage ceiling   Σ |notional(spot, perp)| / collateral <= 3.0
 *   3. Slippage ceiling   max price impact (bps)                <= 25
 *   4. TEE attestation    signature, measurement, key, binding, freshness
 *   5. NEP-413 signature  ed25519 valid, recipient, signer, deadline
 *   6. Envelope integrity every slice decrypts, matches commitment and sums to the order
 */
import nacl from "tweetnacl";
import { keyToImplicitAddress } from "near-api-js";
import { verifyNep413, INTENTS_CONTRACT, type IntentMessage } from "../near/nep413";
import { MPC_CONTRACT } from "../near/rpcClient";
import { EXPECTED_SOLVER_MEASUREMENT, computeReportData, verifyAttestation, type AttestationVerification } from "../crypto/attestation";
import { bytesToHex, canonicalJson, fromBase64, hashObject, hexToBytes, keccak256Hex, sha256Hex } from "../crypto/encoding";
import type { OrderSlice, SolverResult } from "./solverAgent";
import { PAIRS, USDC_NEAR_ASSET, type RebalancePlan } from "../swarm/types";

export const RISK_POLICY = {
  maxNetDeltaRatio: 0.02,
  maxLeverage: 3.0,
  maxSlippageBps: 25,
  attestationMaxAgeMs: 5 * 60_000,
} as const;

export const GUARDIAN_NEAR_ACCOUNT = "zerodelta-guardian.testnet";
export const HEDGE_DERIVATION_PATH = "zerodelta/hedge/arbitrum";

export type CheckId =
  | "DELTA_NEUTRALITY"
  | "LEVERAGE_CEILING"
  | "SLIPPAGE_CEILING"
  | "TEE_ATTESTATION"
  | "NEP413_SIGNATURE"
  | "ENVELOPE_INTEGRITY";

export interface PolicyCheck {
  id: CheckId;
  label: string;
  pass: boolean;
  observed: string;
  threshold: string;
  formula: string;
  detail?: string;
}

export interface RiskMetrics {
  treasuryUsd: number;
  spotLongUsd: number;
  perpShortUsd: number;
  perpLongUsd: number;
  netDeltaUsd: number;
  netDeltaRatio: number;
  totalNotionalUsd: number;
  collateralUsd: number;
  leverage: number;
  maxPriceImpactBps: number;
}

export interface MpcSignRequest {
  contractId: typeof MPC_CONTRACT;
  methodName: "sign";
  args: { request: { payload_v2: { Ecdsa: string }; path: string; domain_id: 0 } };
  attachedDepositYocto: "1";
  gas: "300000000000000";
  hedgeOrder: Record<string, unknown>;
  predecessor: string;
  status: "PREPARED_NOT_BROADCAST";
}

export interface GuardianDecision {
  decision: "APPROVED" | "REJECTED";
  checks: PolicyCheck[];
  metrics: RiskMetrics;
  attestation: AttestationVerification;
  violations: CheckId[];
  decisionRecord: Record<string, unknown>;
  decisionHash: string;
  guardianPublicKey: string;
  guardianSignature: string;
  mpcSignRequest: MpcSignRequest | null;
  decidedAt: string;
}

export interface GuardianIdentity {
  signKeyPair: nacl.SignKeyPair;
  boxKeyPair: nacl.BoxKeyPair;
  publicKeyHex: string;
  boxPublicKeyHex: string;
}

let guardianIdentity: GuardianIdentity | undefined;
export function getGuardianIdentity(): GuardianIdentity {
  if (!guardianIdentity) {
    const signKeyPair = nacl.sign.keyPair();
    const boxKeyPair = nacl.box.keyPair();
    guardianIdentity = {
      signKeyPair,
      boxKeyPair,
      publicKeyHex: bytesToHex(signKeyPair.publicKey),
      boxPublicKeyHex: bytesToHex(boxKeyPair.publicKey),
    };
  }
  return guardianIdentity;
}

const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`;
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function computeRiskMetrics(plan: RebalancePlan, maxPriceImpactBps: number): RiskMetrics {
  const sum = (pred: (l: RebalancePlan["legs"][number]) => boolean) =>
    plan.legs.filter(pred).reduce((s, l) => s + l.notionalUsd, 0);
  const spotLongUsd = sum((l) => l.kind === "SPOT" && l.side === "LONG");
  const perpShortUsd = sum((l) => l.kind === "PERP" && l.side === "SHORT");
  const perpLongUsd = sum((l) => l.kind === "PERP" && l.side === "LONG");
  const netDeltaUsd = plan.legs.reduce((s, l) => s + l.deltaUsd, 0);
  const totalNotionalUsd = sum((l) => l.kind === "SPOT" || l.kind === "PERP");
  const collateralUsd = plan.treasuryUsd;
  return {
    treasuryUsd: plan.treasuryUsd,
    spotLongUsd,
    perpShortUsd,
    perpLongUsd,
    netDeltaUsd,
    netDeltaRatio: Math.abs(netDeltaUsd) / plan.treasuryUsd,
    totalNotionalUsd,
    collateralUsd,
    leverage: totalNotionalUsd / collateralUsd,
    maxPriceImpactBps,
  };
}

/** Pure numeric invariants (1–3). Exposed separately so boundaries are easy to test. */
export function evaluateRiskInvariants(m: Pick<RiskMetrics, "netDeltaRatio" | "leverage" | "maxPriceImpactBps">) {
  return {
    deltaNeutral: m.netDeltaRatio <= RISK_POLICY.maxNetDeltaRatio,
    leverageOk: m.leverage <= RISK_POLICY.maxLeverage,
    slippageOk: m.maxPriceImpactBps <= RISK_POLICY.maxSlippageBps,
  };
}

function checkEnvelope(solver: SolverResult, guardian: GuardianIdentity): { pass: boolean; detail: string } {
  const env = solver.envelope;
  const spotQuote = solver.quotes.find((q) => q.legId === "spot-long");
  const spotAsset = PAIRS[solver.executablePlan.pair].spotAssetId;
  try {
    const decrypted: OrderSlice[] = env.slices.map((s) => {
      const opened = nacl.box.open(
        fromBase64(s.ciphertext),
        fromBase64(s.nonce),
        hexToBytes(env.enclaveBoxPublicKey),
        guardian.boxKeyPair.secretKey,
      );
      if (!opened) throw new Error(`slice ${s.index} failed authenticated decryption`);
      if (sha256Hex(opened) !== s.commitment) throw new Error(`slice ${s.index} commitment mismatch`);
      return JSON.parse(new TextDecoder().decode(opened)) as OrderSlice;
    });
    const total = decrypted.reduce((s, x) => s + BigInt(x.amountIn), 0n);
    if (!spotQuote || total.toString() !== spotQuote.amountIn) throw new Error("slices do not sum to the quoted spot order");
    if (decrypted.some((x) => x.destinationAsset !== spotAsset)) throw new Error("slice destination differs from plan asset");
    const { envelopeHash, envelopeId, ...body } = env;
    if (hashObject(body) !== envelopeHash) throw new Error("envelope hash mismatch");
    return { pass: true, detail: `${decrypted.length} slices decrypted; commitments and totals match (${envelopeId})` };
  } catch (err) {
    return { pass: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkIntent(solver: SolverResult): { pass: boolean; detail: string } {
  const v = verifyNep413(solver.intent.signed);
  if (!v.valid) return { pass: false, detail: `ed25519 verification failed${v.reason ? `: ${v.reason}` : ""}` };
  const p = solver.intent.signed.payload;
  if (p.recipient !== INTENTS_CONTRACT) return { pass: false, detail: `recipient must be ${INTENTS_CONTRACT}` };
  let msg: IntentMessage;
  try {
    msg = JSON.parse(p.message) as IntentMessage;
  } catch {
    return { pass: false, detail: "intent message is not JSON" };
  }
  if (msg.signer_id !== keyToImplicitAddress(solver.intent.signed.public_key)) {
    return { pass: false, detail: "signer_id is not the implicit account of the signing key" };
  }
  if (new Date(msg.deadline).getTime() <= Date.now()) return { pass: false, detail: "intent deadline has passed" };
  const diff = msg.intents.find((i) => i.intent === "token_diff");
  const usdcOut = solver.quotes.reduce((s, q) => s + BigInt(q.amountIn), 0n);
  if (!diff || diff.intent !== "token_diff" || diff.diff[USDC_NEAR_ASSET] !== `-${usdcOut}`) {
    return { pass: false, detail: "token_diff does not match quoted USDC spend" };
  }
  return { pass: true, detail: "tweetnacl + near-api-js both verify; recipient, signer and deadline valid" };
}

export function runGuardianAgent(input: {
  runId: string;
  solver: SolverResult;
  trustedMeasurements?: string[];
  trustedEnclaveKeys: string[];
  now?: Date;
}): GuardianDecision {
  const { solver } = input;
  const guardian = getGuardianIdentity();
  const now = input.now ?? new Date();
  const m = computeRiskMetrics(solver.executablePlan, solver.maxPriceImpactBps);
  const inv = evaluateRiskInvariants(m);

  const attestation = verifyAttestation(solver.attestation, {
    trustedMeasurements: input.trustedMeasurements ?? [EXPECTED_SOLVER_MEASUREMENT],
    trustedEnclaveKeys: input.trustedEnclaveKeys,
    expectedReportData: computeReportData({
      envelopeHash: solver.envelope.envelopeHash,
      intentPayloadHash: solver.intent.payloadHashHex,
      planHash: hashObject(solver.executablePlan),
    }),
    now,
    maxAgeMs: RISK_POLICY.attestationMaxAgeMs,
  });
  const attFailures = Object.entries(attestation)
    .filter(([k, v]) => typeof v === "boolean" && k !== "valid" && !v)
    .map(([k]) => k);
  const intentCheck = checkIntent(solver);
  const envCheck = checkEnvelope(solver, guardian);

  const checks: PolicyCheck[] = [
    {
      id: "DELTA_NEUTRALITY",
      label: "Delta neutrality",
      pass: inv.deltaNeutral,
      observed: `${fmtPct(m.netDeltaRatio)} (${fmtUsd(m.netDeltaUsd)})`,
      threshold: `<= ${fmtPct(RISK_POLICY.maxNetDeltaRatio)}`,
      formula: "|Σ leg delta USD| / treasury USD",
      detail: `spot long ${fmtUsd(m.spotLongUsd)}, perp short ${fmtUsd(m.perpShortUsd)}, perp long ${fmtUsd(m.perpLongUsd)}`,
    },
    {
      id: "LEVERAGE_CEILING",
      label: "Leverage ceiling",
      pass: inv.leverageOk,
      observed: `${m.leverage.toFixed(2)}x`,
      threshold: `<= ${RISK_POLICY.maxLeverage.toFixed(1)}x`,
      formula: "Σ |spot + perp notional| / collateral USD",
      detail: `notional ${fmtUsd(m.totalNotionalUsd)} on collateral ${fmtUsd(m.collateralUsd)}`,
    },
    {
      id: "SLIPPAGE_CEILING",
      label: "Slippage ceiling",
      pass: inv.slippageOk,
      observed: `${m.maxPriceImpactBps.toFixed(2)} bps`,
      threshold: `<= ${RISK_POLICY.maxSlippageBps} bps`,
      formula: "max over legs of (refRate - sliceRate) / refRate, refRate = live $100 quote",
      detail: solver.quotes
        .map((q) => `${q.legId}: ${q.priceImpactBps} bps slippage, ${q.totalCostBps} bps all-in cost incl. ${q.appFeeBps} bps fee (${q.source})`)
        .join("; "),
    },
    {
      id: "TEE_ATTESTATION",
      label: "TEE attestation",
      pass: attestation.valid,
      observed: attestation.valid ? "valid" : `failed: ${attFailures.join(", ")}`,
      threshold: "signature + measurement + key + report-data binding + age <= 5 min",
      formula: "ed25519_verify(enclaveKey, sha256(report)) AND measurement in allowlist",
      detail: `measurement ${solver.attestation.report.measurement.slice(0, 16)}…, age ${attestation.ageMs} ms`,
    },
    {
      id: "NEP413_SIGNATURE",
      label: "NEP-413 intent signature",
      pass: intentCheck.pass,
      observed: intentCheck.pass ? "verified" : "invalid",
      threshold: "valid ed25519 over sha256(borsh(payload))",
      formula: "ed25519_verify(pk, sha256(borsh(2^31+413, msg, nonce, recipient)))",
      detail: intentCheck.detail,
    },
    {
      id: "ENVELOPE_INTEGRITY",
      label: "Confidential envelope integrity",
      pass: envCheck.pass,
      observed: envCheck.pass ? "intact" : "tampered",
      threshold: "all slices decrypt and match commitments",
      formula: "sha256(nacl.box.open(slice)) == commitment AND Σ slices == order",
      detail: envCheck.detail,
    },
  ];

  const violations = checks.filter((c) => !c.pass).map((c) => c.id);
  const decision = violations.length === 0 ? "APPROVED" : "REJECTED";
  const decidedAt = now.toISOString();
  const decisionRecord = {
    runId: input.runId,
    decision,
    planHash: solver.planHash,
    intentPayloadHash: solver.intent.payloadHashHex,
    attestationReportHash: solver.attestation.reportHash,
    policy: RISK_POLICY,
    checks: checks.map(({ id, pass, observed, threshold }) => ({ id, pass, observed, threshold })),
    decidedAt,
  };
  const decisionHash = hashObject(decisionRecord);
  const guardianSignature = bytesToHex(nacl.sign.detached(hexToBytes(decisionHash), guardian.signKeyPair.secretKey));

  let mpcSignRequest: MpcSignRequest | null = null;
  if (decision === "APPROVED") {
    const hedge = solver.executablePlan.legs.find((l) => l.kind === "PERP");
    const hedgeOrder = {
      venue: "Hyperliquid",
      market: hedge?.asset,
      side: hedge?.side,
      notionalUsd: Math.round((hedge?.notionalUsd ?? 0) * 100) / 100,
      planHash: solver.planHash,
      intentPayloadHash: solver.intent.payloadHashHex,
      decisionHash,
    };
    mpcSignRequest = {
      contractId: MPC_CONTRACT,
      methodName: "sign",
      args: {
        request: { payload_v2: { Ecdsa: keccak256Hex(canonicalJson(hedgeOrder)) }, path: HEDGE_DERIVATION_PATH, domain_id: 0 },
      },
      attachedDepositYocto: "1",
      gas: "300000000000000",
      hedgeOrder,
      predecessor: GUARDIAN_NEAR_ACCOUNT,
      status: "PREPARED_NOT_BROADCAST",
    };
  }

  return {
    decision,
    checks,
    metrics: m,
    attestation,
    violations,
    decisionRecord,
    decisionHash,
    guardianPublicKey: guardian.publicKeyHex,
    guardianSignature,
    mpcSignRequest,
    decidedAt,
  };
}

/** Anyone holding the guardian public key can verify an approval / rejection proof. */
export function verifyGuardianDecision(d: Pick<GuardianDecision, "decisionRecord" | "decisionHash" | "guardianPublicKey" | "guardianSignature">): boolean {
  if (hashObject(d.decisionRecord) !== d.decisionHash) return false;
  try {
    return nacl.sign.detached.verify(hexToBytes(d.decisionHash), hexToBytes(d.guardianSignature), hexToBytes(d.guardianPublicKey));
  } catch {
    return false;
  }
}
