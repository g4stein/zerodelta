/**
 * On-chain layer for the deployed ZeroDelta Risk Guard contract on NEAR testnet.
 *
 * - Converts guardian metrics to the contract's integer units.
 * - Reads the live contract (policy, attestations, free `check_rebalance` view).
 * - Re-verifies the proof transactions in `testnet-proof.json` against a NEAR
 *   archival RPC (`tx` method with `wait_until: FINAL`), so old transactions stay
 *   checkable after regular nodes garbage-collect them.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import proofJson from "../../../testnet-proof.json";
import { fetchWithTimeout, nearRpc, viewFunction, MPC_CONTRACT } from "./rpcClient";
import { fromBase58, hexToBytes } from "../crypto/encoding";
import type { RiskMetrics } from "../agents/guardianAgent";

export const NEARBLOCKS_TESTNET = "https://testnet.nearblocks.io";
export const TESTNET_ARCHIVAL_RPC = ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];

export type ProofTxKind = "DEPLOY_AND_REGISTER_POLICY" | "RECORD_APPROVED_REBALANCE" | "ROGUE_REBALANCE_REJECTED" | "MPC_SIGN_HEDGE";

export interface ProofTx {
  kind: ProofTxKind;
  label: string;
  hash: string;
  signerId: string;
  receiverId: string;
  methodName: string;
  /** "success" = transaction must succeed; "failure" = must fail with `expectedError`. */
  expect: "success" | "failure";
  expectedError?: string;
  blockHash?: string;
  explorerUrl: string;
  summary: string;
}

export interface TestnetProof {
  network: "testnet";
  createdAt: string;
  contract: {
    accountId: string;
    codeHash: string;
    wasmPath: string;
    wasmSha256Hex: string;
    sourcePath: string;
    policy: OnchainPolicy;
  };
  accounts: { guard: string; solver: string };
  recordedRebalance: {
    index: number;
    runId: string;
    decisionHash: string;
    planHash: string;
    intentPayloadHash: string;
    attestationReportHash: string;
    metrics: OnchainMetrics;
  };
  rogueAttempt: { metrics: OnchainMetrics; expectedError: string };
  mpcSignature: {
    contractId: string;
    path: string;
    domainId: number;
    payloadHex: string;
    derivedPublicKey: string;
    evmAddress: string;
    signature: { big_r: string; s: string; recovery_id: number } | null;
  };
  transactions: ProofTx[];
}

export interface OnchainPolicy {
  max_delta_bps: number;
  max_leverage_x100: number;
  max_slippage_bps: number;
}

export interface OnchainMetrics {
  net_delta_bps: number;
  leverage_x100: number;
  slippage_bps: number;
}

export const TESTNET_PROOF = proofJson as TestnetProof;
export const RISK_GUARD_CONTRACT = TESTNET_PROOF.contract.accountId;

export const EXPECTED_ONCHAIN_POLICY: OnchainPolicy = { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25 };

export const nearblocksTx = (hash: string) => `${NEARBLOCKS_TESTNET}/txns/${hash}`;
export const nearblocksAccount = (accountId: string) => `${NEARBLOCKS_TESTNET}/address/${accountId}`;

/** Rounds every metric UP so the on-chain check is never looser than the off-chain one. */
export function toOnchainMetrics(m: Pick<RiskMetrics, "netDeltaRatio" | "leverage" | "maxPriceImpactBps">): OnchainMetrics {
  // Contract fields are u32: clamp to >= 0 (also turns -0 into 0). The epsilon absorbs float noise.
  const up = (x: number) => Math.max(0, Math.ceil(x - 1e-9)) + 0;
  return {
    net_delta_bps: up(m.netDeltaRatio * 10_000),
    leverage_x100: up(m.leverage * 100),
    slippage_bps: up(m.maxPriceImpactBps),
  };
}

// ---------------------------------------------------------------------------
// Chain Signatures: verify the MPC network's ECDSA signature offline
// ---------------------------------------------------------------------------

export interface MpcSignatureVerification {
  valid: boolean;
  recoveredMatchesDerivedKey: boolean;
  signatureVerifies: boolean;
  reason?: string;
}

/**
 * Recovers the secp256k1 public key from the MPC signature (big_r, s, recovery_id) over
 * the hedge-order digest and checks it equals the key `derived_public_key` returns for
 * the guard account. Pure local cryptography, no network.
 */
export function verifyMpcSignature(sig: TestnetProof["mpcSignature"]): MpcSignatureVerification {
  const fail = (reason: string) => ({ valid: false, recoveredMatchesDerivedKey: false, signatureVerifies: false, reason });
  if (!sig.signature) return fail("no signature recorded");
  try {
    const r = hexToBytes(sig.signature.big_r.slice(2)); // x-coordinate of the compressed R point
    const s = hexToBytes(sig.signature.s);
    const msg = hexToBytes(sig.payloadHex);
    const recovered = new Uint8Array([sig.signature.recovery_id, ...r, ...s]);
    const pub = secp256k1.recoverPublicKey(recovered, msg, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false).slice(1);
    const expected = fromBase58(sig.derivedPublicKey.replace(/^secp256k1:/, ""));
    const recoveredMatchesDerivedKey = uncompressed.length === expected.length && uncompressed.every((b, i) => b === expected[i]);
    const signatureVerifies = secp256k1.verify(new Uint8Array([...r, ...s]), msg, pub, { prehash: false });
    return { valid: recoveredMatchesDerivedKey && signatureVerifies, recoveredMatchesDerivedKey, signatureVerifies };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Live contract reads
// ---------------------------------------------------------------------------

export interface OnchainAttestation {
  index: number;
  run_id: string;
  pair: string;
  treasury_usd: number;
  net_delta_bps: number;
  leverage_x100: number;
  slippage_bps: number;
  plan_hash: string;
  intent_payload_hash: string;
  attestation_report_hash: string;
  decision_hash: string;
  recorded_by: string;
  block_height: number;
  timestamp_ns: number;
}

export interface OnchainGuardState {
  live: boolean;
  contractId: string;
  explorerUrl: string;
  policy?: OnchainPolicy;
  owner?: string;
  solver?: string;
  attestationCount?: number;
  latest?: OnchainAttestation | null;
  codeHash?: string;
  codeHashMatchesProof?: boolean;
  error?: string;
}

export async function getOnchainGuardState(): Promise<OnchainGuardState> {
  const base = { contractId: RISK_GUARD_CONTRACT, explorerUrl: nearblocksAccount(RISK_GUARD_CONTRACT) };
  const [config, count, account] = await Promise.all([
    viewFunction<[string, string, OnchainPolicy]>("testnet", RISK_GUARD_CONTRACT, "get_config"),
    viewFunction<number>("testnet", RISK_GUARD_CONTRACT, "get_attestation_count"),
    nearRpc<{ code_hash: string }>("testnet", "query", { request_type: "view_account", finality: "final", account_id: RISK_GUARD_CONTRACT }),
  ]);
  if (!config.ok) return { ...base, live: false, error: config.error };
  const attestationCount = count.ok ? count.value : undefined;
  let latest: OnchainAttestation | null = null;
  if (attestationCount && attestationCount > 0) {
    const r = await viewFunction<OnchainAttestation | null>("testnet", RISK_GUARD_CONTRACT, "get_attestation", { index: attestationCount - 1 });
    latest = r.ok ? r.value : null;
  }
  const codeHash = account.ok ? account.result.code_hash : undefined;
  return {
    ...base,
    live: true,
    owner: config.value[0],
    solver: config.value[1],
    policy: config.value[2],
    attestationCount,
    latest,
    codeHash,
    codeHashMatchesProof: codeHash ? codeHash === TESTNET_PROOF.contract.codeHash : undefined,
  };
}

export interface OnchainPolicyCheck {
  live: boolean;
  contractId: string;
  method: "check_rebalance";
  args: OnchainMetrics;
  approved?: boolean;
  violations?: string[];
  blockHeight?: number;
  error?: string;
}

/** Runs the deployed contract's own policy logic (free view call) on a set of metrics. */
export async function checkRebalanceOnchain(metrics: OnchainMetrics): Promise<OnchainPolicyCheck> {
  const base = { contractId: RISK_GUARD_CONTRACT, method: "check_rebalance" as const, args: metrics };
  const r = await viewFunction<{ approved: boolean; violations: string[] }>("testnet", RISK_GUARD_CONTRACT, "check_rebalance", metrics);
  if (!r.ok) return { ...base, live: false, error: r.error };
  return { ...base, live: true, approved: r.value.approved, violations: r.value.violations, blockHeight: r.blockHeight };
}

// ---------------------------------------------------------------------------
// Transaction status verification
// ---------------------------------------------------------------------------

interface RpcTxStatus {
  final_execution_status?: string;
  status: { SuccessValue?: string; Failure?: unknown };
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  transaction_outcome: { block_hash: string };
  receipts_outcome: { outcome: { status: { SuccessValue?: string; Failure?: unknown }; logs: string[] } }[];
}

export interface TxVerification {
  kind: ProofTxKind;
  label: string;
  hash: string;
  explorerUrl: string;
  found: boolean;
  matchesExpectation: boolean;
  onchainStatus: "SUCCESS" | "FAILURE" | "NOT_FOUND";
  signerId?: string;
  receiverId?: string;
  methodName?: string;
  finality?: string;
  returnValue?: string;
  errorMessage?: string;
  logs: string[];
  endpoint?: string;
  detail: string;
}

function decodeSuccessValue(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function extractMethodName(actions: unknown[]): string | undefined {
  for (const a of actions) {
    if (a && typeof a === "object" && "FunctionCall" in a) {
      return (a as { FunctionCall: { method_name: string } }).FunctionCall.method_name;
    }
  }
  return undefined;
}

/** `tx` RPC with `wait_until: FINAL` against archival endpoints, then the regular endpoint. */
export async function fetchTxStatus(hash: string, senderAccountId: string): Promise<{ ok: true; result: RpcTxStatus; endpoint: string } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const endpoint of [...TESTNET_ARCHIVAL_RPC, "https://rpc.testnet.near.org"]) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "zerodelta", method: "tx", params: { tx_hash: hash, sender_account_id: senderAccountId, wait_until: "FINAL" } }),
        },
        12_000,
      );
      const body = (await res.json()) as { result?: RpcTxStatus; error?: { cause?: { name?: string }; message?: string } };
      if (body.result) return { ok: true, result: body.result, endpoint };
      errors.push(`${endpoint}: ${body.error?.cause?.name ?? body.error?.message ?? res.status}`);
    } catch (err) {
      errors.push(`${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: false, error: errors.join("; ") };
}

export async function verifyProofTx(tx: ProofTx): Promise<TxVerification> {
  const base = { kind: tx.kind, label: tx.label, hash: tx.hash, explorerUrl: tx.explorerUrl, logs: [] as string[] };
  const r = await fetchTxStatus(tx.hash, tx.signerId);
  if (!r.ok) {
    return { ...base, found: false, matchesExpectation: false, onchainStatus: "NOT_FOUND", detail: r.error };
  }
  const t = r.result;
  const failed = t.status.Failure !== undefined;
  const errorMessage = failed ? JSON.stringify(t.status.Failure) : undefined;
  const logs = t.receipts_outcome.flatMap((o) => o.outcome.logs);
  const methodName = extractMethodName(t.transaction.actions);
  const partiesOk = t.transaction.signer_id === tx.signerId && t.transaction.receiver_id === tx.receiverId && methodName === tx.methodName;
  const statusOk = tx.expect === "success" ? !failed : failed && Boolean(errorMessage?.includes(tx.expectedError ?? "ZERODELTA_REJECTED"));
  const returnValue = decodeSuccessValue(t.status.SuccessValue);
  return {
    ...base,
    found: true,
    matchesExpectation: partiesOk && statusOk,
    onchainStatus: failed ? "FAILURE" : "SUCCESS",
    signerId: t.transaction.signer_id,
    receiverId: t.transaction.receiver_id,
    methodName,
    finality: t.final_execution_status,
    returnValue,
    errorMessage,
    logs,
    endpoint: r.endpoint,
    detail: !partiesOk
      ? "signer/receiver/method differ from testnet-proof.json"
      : failed
        ? `failed on-chain as expected: ${(errorMessage ?? "").match(/ZERODELTA_REJECTED[^"\\]*/)?.[0] ?? errorMessage}`
        : `succeeded on-chain (${t.final_execution_status ?? "final"})`,
  };
}

let txCache: { at: number; value: TxVerification[] } | null = null;

/** Transactions are immutable once final, so results are cached per server process. */
export async function verifyAllProofTxs(): Promise<TxVerification[]> {
  if (txCache && txCache.value.every((v) => v.found)) return txCache.value;
  const value = await Promise.all(TESTNET_PROOF.transactions.map(verifyProofTx));
  txCache = { at: Date.now(), value };
  return value;
}

export { MPC_CONTRACT };

// ---------------------------------------------------------------------------
// Aggregated status for the dashboard (GET /api/swarm)
// ---------------------------------------------------------------------------

export interface OnchainProofStatus {
  network: "testnet";
  contractId: string;
  contractUrl: string;
  accounts: { guard: string; solver: string; guardUrl: string; solverUrl: string };
  guard: OnchainGuardState;
  transactions: TxVerification[];
  mpcSignature: TestnetProof["mpcSignature"] & { verification: MpcSignatureVerification };
  allVerified: boolean;
}

export async function getOnchainProofStatus(): Promise<OnchainProofStatus> {
  const [guard, transactions] = await Promise.all([getOnchainGuardState(), verifyAllProofTxs()]);
  const verification = verifyMpcSignature(TESTNET_PROOF.mpcSignature);
  return {
    network: "testnet",
    contractId: RISK_GUARD_CONTRACT,
    contractUrl: nearblocksAccount(RISK_GUARD_CONTRACT),
    accounts: {
      guard: TESTNET_PROOF.accounts.guard,
      solver: TESTNET_PROOF.accounts.solver,
      guardUrl: nearblocksAccount(TESTNET_PROOF.accounts.guard),
      solverUrl: nearblocksAccount(TESTNET_PROOF.accounts.solver),
    },
    guard,
    transactions,
    mpcSignature: { ...TESTNET_PROOF.mpcSignature, verification },
    allVerified: transactions.length > 0 && transactions.every((t) => t.matchesExpectation) && verification.valid,
  };
}
