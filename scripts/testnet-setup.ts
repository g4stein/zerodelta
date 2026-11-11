/**
 * One-time NEAR testnet setup for ZeroDelta Risk Guard v2  —  `npm run testnet:setup`
 *
 *  1. Creates and funds two testnet accounts through the NEAR testnet faucet
 *     (helper.testnet.near.org): the Guard (contract) account and the Solver account.
 *  2. [tx 1] Deploys contracts/risk-guard, registers the policy (200 / 300 / 25) and
 *     DELETES the guard account's only full-access key in the same transaction.
 *     From then on, only the contract's own code can act as that account.
 *  3. [tx 2] Runs the live swarm. The solver submits the approved raw order with
 *     `request_mpc_sign: true`; the contract recomputes the metrics, checks the
 *     payload commitment and nonce, then itself calls v1.signer-prod.testnet.sign.
 *  4. [tx 3] Rogue 10x order (honest commitment)  -> rejected on the math.
 *  5. [tx 4] Safe numbers + payload of a 10x order -> PAYLOAD_COMMITMENT_MISMATCH.
 *  6. [tx 5] Exact replay of tx 2                 -> NONCE_ALREADY_USED.
 *  7. Writes testnet-proof.json. Private keys stay in the git-ignored
 *     .testnet-keys.json. Progress is saved after every step; re-running resumes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";
import bs58 from "bs58";

const STATE_FILE = ".testnet-keys.json";
const PROOF_FILE = "testnet-proof.json";
const WASM_PATH = "contracts/risk-guard/res/zerodelta_risk_guard.wasm";
const FAUCET = "https://helper.testnet.near.org/account";
const RPC = "https://test.rpc.fastnear.com"; // rpc.testnet.near.org is deprecated and rate-limits
const MPC = "v1.signer-prod.testnet";
const PATH = "zerodelta/hedge/arbitrum";
const TGAS = 1_000_000_000_000n;
const POLICY = { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25 };

type Kind = "DEPLOY_REGISTER_AND_LOCK" | "RECORD_AND_SIGN_APPROVED_REBALANCE" | "ROGUE_REBALANCE_REJECTED" | "PAYLOAD_SWAP_REJECTED" | "REPLAY_REJECTED";
interface Tx {
  kind: Kind;
  label: string;
  hash: string;
  signerId: string;
  receiverId: string;
  methodName: string;
  expect: "success" | "failure";
  expectedError?: string;
  expectedReceipt?: { predecessorId: string; receiverId: string; methodName: string };
  blockHash?: string;
  explorerUrl: string;
  summary: string;
}
interface State {
  version: 2;
  suffix: string;
  guard: { accountId: string; secretKey: string };
  solver: { accountId: string; secretKey: string };
  created: { guard?: boolean; solver?: boolean };
  txs: Partial<Record<Kind, Tx>>;
  approved?: { args: Record<string, any>; contractMetrics: { net_delta_bps: number; leverage_x100: number } };
  rogue?: { order: any; payload: string };
  swap?: { order: any; payload: string };
  signature?: { big_r: string; s: string; recovery_id: number };
}

const log = (msg: string) => console.log(`[testnet-setup] ${msg}`);
const provider = new JsonRpcProvider({ url: RPC });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

function loadState(): State {
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    if (s.version === 2) return s;
    throw new Error(`${STATE_FILE} is from v1; move it aside (e.g. .testnet-keys.v1.json) before deploying v2`);
  }
  const suffix = randomBytes(3).toString("hex");
  const state: State = {
    version: 2,
    suffix,
    guard: { accountId: `zerodelta-guard-${suffix}.testnet`, secretKey: KeyPair.fromRandom("ed25519").toString() },
    solver: { accountId: `zerodelta-solver-${suffix}.testnet`, secretKey: KeyPair.fromRandom("ed25519").toString() },
    created: {},
    txs: {},
  };
  save(state);
  return state;
}

function save(state: State) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function rpc<T>(method: string, params: unknown): Promise<T | undefined> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result?: T }).result;
}
const viewAccount = (id: string) => rpc<{ code_hash: string; amount: string }>("query", { request_type: "view_account", finality: "final", account_id: id });

async function createWithFaucet(accountId: string, secretKey: string) {
  if (await viewAccount(accountId)) return log(`${accountId} already exists`);
  const publicKey = KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString();
  const res = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`faucet refused ${accountId}: HTTP ${res.status} ${text.slice(0, 300)}`);
  for (let i = 0; i < 20 && !(await viewAccount(accountId)); i++) await sleep(1500);
  if (!(await viewAccount(accountId))) throw new Error(`${accountId} not visible on-chain after faucet call`);
  log(`created ${accountId} via faucet`);
}

interface SendResult {
  transaction: { hash: string };
  transaction_outcome: { block_hash: string };
  status: { SuccessValue?: string; Failure?: unknown };
}
async function send(account: Account, receiverId: string, acts: unknown[]): Promise<SendResult> {
  return (await account.signAndSendTransaction({ receiverId, actions: acts as never, waitUntil: "FINAL", throwOnFailure: false })) as unknown as SendResult;
}
const decode = (v?: string) => (v ? Buffer.from(v, "base64").toString("utf8") : "");

async function main() {
  const state = loadState();
  const G = state.guard.accountId;
  const S = state.solver.accountId;
  log(`guard / contract = ${G}`);
  log(`solver           = ${S}`);
  // Make the swarm build commitments for THIS contract before any src module is loaded.
  process.env.ZERODELTA_RISK_GUARD_CONTRACT = G;
  process.env.ZERODELTA_SOLVER_ACCOUNT = S;
  const { runSwarm } = await import("../src/lib/swarm/orchestrator");
  const { getMpcDerivedAccount } = await import("../src/lib/near/rpcClient");
  const { computeHedgePayloadHex, nextOrderNonce } = await import("../src/lib/near/orderCommitment");
  const { verifyMpcSignature } = await import("../src/lib/near/riskGuardContract");

  // 1 ---- accounts -----------------------------------------------------------
  for (const role of ["guard", "solver"] as const) {
    if (!state.created[role]) {
      await createWithFaucet(state[role].accountId, state[role].secretKey);
      state.created[role] = true;
      save(state);
    }
  }
  const guardKey = KeyPair.fromString(state.guard.secretKey as KeyPairString);
  const guard = new Account(G, provider, state.guard.secretKey as KeyPairString);
  const solver = new Account(S, provider, state.solver.secretKey as KeyPairString);
  const wasm = readFileSync(WASM_PATH);
  const wasmSha = createHash("sha256").update(wasm).digest();

  // 2 ---- deploy + register policy + lock -------------------------------------
  if (!state.txs.DEPLOY_REGISTER_AND_LOCK) {
    const r = await send(guard, G, [
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall("new", { solver: S, policy: POLICY, mpc_signer_contract: MPC, mpc_path: PATH }, 50n * TGAS, 0n),
      actions.deleteKey(guardKey.getPublicKey()),
    ]);
    if (r.status.Failure) throw new Error(`deploy failed: ${JSON.stringify(r.status.Failure)}`);
    state.txs.DEPLOY_REGISTER_AND_LOCK = {
      kind: "DEPLOY_REGISTER_AND_LOCK",
      label: "Deploy contract, register policy, delete the only access key",
      hash: r.transaction.hash,
      signerId: G,
      receiverId: G,
      methodName: "new",
      expect: "success",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: "Deploys Risk Guard v2, stores policy 200/300/25, solver and MPC target, then deletes the account's full-access key in the same transaction. The policy and code can never change, and only the contract can call the MPC signer as this account.",
    };
    save(state);
    log(`deployed, policy registered, account locked: ${r.transaction.hash}`);
  }
  const keys = await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: G });
  if (!keys || keys.keys.length !== 0) throw new Error(`contract account still has ${keys?.keys.length} access keys`);
  log("contract account has 0 access keys (locked)");

  // 3 ---- approved order: contract verifies, then calls MPC sign itself -------
  if (!state.txs.RECORD_AND_SIGN_APPROVED_REBALANCE) {
    const run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: true });
    if (run.guardian.decision !== "APPROVED" || !run.guardian.mpcSignRequest) throw new Error(`live swarm not approved: ${run.guardian.violations.join(", ")}`);
    if (!run.onchainCheck?.approved) throw new Error(`contract view rejects the approved order: ${run.onchainCheck?.violations?.join("; ") ?? run.onchainCheck?.error}`);
    const args = run.guardian.mpcSignRequest.args;
    state.approved = { args, contractMetrics: { net_delta_bps: run.onchainCheck.netDeltaBps!, leverage_x100: run.onchainCheck.leverageX100! } };
    save(state);
    log(`swarm chose ${run.resolved.pair}, ${run.resolved.sliceCount} slices; submitting record_rebalance with request_mpc_sign…`);
    const r = await send(solver, G, [actions.functionCall("record_rebalance", args, 300n * TGAS, 1n)]);
    if (r.status.Failure) throw new Error(`record_rebalance failed: ${JSON.stringify(r.status.Failure)} (tx ${r.transaction.hash})`);
    const sig = JSON.parse(decode(r.status.SuccessValue) || "null") as State["signature"] | null;
    if (!sig) throw new Error(`MPC callback returned no signature (tx ${r.transaction.hash})`);
    state.signature = sig;
    const o = args.rebalance.order;
    state.txs.RECORD_AND_SIGN_APPROVED_REBALANCE = {
      kind: "RECORD_AND_SIGN_APPROVED_REBALANCE",
      label: "Approved order verified on-chain; contract calls MPC sign",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "record_rebalance",
      expect: "success",
      expectedReceipt: { predecessorId: G, receiverId: MPC, methodName: "sign" },
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `Solver submits raw legs for ${o.asset_symbol} (spot $${o.spot_long_usd_cents / 100}, short $${o.perp_short_usd_cents / 100}, nonce ${o.nonce}). The contract computes ${state.approved.contractMetrics.net_delta_bps} bps delta / ${state.approved.contractMetrics.leverage_x100 / 100}x, checks keccak256(order) and the nonce, records attestation #0, then calls ${MPC}.sign itself and stores the returned signature.`,
    };
    save(state);
    log(`approved + MPC-signed via the contract: ${r.transaction.hash}`);
  }
  const approvedArgs = state.approved!.args;
  const approvedOrder = approvedArgs.rebalance.order;

  // 4 ---- rogue order, honest commitment, rejected on math --------------------
  if (!state.txs.ROGUE_REBALANCE_REJECTED) {
    const run = await runSwarm({ mode: "rogue", pair: approvedOrder.asset_symbol, treasuryUsd: 50_000, sliceCount: "auto" }, { live: true });
    const args = {
      rebalance: {
        run_id: run.runId,
        order: run.solver.order,
        hedge_order_payload_hex: run.solver.hedgeOrderPayloadHex,
        plan_hash: run.solver.planHash,
        intent_payload_hash: run.solver.intent.payloadHashHex,
        attestation_report_hash: run.solver.attestation.reportHash,
        decision_hash: run.guardian.decisionHash,
      },
      request_mpc_sign: true,
    };
    const r = await send(solver, G, [actions.functionCall("record_rebalance", args, 300n * TGAS, 1n)]);
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!err.includes("DELTA_NEUTRALITY")) throw new Error(`rogue tx not rejected on math: ${err || decode(r.status.SuccessValue)}`);
    state.rogue = { order: run.solver.order, payload: run.solver.hedgeOrderPayloadHex };
    state.txs.ROGUE_REBALANCE_REJECTED = {
      kind: "ROGUE_REBALANCE_REJECTED",
      label: "Rogue 10x order rejected on-chain (math)",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "record_rebalance",
      expect: "failure",
      expectedError: "DELTA_NEUTRALITY",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `Solver submits the rogue legs (spot $${run.solver.order.spot_long_usd_cents / 100}, perp long $${run.solver.order.perp_long_usd_cents / 100}) with a matching payload and asks for an MPC signature. The contract computes the delta and leverage itself and panics; no MPC receipt is created.`,
    };
    save(state);
    log(`rogue order rejected on-chain: ${r.transaction.hash}`);
  }

  // 5 ---- payload swap: safe numbers, payload of a 10x order -----------------
  if (!state.txs.PAYLOAD_SWAP_REJECTED) {
    const nonce = nextOrderNonce();
    const order = { ...approvedOrder, nonce };
    const hidden = { ...order, spot_long_usd_cents: order.treasury_usd_cents, perp_short_usd_cents: 0, perp_long_usd_cents: order.treasury_usd_cents * 9 };
    const payload = computeHedgePayloadHex(G, hidden);
    const args = { rebalance: { ...approvedArgs.rebalance, run_id: "payload-swap-attack", order, hedge_order_payload_hex: payload }, request_mpc_sign: true };
    const r = await send(solver, G, [actions.functionCall("record_rebalance", args, 300n * TGAS, 1n)]);
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!err.includes("PAYLOAD_COMMITMENT_MISMATCH")) throw new Error(`payload swap not rejected: ${err || decode(r.status.SuccessValue)}`);
    state.swap = { order, payload };
    state.txs.PAYLOAD_SWAP_REJECTED = {
      kind: "PAYLOAD_SWAP_REJECTED",
      label: "Spoofed payload rejected on-chain",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "record_rebalance",
      expect: "failure",
      expectedError: "PAYLOAD_COMMITMENT_MISMATCH",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: "A compromised solver sends the approved, delta-neutral numbers with a fresh nonce but swaps in the MPC payload of a 10x long. The contract recomputes keccak256(order), sees the mismatch and panics before any MPC call.",
    };
    save(state);
    log(`payload swap rejected on-chain: ${r.transaction.hash}`);
  }

  // 6 ---- replay of tx 2 -------------------------------------------------------
  if (!state.txs.REPLAY_REJECTED) {
    const r = await send(solver, G, [actions.functionCall("record_rebalance", approvedArgs, 300n * TGAS, 1n)]);
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!err.includes("NONCE_ALREADY_USED")) throw new Error(`replay not rejected: ${err || decode(r.status.SuccessValue)}`);
    state.txs.REPLAY_REJECTED = {
      kind: "REPLAY_REJECTED",
      label: "Replay of the approved order rejected on-chain",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "record_rebalance",
      expect: "failure",
      expectedError: "NONCE_ALREADY_USED",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `Byte-identical resubmission of the approved order (nonce ${approvedOrder.nonce}) to get a second signature. The contract panics with NONCE_ALREADY_USED.`,
    };
    save(state);
    log(`replay rejected on-chain: ${r.transaction.hash}`);
  }

  // 7 ---- proof file ------------------------------------------------------------
  const derived = await getMpcDerivedAccount(PATH, G);
  if (!derived.live) throw new Error(`derived_public_key failed: ${derived.error}`);
  const mpcSignature = {
    contractId: MPC,
    path: PATH,
    domainId: 0,
    payloadHex: approvedArgs.rebalance.hedge_order_payload_hex,
    predecessor: G,
    derivedPublicKey: derived.derivedPublicKey!,
    evmAddress: derived.evmAddress!,
    signature: state.signature!,
  };
  const v = verifyMpcSignature(mpcSignature);
  if (!v.valid) throw new Error(`MPC signature does not recover to the contract's derived key: ${JSON.stringify(v)}`);
  const codeHash = (await viewAccount(G))!.code_hash;
  if (codeHash !== bs58.encode(wasmSha)) throw new Error(`on-chain code hash ${codeHash} != sha256(${WASM_PATH})`);
  const v1 = existsSync(PROOF_FILE) ? JSON.parse(readFileSync(PROOF_FILE, "utf8")) : null;
  if (v1 && Number(v1.version ?? 1) >= 3) throw new Error(`testnet-proof.json is version ${v1.version}: refusing to overwrite a newer proof with the v2 setup script`);
  const previousDeployment =
    v1 && (v1.version ?? 1) === 1
      ? {
          version: 1,
          contract: v1.contract.accountId,
          solver: v1.accounts.solver,
          note: "v1 trusted solver-reported metrics and the guard account called the MPC signer directly. Superseded by v2 after the audit; kept for history only.",
          transactions: v1.transactions.map((t: { hash: string }) => t.hash),
        }
      : v1?.previousDeployment;
  const order: Kind[] = ["DEPLOY_REGISTER_AND_LOCK", "RECORD_AND_SIGN_APPROVED_REBALANCE", "ROGUE_REBALANCE_REJECTED", "PAYLOAD_SWAP_REJECTED", "REPLAY_REJECTED"];
  const proof = {
    network: "testnet",
    version: 2,
    createdAt: new Date().toISOString(),
    contract: {
      accountId: G,
      codeHash,
      wasmPath: WASM_PATH,
      wasmSha256Hex: wasmSha.toString("hex"),
      sourcePath: "contracts/risk-guard/src/lib.rs",
      policy: POLICY,
      mpcSignerContract: MPC,
      mpcPath: PATH,
      locked: true,
    },
    accounts: { guard: G, solver: S },
    approvedOrder: {
      index: 0,
      runId: approvedArgs.rebalance.run_id,
      order: approvedOrder,
      hedgeOrderPayloadHex: approvedArgs.rebalance.hedge_order_payload_hex,
      decisionHash: approvedArgs.rebalance.decision_hash,
      planHash: approvedArgs.rebalance.plan_hash,
      intentPayloadHash: approvedArgs.rebalance.intent_payload_hash,
      attestationReportHash: approvedArgs.rebalance.attestation_report_hash,
      contractMetrics: state.approved!.contractMetrics,
    },
    rogueAttempt: { order: state.rogue!.order, hedgeOrderPayloadHex: state.rogue!.payload, expectedError: "DELTA_NEUTRALITY" },
    payloadSwapAttempt: { order: state.swap!.order, hedgeOrderPayloadHex: state.swap!.payload, expectedError: "PAYLOAD_COMMITMENT_MISMATCH" },
    replayAttempt: { nonce: approvedOrder.nonce, expectedError: "NONCE_ALREADY_USED" },
    mpcSignature,
    transactions: order.map((k) => state.txs[k]!),
    previousDeployment,
  };
  writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2) + "\n");
  log(`wrote ${PROOF_FILE} with ${proof.transactions.length} transactions`);
  for (const t of proof.transactions) log(`  ${t.label}: ${t.explorerUrl}`);
}

main().catch((err) => {
  console.error(`[testnet-setup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
