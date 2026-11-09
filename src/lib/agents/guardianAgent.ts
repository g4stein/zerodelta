/**
 * Agent 3 — Deterministic Risk Policy Guard.
 *
 * The guard is pure, deterministic code (no LLM). It recomputes every number
 * itself from the executable plan, the decrypted order slices, the signed
 * NEP-413 intent and the TEE attestation, then either:
 *   - APPROVES: emits a signed approval and the `record_rebalance` call for the
 *     on-chain Risk Guard contract, which re-checks everything and only then
 *     calls `v1.signer-prod.testnet.sign` itself (guard-gated MPC), or
 *   - REJECTS: emits a signed rejection proof listing the violated invariants.
 *
 * Invariants:
 *   1. Delta neutrality   |Σ deltaUsd| / treasuryUsd           <= 0.02
 *   2. Leverage ceiling   Σ |notional(spot, perp)| / collateral <= 3.0
 *   3. Slippage ceiling   max price impact (bps)                <= 25
 *   4. TEE attestation    signature, measurement, key, binding, freshness
 *   5. NEP-413 signature  ed25519 valid, recipient, signer, deadline
 *   6. Envelope integrity every slice decrypts, matches commitment and sums to the order
 *   7. Order-to-payload   treasury + pair match the orchestrator's request (not the solver's
 *      binding            word), raw legs re-derived from the plan == the solver's order, and
 *                         keccak256(canonical order) == the payload MPC would sign
 *   8. Anti-replay +      nonce not previously approved, above the contract's last_nonce, and
 *      guard-gated MPC    no older than 5 minutes; the sign request is routed via the contract
 */
import nacl from "tweetnacl";
import { keyToImplicitAddress } from "near-api-js";
import { verifyNep413, INTENTS_CONTRACT, type IntentMessage } from "../near/nep413";
import { HEDGE_DERIVATION_PATH as PATH, MPC_SIGNER_CONTRACT, RISK_GUARD_CONTRACT_ID, SOLVER_ACCOUNT_ID } from "../near/deployment";
import { computeHedgePayloadHex, computeOrderMetrics, orderParamsFromPlan, sameOrder, type OrderParams } from "../near/orderCommitment";
import { EXPECTED_SOLVER_MEASUREMENT, computeReportData, verifyAttestation, type AttestationVerification } from "../crypto/attestation";
import { bytesToHex, fromBase64, hashObject, hexToBytes, sha256Hex } from "../crypto/encoding";
import type { OrderSlice, SolverResult } from "./solverAgent";
import { PAIRS, USDC_NEAR_ASSET, type PairId, type RebalancePlan } from "../swarm/types";

export const RISK_POLICY = {
  maxNetDeltaRatio: 0.02,
  maxLeverage: 3.0,
  maxSlippageBps: 25,
  attestationMaxAgeMs: 5 * 60_000,
} as const;

/**
 * The Risk Guard contract account. Because the contract itself calls the MPC signer,
 * it is the `predecessor` the hedge key is derived from (see testnet-proof.json).
 */
export const GUARDIAN_NEAR_ACCOUNT = RISK_GUARD_CONTRACT_ID;
export const HEDGE_DERIVATION_PATH = PATH;

export type CheckId =
  | "DELTA_NEUTRALITY"
  | "LEVERAGE_CEILING"
  | "SLIPPAGE_CEILING"
  | "TEE_ATTESTATION"
  | "NEP413_SIGNATURE"
  | "ENVELOPE_INTEGRITY"
  | "ORDER_PAYLOAD_BINDING"
  | "REPLAY_AND_MPC_GATE";

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

/** Arguments of the contract's `record_rebalance` method (snake_case, as on-chain). */
export interface RebalanceCallArgs {
  rebalance: {
    run_id: string;
    order: OrderParams;
    hedge_order_payload_hex: string;
    plan_hash: string;
    intent_payload_hash: string;
    attestation_report_hash: string;
    decision_hash: string;
  };
  request_mpc_sign: true;
}

/** The only authorised path to an MPC signature: through the Risk Guard contract. */
export interface MpcSignRequest {
  contractId: string;
  methodName: "record_rebalance";
  signerId: string;
  args: RebalanceCallArgs;
  attachedDepositYocto: "1";
  gas: "300000000000000";
  /** What the contract will call after its own checks pass. */
  forwardsTo: {
    contractId: string;
    methodName: "sign";
    args: { request: { payload_v2: { Ecdsa: string }; path: string; domain_id: 0 } };
    predecessor: string;
  };
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
    if (!spotQuote) throw new Error("no spot quote to compare slices against");
    if (total.toString() !== spotQuote.amountIn) {
      const usdc = (v: bigint | string) => (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
      throw new Error(`slices spend ${usdc(total)} USDC but the quoted spot order is ${usdc(spotQuote.amountIn)} USDC`);
    }
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

/**
 * Nonces this guardian has approved (process memory, bounded). Exact-match lookup, not
 * "highest so far": concurrent runs can finish out of order and must not reject each other.
 * The contract additionally requires strictly increasing nonces, so on-chain submission
 * must be sequential in nonce order.
 */
const APPROVED_NONCE_CAP = 10_000;
const approvedNonces = new Set<number>();
function rememberApprovedNonce(nonce: number) {
  approvedNonces.add(nonce);
  if (approvedNonces.size > APPROVED_NONCE_CAP) {
    const oldest = approvedNonces.values().next().value;
    if (oldest !== undefined) approvedNonces.delete(oldest);
  }
}
/** Orders older than this (by nonce timestamp, nonce = ms × 1000) are stale. */
export const ORDER_MAX_AGE_MS = 5 * 60_000;

/** Values the guardian takes from the orchestrator / user, never from the solver. */
export interface TrustedRunInputs {
  treasuryUsd: number;
  pair: PairId;
}

function checkBinding(solver: SolverResult, expected?: TrustedRunInputs): { pass: boolean; detail: string; expectedPayloadHex: string; recomputed: OrderParams } {
  let recomputed: OrderParams;
  try {
    recomputed = orderParamsFromPlan(solver.executablePlan, solver.maxPriceImpactBps, solver.order.nonce);
  } catch (err) {
    // Hostile input (unsafe integers, bad nonce) must be rejected, never crash the guard.
    return { pass: false, expectedPayloadHex: "", recomputed: solver.order, detail: `INVALID_ORDER: ${err instanceof Error ? err.message : String(err)}` };
  }
  const expectedPayloadHex = computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, recomputed);
  const metrics = computeOrderMetrics(recomputed);
  if (expected && solver.executablePlan.treasuryUsd !== expected.treasuryUsd) {
    return { pass: false, expectedPayloadHex, recomputed, detail: `TREASURY_MISMATCH: solver plan says $${solver.executablePlan.treasuryUsd}, request says $${expected.treasuryUsd}` };
  }
  if (expected && (solver.executablePlan.pair !== expected.pair || solver.order.asset_symbol !== PAIRS[expected.pair].perpSymbol)) {
    return { pass: false, expectedPayloadHex, recomputed, detail: `ASSET_MISMATCH: solver used ${solver.order.asset_symbol}/${solver.executablePlan.pair}, request is ${expected.pair}` };
  }
  if (!sameOrder(recomputed, solver.order)) {
    return { pass: false, expectedPayloadHex, recomputed, detail: "solver's order legs differ from the legs re-derived from its own plan" };
  }
  if (solver.commitmentContractId !== RISK_GUARD_CONTRACT_ID) {
    return { pass: false, expectedPayloadHex, recomputed, detail: `payload committed to ${solver.commitmentContractId}, expected ${RISK_GUARD_CONTRACT_ID}` };
  }
  if (solver.hedgeOrderPayloadHex !== expectedPayloadHex) {
    return {
      pass: false,
      expectedPayloadHex,
      recomputed,
      detail: `PAYLOAD_COMMITMENT_MISMATCH: payload ${solver.hedgeOrderPayloadHex.slice(0, 12)}… != keccak256(order) ${expectedPayloadHex.slice(0, 12)}…`,
    };
  }
  return {
    pass: true,
    expectedPayloadHex,
    recomputed,
    detail: `keccak256(order) = ${expectedPayloadHex.slice(0, 16)}…; contract math: ${metrics.net_delta_bps} bps delta, ${metrics.leverage_x100 / 100}x`,
  };
}

function checkReplay(nonce: number, lastAcceptedNonce: number, now: Date): { pass: boolean; detail: string } {
  if (!Number.isSafeInteger(nonce) || nonce <= 0) return { pass: false, detail: "nonce must be a positive safe integer (u64)" };
  if (approvedNonces.has(nonce)) return { pass: false, detail: `NONCE_ALREADY_USED: ${nonce} was already approved by this guard` };
  const ageMs = now.getTime() - Math.floor(nonce / 1000);
  if (ageMs > ORDER_MAX_AGE_MS) return { pass: false, detail: `STALE_ORDER: nonce timestamp is ${Math.round(ageMs / 1000)} s old (max ${ORDER_MAX_AGE_MS / 1000} s)` };
  if (ageMs < -60_000) return { pass: false, detail: "FUTURE_NONCE: nonce timestamp is more than 60 s in the future" };
  if (nonce <= lastAcceptedNonce) return { pass: false, detail: `NONCE_ALREADY_USED: ${nonce} <= on-chain last_nonce ${lastAcceptedNonce}` };
  return {
    pass: true,
    detail: `nonce ${nonce} > on-chain ${lastAcceptedNonce}; MPC request routed via ${RISK_GUARD_CONTRACT_ID}.record_rebalance (predecessor = contract)`,
  };
}

export function runGuardianAgent(input: {
  runId: string;
  solver: SolverResult;
  trustedMeasurements?: string[];
  trustedEnclaveKeys: string[];
  /** Last nonce accepted by the deployed contract (0 offline). */
  lastAcceptedNonce?: number;
  /** Treasury and pair from the request; when given, the solver's plan must match them. */
  expected?: TrustedRunInputs;
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
      hedgeOrderPayloadHex: solver.hedgeOrderPayloadHex,
    }),
    now,
    maxAgeMs: RISK_POLICY.attestationMaxAgeMs,
  });
  const attFailures = Object.entries(attestation)
    .filter(([k, v]) => typeof v === "boolean" && k !== "valid" && !v)
    .map(([k]) => k);
  const intentCheck = checkIntent(solver);
  const envCheck = checkEnvelope(solver, guardian);
  const binding = checkBinding(solver, input.expected);
  const replay = checkReplay(solver.order.nonce, input.lastAcceptedNonce ?? 0, now);

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
    {
      id: "ORDER_PAYLOAD_BINDING",
      label: "Order-to-payload binding",
      pass: binding.pass,
      observed: binding.pass ? "bound" : "spoofed",
      threshold: "trusted treasury/pair; payload == keccak256(raw legs)",
      formula: "keccak256(domain|contract|asset|treasury|spot|short|long|collateral|slip|nonce)",
      detail: binding.detail,
    },
    {
      id: "REPLAY_AND_MPC_GATE",
      label: "Anti-replay + guard-gated MPC",
      pass: replay.pass,
      observed: replay.pass ? `nonce ${solver.order.nonce}` : "replay",
      threshold: "nonce > last accepted",
      formula: "nonce unused, > on-chain last_nonce, age <= 5 min; sign only via contract",
      detail: replay.detail,
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
    hedgeOrderPayloadHex: solver.hedgeOrderPayloadHex,
    orderNonce: solver.order.nonce,
    policy: RISK_POLICY,
    checks: checks.map(({ id, pass, observed, threshold }) => ({ id, pass, observed, threshold })),
    decidedAt,
  };
  const decisionHash = hashObject(decisionRecord);
  const guardianSignature = bytesToHex(nacl.sign.detached(hexToBytes(decisionHash), guardian.signKeyPair.secretKey));

  let mpcSignRequest: MpcSignRequest | null = null;
  if (decision === "APPROVED") {
    rememberApprovedNonce(solver.order.nonce);
    mpcSignRequest = {
      contractId: RISK_GUARD_CONTRACT_ID,
      methodName: "record_rebalance",
      signerId: SOLVER_ACCOUNT_ID,
      args: {
        rebalance: {
          run_id: input.runId,
          order: solver.order,
          hedge_order_payload_hex: solver.hedgeOrderPayloadHex,
          plan_hash: solver.planHash,
          intent_payload_hash: solver.intent.payloadHashHex,
          attestation_report_hash: solver.attestation.reportHash,
          decision_hash: decisionHash,
        },
        request_mpc_sign: true,
      },
      attachedDepositYocto: "1",
      gas: "300000000000000",
      forwardsTo: {
        contractId: MPC_SIGNER_CONTRACT,
        methodName: "sign",
        args: { request: { payload_v2: { Ecdsa: solver.hedgeOrderPayloadHex }, path: HEDGE_DERIVATION_PATH, domain_id: 0 } },
        predecessor: RISK_GUARD_CONTRACT_ID,
      },
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
