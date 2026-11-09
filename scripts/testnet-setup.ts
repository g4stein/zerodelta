/**
 * One-time NEAR testnet setup for ZeroDelta  —  `npm run testnet:setup`
 *
 *  1. Creates and funds two testnet accounts through the NEAR testnet faucet
 *     (helper.testnet.near.org): a Guard account and a Solver account.
 *  2. Deploys contracts/risk-guard to the Guard account and registers the policy
 *     (max_delta_bps 200, max_leverage_x100 300, max_slippage_bps 25)   [tx 1]
 *  3. Runs the live swarm and records the approved rebalance on-chain     [tx 2]
 *  4. Submits the rogue 10x plan; the contract rejects it on-chain         [tx 3]
 *  5. Calls v1.signer-prod.testnet `sign` for the approved hedge order     [tx 4]
 *  6. Writes testnet-proof.json (public) — private keys stay in
 *     .testnet-keys.json, which is git-ignored and never committed.
 *
 * Progress is saved after every step; re-running resumes where it stopped.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";
import bs58 from "bs58";
import { runSwarm } from "../src/lib/swarm/orchestrator";
import { getMpcDerivedAccount, MPC_CONTRACT } from "../src/lib/near/rpcClient";
import { HEDGE_DERIVATION_PATH } from "../src/lib/agents/guardianAgent";
import { EXPECTED_ONCHAIN_POLICY, nearblocksTx, toOnchainMetrics, type OnchainMetrics, type ProofTx, type TestnetProof } from "../src/lib/near/riskGuardContract";
import { canonicalJson, keccak256Hex } from "../src/lib/crypto/encoding";

const STATE_FILE = ".testnet-keys.json";
const PROOF_FILE = "testnet-proof.json";
const WASM_PATH = "contracts/risk-guard/res/zerodelta_risk_guard.wasm";
const FAUCET = "https://helper.testnet.near.org/account";
const RPC = "https://rpc.testnet.near.org";
const TGAS = 1_000_000_000_000n;

interface State {
  suffix: string;
  guard: { accountId: string; secretKey: string };
  solver: { accountId: string; secretKey: string };
  created: { guard?: boolean; solver?: boolean };
  txs: Partial<Record<ProofTx["kind"], ProofTx>>;
  recorded?: TestnetProof["recordedRebalance"];
  rogue?: TestnetProof["rogueAttempt"];
  mpc?: TestnetProof["mpcSignature"];
}

const log = (msg: string) => console.log(`[testnet-setup] ${msg}`);
const provider = new JsonRpcProvider({ url: RPC });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  const suffix = randomBytes(3).toString("hex");
  const state: State = {
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

async function accountExists(accountId: string): Promise<boolean> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const body = (await res.json()) as { result?: unknown };
  return Boolean(body.result);
}

async function createWithFaucet(accountId: string, secretKey: string) {
  if (await accountExists(accountId)) return log(`${accountId} already exists`);
  const publicKey = KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString();
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`faucet refused ${accountId}: HTTP ${res.status} ${text.slice(0, 300)}`);
  for (let i = 0; i < 20 && !(await accountExists(accountId)); i++) await sleep(1500);
  if (!(await accountExists(accountId))) throw new Error(`${accountId} not visible on-chain after faucet call`);
  log(`created ${accountId} via faucet`);
}

function accountFor(entry: State["guard"]) {
  return new Account(entry.accountId, provider, entry.secretKey as KeyPairString);
}

interface SendResult {
  transaction: { hash: string };
  transaction_outcome: { block_hash: string };
  status: { SuccessValue?: string; Failure?: unknown };
}

async function send(account: Account, receiverId: string, acts: ReturnType<typeof actions.functionCall>[]): Promise<SendResult> {
  const r = (await account.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL", throwOnFailure: false })) as unknown as SendResult;
  return r;
}

function decode(v?: string) {
  return v ? Buffer.from(v, "base64").toString("utf8") : "";
}

async function main() {
  const state = loadState();
  log(`guard  = ${state.guard.accountId}`);
  log(`solver = ${state.solver.accountId}`);

  // 1 ---- accounts -----------------------------------------------------------
  for (const role of ["guard", "solver"] as const) {
    if (!state.created[role]) {
      await createWithFaucet(state[role].accountId, state[role].secretKey);
      state.created[role] = true;
      save(state);
    }
  }

  const guard = accountFor(state.guard);
  const solver = accountFor(state.solver);
  const wasm = readFileSync(WASM_PATH);
  const wasmSha = createHash("sha256").update(wasm).digest();

  // 2 ---- deploy + register policy ------------------------------------------
  if (!state.txs.DEPLOY_AND_REGISTER_POLICY) {
    const r = await send(guard, state.guard.accountId, [
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall("new", { solver: state.solver.accountId, policy: EXPECTED_ONCHAIN_POLICY }, 50n * TGAS, 0n),
    ] as never);
    if (r.status.Failure) throw new Error(`deploy failed: ${JSON.stringify(r.status.Failure)}`);
    state.txs.DEPLOY_AND_REGISTER_POLICY = {
      kind: "DEPLOY_AND_REGISTER_POLICY",
      label: "Deploy Risk Guard contract + register policy",
      hash: r.transaction.hash,
      signerId: state.guard.accountId,
      receiverId: state.guard.accountId,
      methodName: "new",
      expect: "success",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: nearblocksTx(r.transaction.hash),
      summary: "Deploys the contract and stores max_delta_bps=200, max_leverage_x100=300, max_slippage_bps=25 with the solver account.",
    };
    save(state);
    log(`deployed + policy registered: ${r.transaction.hash}`);
  }

  // 3 ---- approved rebalance --------------------------------------------------
  if (!state.txs.RECORD_APPROVED_REBALANCE) {
    const run = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: true });
    if (run.guardian.decision !== "APPROVED") throw new Error(`live swarm not approved: ${run.guardian.violations.join(", ")}`);
    const metrics = toOnchainMetrics(run.guardian.metrics);
    const input = {
      run_id: run.runId,
      pair: run.request.pair,
      treasury_usd: run.request.treasuryUsd,
      ...metrics,
      plan_hash: run.solver.planHash,
      intent_payload_hash: run.solver.intent.payloadHashHex,
      attestation_report_hash: run.solver.attestation.reportHash,
      decision_hash: run.guardian.decisionHash,
    };
    const r = await send(solver, state.guard.accountId, [actions.functionCall("record_rebalance", { rebalance: input }, 30n * TGAS, 0n)] as never);
    if (r.status.Failure) throw new Error(`record_rebalance failed: ${JSON.stringify(r.status.Failure)}`);
    const index = Number(decode(r.status.SuccessValue));
    state.recorded = {
      index,
      runId: run.runId,
      decisionHash: input.decision_hash,
      planHash: input.plan_hash,
      intentPayloadHash: input.intent_payload_hash,
      attestationReportHash: input.attestation_report_hash,
      metrics,
    };
    // Hedge order for the MPC step, bound to this exact approved run.
    const hedgeOrder = run.guardian.mpcSignRequest?.hedgeOrder;
    state.mpc = {
      contractId: MPC_CONTRACT,
      path: HEDGE_DERIVATION_PATH,
      domainId: 0,
      payloadHex: keccak256Hex(canonicalJson(hedgeOrder)),
      derivedPublicKey: "",
      evmAddress: "",
      signature: null,
    };
    state.txs.RECORD_APPROVED_REBALANCE = {
      kind: "RECORD_APPROVED_REBALANCE",
      label: "Record approved rebalance attestation",
      hash: r.transaction.hash,
      signerId: state.solver.accountId,
      receiverId: state.guard.accountId,
      methodName: "record_rebalance",
      expect: "success",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: nearblocksTx(r.transaction.hash),
      summary: `Solver records live run ${run.runId}: net delta ${metrics.net_delta_bps} bps, leverage ${metrics.leverage_x100 / 100}x, slippage ${metrics.slippage_bps} bps, decision ${input.decision_hash.slice(0, 12)}…`,
    };
    save(state);
    log(`approved rebalance recorded (index ${index}): ${r.transaction.hash}`);
  }

  // 4 ---- rogue rebalance, rejected by the contract ---------------------------
  if (!state.txs.ROGUE_REBALANCE_REJECTED) {
    const run = await runSwarm({ mode: "rogue", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: true });
    const metrics: OnchainMetrics = toOnchainMetrics(run.guardian.metrics);
    const input = {
      run_id: run.runId,
      pair: run.request.pair,
      treasury_usd: run.request.treasuryUsd,
      ...metrics,
      plan_hash: run.solver.planHash,
      intent_payload_hash: run.solver.intent.payloadHashHex,
      attestation_report_hash: run.solver.attestation.reportHash,
      decision_hash: run.guardian.decisionHash,
    };
    const r = await send(solver, state.guard.accountId, [actions.functionCall("record_rebalance", { rebalance: input }, 30n * TGAS, 0n)] as never);
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!r.status.Failure || !err.includes("ZERODELTA_REJECTED")) throw new Error(`rogue tx was not rejected as expected: ${err || decode(r.status.SuccessValue)}`);
    state.rogue = { metrics, expectedError: "ZERODELTA_REJECTED" };
    state.txs.ROGUE_REBALANCE_REJECTED = {
      kind: "ROGUE_REBALANCE_REJECTED",
      label: "Rogue 10x plan rejected on-chain",
      hash: r.transaction.hash,
      signerId: state.solver.accountId,
      receiverId: state.guard.accountId,
      methodName: "record_rebalance",
      expect: "failure",
      expectedError: "ZERODELTA_REJECTED",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: nearblocksTx(r.transaction.hash),
      summary: `Solver submits the rogue plan (net delta ${metrics.net_delta_bps} bps, leverage ${metrics.leverage_x100 / 100}x). The contract panics with ZERODELTA_REJECTED and stores nothing.`,
    };
    save(state);
    log(`rogue rebalance rejected on-chain: ${r.transaction.hash}`);
  }

  // 5 ---- Chain Signatures sign for the approved hedge -----------------------
  if (!state.txs.MPC_SIGN_HEDGE && state.mpc) {
    const derived = await getMpcDerivedAccount(HEDGE_DERIVATION_PATH, state.guard.accountId);
    if (!derived.live) throw new Error(`derived_public_key failed: ${derived.error}`);
    state.mpc.derivedPublicKey = derived.derivedPublicKey!;
    state.mpc.evmAddress = derived.evmAddress!;
    const args = { request: { payload_v2: { Ecdsa: state.mpc.payloadHex }, path: HEDGE_DERIVATION_PATH, domain_id: 0 } };
    log("calling v1.signer-prod.testnet sign (MPC network responds asynchronously, this can take ~10-60 s)…");
    const r = await send(guard, MPC_CONTRACT, [actions.functionCall("sign", args, 300n * TGAS, 1n)] as never);
    if (r.status.Failure) throw new Error(`MPC sign failed: ${JSON.stringify(r.status.Failure)} (tx ${r.transaction.hash})`);
    const sig = JSON.parse(decode(r.status.SuccessValue)) as { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };
    state.mpc.signature = { big_r: sig.big_r.affine_point, s: sig.s.scalar, recovery_id: sig.recovery_id };
    state.txs.MPC_SIGN_HEDGE = {
      kind: "MPC_SIGN_HEDGE",
      label: "Chain Signatures: MPC signs approved hedge order",
      hash: r.transaction.hash,
      signerId: state.guard.accountId,
      receiverId: MPC_CONTRACT,
      methodName: "sign",
      expect: "success",
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: nearblocksTx(r.transaction.hash),
      summary: `Guard account asks the NEAR MPC network to sign keccak256(hedge order) at path ${HEDGE_DERIVATION_PATH}; signer address ${derived.evmAddress}.`,
    };
    save(state);
    log(`MPC signature received: ${r.transaction.hash}`);
  }

  // 6 ---- public proof file --------------------------------------------------
  const view = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: state.guard.accountId } }),
  });
  const codeHash = ((await view.json()) as { result: { code_hash: string } }).result.code_hash;
  if (codeHash !== bs58.encode(wasmSha)) throw new Error(`on-chain code hash ${codeHash} != sha256(${WASM_PATH})`);
  const order: ProofTx["kind"][] = ["DEPLOY_AND_REGISTER_POLICY", "RECORD_APPROVED_REBALANCE", "ROGUE_REBALANCE_REJECTED", "MPC_SIGN_HEDGE"];
  const proof: TestnetProof = {
    network: "testnet",
    createdAt: new Date().toISOString(),
    contract: {
      accountId: state.guard.accountId,
      codeHash,
      wasmPath: WASM_PATH,
      wasmSha256Hex: wasmSha.toString("hex"),
      sourcePath: "contracts/risk-guard/src/lib.rs",
      policy: EXPECTED_ONCHAIN_POLICY,
    },
    accounts: { guard: state.guard.accountId, solver: state.solver.accountId },
    recordedRebalance: state.recorded!,
    rogueAttempt: state.rogue!,
    mpcSignature: state.mpc!,
    transactions: order.flatMap((k) => (state.txs[k] ? [state.txs[k]!] : [])),
  };
  writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2) + "\n");
  log(`wrote ${PROOF_FILE} with ${proof.transactions.length} transactions`);
  for (const t of proof.transactions) log(`  ${t.label}: ${t.explorerUrl}`);
}

main().catch((err) => {
  console.error(`[testnet-setup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
