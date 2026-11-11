/**
 * On-chain layer for the deployed ZeroDelta Risk Guard v2 contract on NEAR testnet.
 *
 * - Reads the live contract (config, attestations, lock status).
 * - Runs the contract's own checks on any order (`check_order_params`, free view).
 * - Re-verifies every proof transaction in `testnet-proof.json` with
 *   `EXPERIMENTAL_tx_status` on a NEAR archival RPC, including the receipt in which
 *   the contract itself (not a person) calls `v1.signer-prod.testnet.sign`.
 * - Recovers the MPC secp256k1 signature offline and checks it belongs to the key
 *   derived for the contract account.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { V2_PROOF_JSON } from "./proofFile";
import { fetchWithTimeout, nearRpc, viewFunction } from "./rpcClient";
import { fromBase58, hexToBytes } from "../crypto/encoding";
import { MPC_SIGNER_CONTRACT, RISK_GUARD_CONTRACT_ID } from "./deployment";
import type { OrderParams } from "./orderCommitment";

export const NEARBLOCKS_TESTNET = "https://testnet.nearblocks.io";
export const TESTNET_ARCHIVAL_RPC = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
export const MPC_CONTRACT = MPC_SIGNER_CONTRACT;

export type ProofTxKind =
  | "DEPLOY_REGISTER_AND_LOCK"
  | "RECORD_AND_SIGN_APPROVED_REBALANCE"
  | "ROGUE_REBALANCE_REJECTED"
  | "PAYLOAD_SWAP_REJECTED"
  | "REPLAY_REJECTED";

export interface ProofTx {
  kind: ProofTxKind;
  label: string;
  hash: string;
  signerId: string;
  receiverId: string;
  methodName: string;
  /** "success" = must succeed; "failure" = must fail with `expectedError`. */
  expect: "success" | "failure";
  expectedError?: string;
  /** A receipt that must exist (used to prove the contract itself called the MPC signer). */
  expectedReceipt?: { predecessorId: string; receiverId: string; methodName: string };
  blockHash?: string;
  explorerUrl: string;
  summary: string;
}

export interface OnchainPolicy {
  max_delta_bps: number;
  max_leverage_x100: number;
  max_slippage_bps: number;
}

export interface MpcSignatureRecord {
  big_r: string;
  s: string;
  recovery_id: number;
}

export interface TestnetProof {
  network: "testnet";
  version: number;
  createdAt: string;
  contract: {
    accountId: string;
    codeHash: string;
    wasmPath: string;
    wasmSha256Hex: string;
    sourcePath: string;
    policy: OnchainPolicy;
    mpcSignerContract: string;
    mpcPath: string;
    locked: boolean;
  };
  accounts: { guard: string; solver: string };
  approvedOrder: {
    index: number;
    runId: string;
    order: OrderParams;
    hedgeOrderPayloadHex: string;
    decisionHash: string;
    planHash: string;
    intentPayloadHash: string;
    attestationReportHash: string;
    contractMetrics: { net_delta_bps: number; leverage_x100: number };
  };
  rogueAttempt: { order: OrderParams; hedgeOrderPayloadHex: string; expectedError: string };
  payloadSwapAttempt: { order: OrderParams; hedgeOrderPayloadHex: string; expectedError: string };
  replayAttempt: { nonce: number; expectedError: string };
  mpcSignature: {
    contractId: string;
    path: string;
    domainId: number;
    payloadHex: string;
    predecessor: string;
    derivedPublicKey: string;
    evmAddress: string;
    signature: MpcSignatureRecord | null;
  };
  transactions: ProofTx[];
  previousDeployment?: { version: number; contract: string; solver: string; note: string; transactions: string[] };
}

/** The v2 proof (now under `previousDeployment` in testnet-proof.json; see proofFile.ts). */
export const TESTNET_PROOF = V2_PROOF_JSON as unknown as TestnetProof;
export const RISK_GUARD_CONTRACT = RISK_GUARD_CONTRACT_ID;
export const EXPECTED_ONCHAIN_POLICY: OnchainPolicy = { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25 };

export const nearblocksTx = (hash: string) => `${NEARBLOCKS_TESTNET}/txns/${hash}`;
export const nearblocksAccount = (accountId: string) => `${NEARBLOCKS_TESTNET}/address/${accountId}`;

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
 * Recovers the secp256k1 public key from (big_r, s, recovery_id) over the payload and
 * checks it equals the key `derived_public_key` returns for the contract account.
 */
export function verifyMpcSignature(sig: Pick<TestnetProof["mpcSignature"], "signature" | "payloadHex" | "derivedPublicKey">): MpcSignatureVerification {
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

export interface OnchainConfig {
  solver: string;
  policy: OnchainPolicy;
  mpc_signer_contract: string;
  mpc_path: string;
  last_nonce: number;
  attestation_count: number;
  version: string;
}

export interface OnchainAttestation {
  index: number;
  run_id: string;
  order: OrderParams;
  net_delta_bps: number;
  leverage_x100: number;
  hedge_order_payload_hex: string;
  plan_hash: string;
  intent_payload_hash: string;
  attestation_report_hash: string;
  decision_hash: string;
  recorded_by: string;
  block_height: number;
  timestamp_ns: number;
  mpc_status: "NotRequested" | "Pending" | "Signed" | "Failed";
  mpc_signature: MpcSignatureRecord | null;
}

export interface OnchainGuardState {
  live: boolean;
  contractId: string;
  explorerUrl: string;
  config?: OnchainConfig;
  policy?: OnchainPolicy;
  solver?: string;
  attestationCount?: number;
  latest?: OnchainAttestation | null;
  codeHash?: string;
  codeHashMatchesProof?: boolean;
  /** True when the contract account has zero access keys: only its own code can act as it. */
  locked?: boolean;
  accessKeyCount?: number;
  error?: string;
}

export async function getAccessKeyCount(accountId: string): Promise<number | undefined> {
  const r = await nearRpc<{ keys: unknown[] }>("testnet", "query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
  return r.ok && Array.isArray(r.result?.keys) ? r.result.keys.length : undefined;
}

export async function getOnchainGuardState(): Promise<OnchainGuardState> {
  const base = { contractId: RISK_GUARD_CONTRACT, explorerUrl: nearblocksAccount(RISK_GUARD_CONTRACT) };
  const [config, account, keyCount] = await Promise.all([
    viewFunction<OnchainConfig>("testnet", RISK_GUARD_CONTRACT, "get_config"),
    nearRpc<{ code_hash: string }>("testnet", "query", { request_type: "view_account", finality: "final", account_id: RISK_GUARD_CONTRACT }),
    getAccessKeyCount(RISK_GUARD_CONTRACT),
  ]);
  if (!config.ok) return { ...base, live: false, error: config.error };
  if (!config.value || typeof config.value !== "object" || !config.value.policy) return { ...base, live: false, error: "malformed get_config response" };
  const count = config.value.attestation_count;
  let latest: OnchainAttestation | null = null;
  if (count > 0) {
    const r = await viewFunction<OnchainAttestation | null>("testnet", RISK_GUARD_CONTRACT, "get_attestation", { index: count - 1 });
    latest = r.ok ? r.value : null;
  }
  const codeHash = account.ok && typeof account.result?.code_hash === "string" ? account.result.code_hash : undefined;
  return {
    ...base,
    live: true,
    config: config.value,
    policy: config.value.policy,
    solver: config.value.solver,
    attestationCount: count,
    latest,
    codeHash,
    codeHashMatchesProof: codeHash ? codeHash === TESTNET_PROOF.contract.codeHash : undefined,
    accessKeyCount: keyCount,
    locked: keyCount === undefined ? undefined : keyCount === 0,
  };
}

export async function getOnchainLastNonce(): Promise<number | null> {
  const r = await viewFunction<number>("testnet", RISK_GUARD_CONTRACT, "get_last_nonce");
  return r.ok ? r.value : null;
}

export interface OnchainOrderCheck {
  live: boolean;
  contractId: string;
  method: "check_order_params";
  order: OrderParams;
  payloadHex: string;
  approved?: boolean;
  netDeltaBps?: number;
  leverageX100?: number;
  expectedPayloadHex?: string;
  payloadMatches?: boolean;
  nonceFresh?: boolean;
  violations?: string[];
  blockHeight?: number;
  error?: string;
}

interface RawEvaluation {
  approved: boolean;
  net_delta_bps: number;
  leverage_x100: number;
  slippage_bps: number;
  expected_payload_hex: string;
  payload_matches: boolean;
  nonce_fresh: boolean;
  violations: string[];
}

/** The deployed contract recomputes metrics + commitment for this order (free view call). */
export async function checkOrderOnchain(order: OrderParams, payloadHex: string): Promise<OnchainOrderCheck> {
  const base = { contractId: RISK_GUARD_CONTRACT, method: "check_order_params" as const, order, payloadHex };
  const r = await viewFunction<RawEvaluation>("testnet", RISK_GUARD_CONTRACT, "check_order_params", { order, hedge_order_payload_hex: payloadHex });
  if (!r.ok) return { ...base, live: false, error: r.contractPanic ?? r.error };
  return {
    ...base,
    live: true,
    approved: r.value.approved,
    netDeltaBps: r.value.net_delta_bps,
    leverageX100: r.value.leverage_x100,
    expectedPayloadHex: r.value.expected_payload_hex,
    payloadMatches: r.value.payload_matches,
    nonceFresh: r.value.nonce_fresh,
    violations: r.value.violations,
    blockHeight: r.blockHeight,
  };
}

// ---------------------------------------------------------------------------
// Transaction status verification
// ---------------------------------------------------------------------------

type ExecStatus = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
interface RpcFunctionCall {
  FunctionCall?: { method_name: string };
}
interface RpcTxStatus {
  final_execution_status?: string;
  status: ExecStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: (RpcFunctionCall | string | Record<string, unknown>)[] };
  transaction_outcome: { block_hash: string };
  receipts_outcome: { id: string; outcome: { executor_id: string; status: ExecStatus; logs: string[] } }[];
  receipts?: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: { Action?: { actions: RpcFunctionCall[] } } }[];
}

export interface ReceiptSummary {
  predecessorId: string;
  receiverId: string;
  methodName?: string;
  status: "SUCCESS" | "FAILURE" | "UNKNOWN";
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
  receipts: ReceiptSummary[];
  /** For the guard-gated sign tx: the receipt where the contract calls the MPC signer. */
  gateReceipt?: ReceiptSummary;
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

function methodOf(actions: unknown[] | undefined): string | undefined {
  for (const a of actions ?? []) {
    if (a && typeof a === "object" && "FunctionCall" in a) return (a as { FunctionCall: { method_name: string } }).FunctionCall.method_name;
  }
  return undefined;
}

/** `EXPERIMENTAL_tx_status` (includes receipts + predecessors) on archival endpoints, then the regular RPC. */
export async function fetchTxStatus(hash: string, senderAccountId: string): Promise<{ ok: true; result: RpcTxStatus; endpoint: string } | { ok: false; error: string }> {
  const errors: string[] = [];
  for (const endpoint of [...TESTNET_ARCHIVAL_RPC, "https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "zerodelta", method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: senderAccountId, wait_until: "FINAL" } }),
        },
        15_000,
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
  const base = { kind: tx.kind, label: tx.label, hash: tx.hash, explorerUrl: tx.explorerUrl, logs: [] as string[], receipts: [] as ReceiptSummary[] };
  const r = await fetchTxStatus(tx.hash, tx.signerId);
  if (!r.ok) return { ...base, found: false, matchesExpectation: false, onchainStatus: "NOT_FOUND", detail: r.error };
  const t = r.result;
  if (!t?.status || !t.transaction || !Array.isArray(t.receipts_outcome)) {
    return { ...base, found: false, matchesExpectation: false, onchainStatus: "NOT_FOUND", detail: "malformed tx status response" };
  }
  const failed = t.status.Failure !== undefined;
  const errorMessage = failed ? JSON.stringify(t.status.Failure) : undefined;
  const logs = t.receipts_outcome.flatMap((o) => o.outcome.logs);
  const outcomeById = new Map(t.receipts_outcome.map((o) => [o.id, o.outcome.status]));
  const receipts: ReceiptSummary[] = (t.receipts ?? [])
    .filter((rc) => rc.predecessor_id !== "system")
    .map((rc) => {
      const st = outcomeById.get(rc.receipt_id);
      return {
        predecessorId: rc.predecessor_id,
        receiverId: rc.receiver_id,
        methodName: methodOf(rc.receipt.Action?.actions),
        status: !st ? "UNKNOWN" : st.Failure !== undefined ? "FAILURE" : "SUCCESS",
      };
    });
  const methodName = methodOf(t.transaction.actions as unknown[]);
  const partiesOk = t.transaction.signer_id === tx.signerId && t.transaction.receiver_id === tx.receiverId && methodName === tx.methodName;
  const statusOk = tx.expect === "success" ? !failed : failed && Boolean(errorMessage?.includes(tx.expectedError ?? "ZERODELTA_REJECTED"));
  const gateReceipt = tx.expectedReceipt
    ? receipts.find((rc) => rc.predecessorId === tx.expectedReceipt!.predecessorId && rc.receiverId === tx.expectedReceipt!.receiverId && rc.methodName === tx.expectedReceipt!.methodName)
    : undefined;
  const receiptOk = tx.expectedReceipt ? Boolean(gateReceipt && gateReceipt.status === "SUCCESS") : true;
  // A rejected order must never reach the MPC signer.
  const noMpcOnFailure = tx.expect === "failure" ? !receipts.some((rc) => rc.receiverId === MPC_CONTRACT) : true;
  const returnValue = decodeSuccessValue(t.status.SuccessValue);
  const rejection = (errorMessage ?? "").match(/ZERODELTA_REJECTED[^"\\]*/)?.[0];
  return {
    ...base,
    found: true,
    matchesExpectation: partiesOk && statusOk && receiptOk && noMpcOnFailure,
    onchainStatus: failed ? "FAILURE" : "SUCCESS",
    signerId: t.transaction.signer_id,
    receiverId: t.transaction.receiver_id,
    methodName,
    finality: t.final_execution_status,
    returnValue,
    errorMessage,
    receipts,
    gateReceipt,
    logs,
    endpoint: r.endpoint,
    detail: !partiesOk
      ? "signer/receiver/method differ from testnet-proof.json"
      : !receiptOk
        ? `expected receipt ${tx.expectedReceipt?.predecessorId} -> ${tx.expectedReceipt?.receiverId}.${tx.expectedReceipt?.methodName} not found`
        : failed
          ? `failed on-chain as expected: ${rejection ?? errorMessage}${noMpcOnFailure ? "; no MPC receipt" : "; MPC WAS CALLED"}`
          : gateReceipt
            ? `succeeded; contract ${gateReceipt.predecessorId} called ${gateReceipt.receiverId}.${gateReceipt.methodName} (${t.final_execution_status ?? "final"})`
            : `succeeded on-chain (${t.final_execution_status ?? "final"})`,
  };
}

let txCache: TxVerification[] | null = null;

/** Transactions are immutable once final, so results are cached per server process. */
export async function verifyAllProofTxs(): Promise<TxVerification[]> {
  if (txCache && txCache.every((v) => v.found)) return txCache;
  txCache = await Promise.all(TESTNET_PROOF.transactions.map(verifyProofTx));
  return txCache;
}

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
  mpcGate: { verified: boolean; predecessorId?: string; receiverId?: string; txHash?: string };
  allVerified: boolean;
}

export async function getOnchainProofStatus(): Promise<OnchainProofStatus> {
  const [guard, transactions] = await Promise.all([getOnchainGuardState(), verifyAllProofTxs()]);
  const verification = verifyMpcSignature(TESTNET_PROOF.mpcSignature);
  const signTx = transactions.find((t) => t.kind === "RECORD_AND_SIGN_APPROVED_REBALANCE");
  const mpcGate = {
    verified: Boolean(signTx?.matchesExpectation && signTx.gateReceipt),
    predecessorId: signTx?.gateReceipt?.predecessorId,
    receiverId: signTx?.gateReceipt?.receiverId,
    txHash: signTx?.hash,
  };
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
    mpcGate,
    allVerified: transactions.length > 0 && transactions.every((t) => t.matchesExpectation) && verification.valid && mpcGate.verified && guard.locked === true,
  };
}
