/**
 * One-time NEAR testnet setup for ZeroDelta Risk Guard v3.1  —  `npm run testnet:setup:v31`
 *
 * TESTNET ONLY. No mainnet, no Hyperliquid funding, nothing is posted to Hyperliquid.
 *
 *  0. Preflight: the committed v3.1 wasm, storage price (EXPERIMENTAL_protocol_config), stake for the wasm,
 *     solver balance, live Hyperliquid TESTNET market table vs the pinned table (abort on any difference),
 *     the clock skew against NEAR, and the MPC-derived address for (contract, zerodelta/hedge/hyperliquid).
 *  1. Rehearsal on a throwaway KEYED account: create + fund, deploy + init (key kept), check views and that
 *     an approved preview digest equals the TypeScript mirror, then delete the account (funds return).
 *  2. [create] testnet.create_account for the v3.1 guard, funded with the wasm storage stake + 0.75 NEAR.
 *     [lock]   DeployContract -> new(...) -> DeleteKey LAST, atomically in one transaction.
 *  3. [tx] approved order: the contract builds the IOC sell (with expiresAfter), computes the digest (must
 *     equal the TS mirror) and calls v1.signer-prod.testnet.sign; the signature must recover to the derived address.
 *  4. [tx] THE AUDIT ATTACK: the same legs with limit = reference = one tenth of the market price, which made the
 *     deployed v3 sign ~10x the approved size -> ORDER_SIZE_CAP, no MPC receipt, no nonce consumed.
 *  5. [tx] expiresAfter beyond the policy maximum -> EXPIRY_TOO_FAR, no MPC receipt, no nonce consumed.
 *  6. [tx] byte-identical replay of step 3 -> NONCE_ALREADY_USED, no MPC receipt, no nonce consumed.
 *  7. [tx] solver calls the #[private] callback directly -> rejected, attestation unchanged.
 *  8. Writes testnet-proof.json (v3.1 at the top, v3 and v2 under previousDeployment, unchanged) and a
 *     byte-identical copy of the v3 file in proofs/. Keys stay in the git-ignored .testnet-keys-v31.json.
 * Progress is saved after every step; re-running resumes.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import bs58 from "bs58";
import { evmAddressFromUncompressed, recoverAddress } from "../src/lib/hyperliquid/recover";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";
import { HYPERLIQUID_PERPS_TESTNET } from "../src/lib/hyperliquid/exchangeSigning";
import { roundDownToValidPerpPrice, toE8, wireE8 } from "../src/lib/hyperliquid/fixedPoint";
import { buildV31Hedge, coinsToE8, V31_SIZE_CAPS, type V31Market } from "../src/lib/hyperliquid/v31Hedge";

const V2_STATE = ".testnet-keys.json";
const STATE_FILE = ".testnet-keys-v31.json";
const PROOF_FILE = "testnet-proof.json";
const V2_COPY = "proofs/testnet-proof.v2.json";
const V3_COPY = "proofs/testnet-proof.v3.json";
const WASM_PATH = "contracts/risk-guard-v31/res/zerodelta_risk_guard_v31.wasm";
const RPC = "https://test.rpc.fastnear.com";
const ARCHIVAL = "https://archival-rpc.testnet.fastnear.com";
const REGISTRAR = "testnet";
const MPC = "v1.signer-prod.testnet";
const PATH = "zerodelta/hedge/hyperliquid";
const HL_INFO = "https://api.hyperliquid-testnet.xyz/info";
const HL_NETWORK = "testnet" as const;
const TGAS = 1_000_000_000_000n;
const YOCTO = 10n ** 24n;
const SIGN_DEPOSIT = 50n * 10n ** 21n; // 0.05 NEAR: storage + 1 yocto MPC deposit; excess refunded
const POLICY = {
  max_delta_bps: 200,
  max_leverage_x100: 300,
  max_slippage_bps: 25,
  price_band_bps: 100,
  notional_band_bps: 50,
  max_nonce_age_ms: 300_000,
  max_nonce_future_ms: 60_000,
  max_expiry_ms: 3_600_000, // a signed order stops being valid at Hyperliquid at most 1 hour after signing
  window_ms: 86_400_000, // rolling window for the cumulative size and order-count caps
  max_orders_per_window: 6,
};
const EXPIRY_AHEAD_MS = 45 * 60_000; // approved order: valid for 45 minutes
const HEADROOM = (YOCTO * 3n) / 4n; // NEAR on top of the wasm storage stake
const LIMIT_UNDER_REF_BPS = 50n; // approved order: limit 0.5% under the reference (inside the 1% band)
const OUT_OF_BAND_BPS = 300n; // rejected order: 3% under the reference

type Kind = "CREATE_V31_ACCOUNT" | "DEPLOY_INIT_AND_LOCK" | "APPROVED_EXECUTABLE_HEDGE_SIGNED" | "INFLATION_ATTACK_REJECTED" | "EXPIRY_TOO_FAR_REJECTED" | "REPLAY_REJECTED" | "PRIVATE_CALLBACK_REJECTED";
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
  mpcReceipt: boolean;
  blockHash: string;
  explorerUrl: string;
  summary: string;
}
interface State {
  version: 3.1;
  suffix: string;
  guard: { accountId: string; secretKey: string };
  rehearsal: { accountId: string; secretKey: string; created?: string; deployed?: string; deleted?: string; previewDigest?: string };
  markets?: { fetchedAt: string; table: V31Market[] };
  derived?: { publicKey: string; evmAddress: string };
  txs: Partial<Record<Kind, Tx>>;
  approved?: { args: Record<string, any>; reference: string; limit: string; expiresAfterMs: number; recommendation: string; overridden: boolean };
  inflation?: { args: Record<string, any>; limit: string; reference: string };
  expiry?: { args: Record<string, any> };
  hlSignature?: { r: string; s: string; v: number };
}

const log = (m: string) => console.log(`[testnet-setup-v31] ${m}`);
const provider = new JsonRpcProvider({ url: RPC });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
const near = (y: bigint) => `${(Number(y) / 1e24).toFixed(4)} NEAR`;

function save(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  const suffix = randomBytes(3).toString("hex");
  const s: State = {
    version: 3.1,
    suffix,
    guard: { accountId: `zerodelta-guard-v31-${suffix}.testnet`, secretKey: KeyPair.fromRandom("ed25519").toString() },
    rehearsal: { accountId: `zerodelta-v31-rehearsal-${suffix}.testnet`, secretKey: KeyPair.fromRandom("ed25519").toString() },
    txs: {},
  };
  save(s);
  return s;
}

async function rpc<T>(method: string, params: unknown, url = RPC): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await res.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
}
const viewAccount = (id: string) =>
  rpc<{ amount: string; code_hash: string; storage_usage: number }>("query", { request_type: "view_account", finality: "final", account_id: id }).catch(() => undefined);
const keyCount = async (id: string) => (await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id })).keys.length;
async function view<T>(contract: string, method: string, args: unknown): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}
async function hlInfo<T>(body: unknown): Promise<T> {
  const res = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Hyperliquid testnet info HTTP ${res.status}`);
  return (await res.json()) as T;
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

/** Executors of every receipt of a transaction (to prove no MPC receipt exists). */
async function receiptExecutors(hash: string, sender: string): Promise<string[]> {
  for (const url of [RPC, ARCHIVAL]) {
    try {
      const r = await rpc<{ receipts_outcome: { outcome: { executor_id: string } }[] }>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" }, url);
      return r.receipts_outcome.map((o) => o.outcome.executor_id);
    } catch {
      await sleep(1500);
    }
  }
  throw new Error(`could not read receipts of ${hash}`);
}

/** Both new accounts (rehearsal, then real) are funded one after the other; the rehearsal's funds return before the real one. */
async function requireSolverBalanceEarly(solverId: string, funding: bigint) {
  const bal = BigInt((await viewAccount(solverId))!.amount);
  const proofTxs = (YOCTO * 35n) / 100n; // attached deposits (mostly refunded) + gas for 7 transactions
  log(`solver balance ${near(bal)}; needs ${near(funding)} per new account (sequential) + ~${near(proofTxs)} for proof txs`);
  if (bal < funding + proofTxs) throw new Error(`ABORT: solver balance ${near(bal)} < ${near(funding + proofTxs)}`);
}

const evmAddress = evmAddressFromUncompressed;
/** Address recovered from a Hyperliquid-style {r, s, v} over `digestHex` (re-exported for the scripts and tests). */
export { recoverAddress };

async function main() {
  const state = loadState();
  const G = state.guard.accountId;
  const RH = state.rehearsal.accountId;
  const v2 = JSON.parse(readFileSync(V2_STATE, "utf8")) as { solver: { accountId: string; secretKey: string } };
  const S = v2.solver.accountId;
  const solver = new Account(S, provider, v2.solver.secretKey as KeyPairString);
  log(`v3.1 guard / contract = ${G}`);
  log(`solver (reused)     = ${S}`);

  // 0 ---- preflight -------------------------------------------------------------
  const wasm = readFileSync(WASM_PATH);
  const wasmSha = createHash("sha256").update(wasm).digest();
  const codeHash = bs58.encode(wasmSha);
  const cfg = await rpc<{ runtime_config: { storage_amount_per_byte: string } }>("EXPERIMENTAL_protocol_config", { finality: "final" });
  const perByte = BigInt(cfg.runtime_config.storage_amount_per_byte);
  const wasmStake = BigInt(wasm.length) * perByte;
  const funding = wasmStake + HEADROOM; // stake for the code + 0.75 NEAR headroom
  log(`wasm ${wasm.length} bytes, sha256 ${wasmSha.toString("hex")}, code hash ${codeHash}`);
  log(`storage ${perByte} yocto/byte -> wasm stake ${near(wasmStake)}; each new account funded with ${near(funding)}`);

  if (!state.markets) {
    const meta = await hlInfo<{ universe: { name: string; szDecimals: number }[] }>({ type: "meta" });
    const fetchedAt = new Date().toISOString();
    const table: V31Market[] = Object.entries(HYPERLIQUID_PERPS_TESTNET).map(([symbol, pinned]) => {
      const asset = meta.universe.findIndex((u) => u.name === symbol);
      if (asset < 0) throw new Error(`ABORT: ${symbol} missing from live Hyperliquid testnet meta`);
      const live = meta.universe[asset];
      if (asset !== pinned.asset || live.szDecimals !== pinned.szDecimals) {
        throw new Error(`ABORT: live testnet table differs from pinned: ${symbol} live {asset ${asset}, szDecimals ${live.szDecimals}} vs pinned {asset ${pinned.asset}, szDecimals ${pinned.szDecimals}}`);
      }
      return {
        symbol,
        asset,
        sz_decimals: live.szDecimals,
        max_order_size_e8: Number(coinsToE8(V31_SIZE_CAPS[symbol].maxOrderCoins)),
        window_size_cap_e8: Number(coinsToE8(V31_SIZE_CAPS[symbol].windowCoins)),
      };
    });
    state.markets = { fetchedAt, table };
    save(state);
  }
  log(`live Hyperliquid testnet table matches pinned (fetched ${state.markets.fetchedAt}): ${state.markets.table.map((m) => `${m.symbol}=${m.asset}/${m.sz_decimals} cap ${Number(m.max_order_size_e8) / 1e8}`).join(" ")}`);

  if (!state.derived) {
    const pk = await view<string>(MPC, "derived_public_key", { path: PATH, predecessor: G, domain_id: 0 });
    const raw = bs58.decode(pk.replace(/^secp256k1:/, ""));
    state.derived = { publicKey: pk, evmAddress: evmAddress(new Uint8Array([4, ...raw])) };
    save(state);
  }
  log(`MPC-derived hedge address for (${G}, ${PATH}): ${state.derived.evmAddress}`);

  // Nonces are Date.now() and must land inside the contract's block-time window (-5 min / +60 s).
  const head = await rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
  const skewMs = Date.now() - Number(BigInt(head.header.timestamp_nanosec) / 1_000_000n);
  log(`local clock - final block time = ${skewMs} ms`);
  if (skewMs > 20_000 || skewMs < -120_000) throw new Error(`ABORT: clock skew ${skewMs} ms would break the nonce window`);
  await requireSolverBalanceEarly(S, funding);
  if (process.env.PREFLIGHT_ONLY === "1") {
    log("PREFLIGHT_ONLY=1: stopping before any transaction");
    return;
  }

  const initArgs = (contract: string) => ({
    solver: S,
    policy: POLICY,
    hl_network: HL_NETWORK,
    markets: state.markets!.table,
    markets_fetched_at: state.markets!.fetchedAt,
    mpc_signer_contract: MPC,
    mpc_path: PATH,
    mpc_deposit: "1",
    _for: contract,
  });
  const cleanInit = (contract: string) => {
    const { _for, ...a } = initArgs(contract);
    void _for;
    return a;
  };
  const requireSolverBalance = async (need: bigint, what: string) => {
    const bal = BigInt((await viewAccount(S))!.amount);
    log(`solver balance ${near(bal)}; ${what} needs ${near(need)} + gas`);
    if (bal < need + YOCTO / 2n) throw new Error(`ABORT: solver balance ${near(bal)} does not cover ${what} (${near(need)} + 0.5 NEAR margin)`);
  };
  const createAccount = async (accountId: string, secretKey: string) => {
    const pub = KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString();
    const r = await send(solver, REGISTRAR, [actions.functionCall("create_account", { new_account_id: accountId, new_public_key: pub }, 100n * TGAS, funding)]);
    if (r.status.Failure) throw new Error(`create_account ${accountId} failed: ${JSON.stringify(r.status.Failure)}`);
    for (let i = 0; i < 20 && !(await viewAccount(accountId)); i++) await sleep(1500);
    if (!(await viewAccount(accountId))) throw new Error(`${accountId} not visible after create_account`);
    return r;
  };

  // A request for the current market. Legs come from the live swarm (approved under the same policy).
  const { runSwarm } = await import("../src/lib/swarm/orchestrator");
  const buildRequest = async (prior?: Record<string, any>, underBps = LIMIT_UNDER_REF_BPS) => {
    let legs = prior?.order;
    let hashes = prior;
    let recommendation = "n/a";
    let overridden = false;
    if (!legs) {
      let run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: true });
      recommendation = run.economics?.recommendation ?? "TRADE";
      if (run.guardian.decision !== "APPROVED" || recommendation === "NO_TRADE") {
        run = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto", simulateUnprofitable: true }, { live: true });
        overridden = true;
      }
      if (run.guardian.decision !== "APPROVED") throw new Error(`live swarm not approved: ${run.guardian.violations.join(", ")}`);
      legs = run.solver.order;
      hashes = { run_id: run.runId, plan_hash: run.solver.planHash, intent_payload_hash: run.solver.intent.payloadHashHex, attestation_report_hash: run.solver.attestation.reportHash, decision_hash: run.guardian.decisionHash };
    }
    const market = state.markets!.table.find((m) => m.symbol === legs.asset_symbol)!;
    const mids = await hlInfo<Record<string, string>>({ type: "allMids" });
    const ref = toE8(mids[legs.asset_symbol]);
    const limit = roundDownToValidPerpPrice((ref * (10_000n - underBps)) / 10_000n, market.sz_decimals);
    const order = { ...legs, nonce: Date.now() };
    const request = {
      run_id: hashes!.run_id,
      order,
      limit_px_e8: Number(limit),
      reference_px_e8: Number(ref),
      expires_after_ms: order.nonce + EXPIRY_AHEAD_MS,
      expected_digest_hex: null as string | null,
      plan_hash: hashes!.plan_hash,
      intent_payload_hash: hashes!.intent_payload_hash,
      attestation_report_hash: hashes!.attestation_report_hash,
      decision_hash: hashes!.decision_hash,
    };
    return { request, market, ref, limit, recommendation, overridden };
  };

  // 1 ---- rehearsal on a throwaway keyed account ----------------------------------------
  if (!state.rehearsal.deleted) {
    const rk = state.rehearsal.secretKey as KeyPairString;
    if (!state.rehearsal.created) {
      await requireSolverBalance(funding, "rehearsal account");
      const r = await createAccount(RH, rk);
      state.rehearsal.created = r.transaction.hash;
      save(state);
      log(`rehearsal account created: ${r.transaction.hash}`);
    }
    const rehearsal = new Account(RH, provider, rk);
    if (!state.rehearsal.deployed) {
      const r = await send(rehearsal, RH, [actions.deployContract(new Uint8Array(wasm)), actions.functionCall("new", cleanInit(RH), 50n * TGAS, 0n)]);
      if (r.status.Failure) throw new Error(`rehearsal deploy/init failed (key kept, account deletable): ${JSON.stringify(r.status.Failure)}`);
      state.rehearsal.deployed = r.transaction.hash;
      save(state);
      log(`rehearsal deploy + init OK: ${r.transaction.hash}`);
    }
    const acct = (await viewAccount(RH))!;
    if (acct.code_hash !== codeHash) throw new Error(`rehearsal code hash ${acct.code_hash} != ${codeHash}`);
    log(`rehearsal storage_usage ${acct.storage_usage} bytes = ${near(BigInt(acct.storage_usage) * perByte)} stake (wasm alone ${near(wasmStake)})`);
    const rc = await view<{ markets: V31Market[]; hl_network: string; mpc_path: string; version: string }>(RH, "get_config", {});
    if (rc.hl_network !== "testnet" || rc.mpc_path !== PATH || JSON.stringify(rc.markets) !== JSON.stringify(state.markets.table) || rc.version !== "3.1.0") throw new Error(`rehearsal config wrong: ${JSON.stringify(rc)}`);
    const { request, market, ref, limit } = await buildRequest();
    const preview = await view<{ approved: boolean; digest_hex: string; violations: string[] }>(RH, "preview_executable_hedge", { request });
    const mirror = buildV31Hedge(RH, HL_NETWORK, market, request.order, limit, ref, BigInt(request.expires_after_ms), POLICY);
    if (!preview.approved) throw new Error(`rehearsal preview rejected: ${preview.violations.join("; ")}`);
    if (preview.digest_hex !== mirror.digestHex) throw new Error(`rehearsal digest ${preview.digest_hex} != TS mirror ${mirror.digestHex}`);
    state.rehearsal.previewDigest = preview.digest_hex;
    log(`rehearsal preview approved; on-chain digest == TS mirror (${preview.digest_hex.slice(0, 16)}…)`);
    const d = await send(rehearsal, RH, [actions.deleteAccount(S)]);
    if (d.status.Failure) throw new Error(`rehearsal delete failed: ${JSON.stringify(d.status.Failure)}`);
    state.rehearsal.deleted = d.transaction.hash;
    save(state);
    log(`rehearsal account deleted, funds returned to the solver: ${d.transaction.hash}`);
  }

  // 2 ---- create + lock the real v3.1 account ------------------------------------------------
  const gk = state.guard.secretKey as KeyPairString;
  if (!state.txs.CREATE_V31_ACCOUNT) {
    await requireSolverBalance(funding, "v3.1 guard account");
    const r = await createAccount(G, gk);
    state.txs.CREATE_V31_ACCOUNT = {
      kind: "CREATE_V31_ACCOUNT",
      label: "Create and fund the v3.1 guard account (storage stake + 0.75 NEAR)",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: REGISTRAR,
      methodName: "create_account",
      expect: "success",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `The solver asks the testnet registrar to create ${G} with one full-access key and ${near(funding)} (the ${wasm.length}-byte wasm needs ${near(wasmStake)} of storage stake).`,
    };
    save(state);
    log(`v3.1 guard account created: ${r.transaction.hash}`);
  }
  if (!state.txs.DEPLOY_INIT_AND_LOCK) {
    const guard = new Account(G, provider, gk);
    const r = await send(guard, G, [
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall("new", cleanInit(G), 50n * TGAS, 0n),
      actions.deleteKey(KeyPair.fromString(gk).getPublicKey()), // LAST: if init fails the whole tx reverts and the key stays
    ]);
    if (r.status.Failure) throw new Error(`deploy/init/lock failed (atomic, key intact, safe to retry): ${JSON.stringify(r.status.Failure)}`);
    state.txs.DEPLOY_INIT_AND_LOCK = {
      kind: "DEPLOY_INIT_AND_LOCK",
      label: "Deploy v3.1, register policy + market table + size caps, delete the only access key",
      hash: r.transaction.hash,
      signerId: G,
      receiverId: G,
      methodName: "new",
      expect: "success",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `One atomic transaction: deploy Risk Guard v3.1, initialise it (policy 200/300/25, price band 100 bps, notional band 50 bps, nonce window -5 min/+60 s, expiry at most 1 h, 24 h window with at most 6 orders, per-market size caps in coins, Hyperliquid testnet market table fetched ${state.markets.fetchedAt}, MPC path ${PATH}), then delete the account's only full-access key.`,
    };
    save(state);
    log(`deployed, initialised and locked: ${r.transaction.hash}`);
  }
  const keys = await keyCount(G);
  if (keys !== 0) throw new Error(`v3.1 account still has ${keys} access keys`);
  const acct = (await viewAccount(G))!;
  if (acct.code_hash !== codeHash) throw new Error(`on-chain code hash ${acct.code_hash} != sha256(${WASM_PATH}) ${codeHash}`);
  const stakeCharged = BigInt(acct.storage_usage) * perByte;
  log(`0 access keys; code hash matches; storage_usage ${acct.storage_usage} bytes = ${near(stakeCharged)} locked as stake; balance ${near(BigInt(acct.amount))}`);

  // 3 ---- approved order ------------------------------------------------------------------
  if (!state.txs.APPROVED_EXECUTABLE_HEDGE_SIGNED) {
    const b = await buildRequest();
    const mirror = buildV31Hedge(G, HL_NETWORK, b.market, b.request.order, b.limit, b.ref, BigInt(b.request.expires_after_ms), POLICY);
    if (mirror.violations.length) throw new Error(`TS mirror rejects the approved request: ${mirror.violations.join("; ")}`);
    const preview = await view<{ approved: boolean; digest_hex: string; violations: string[] }>(G, "preview_executable_hedge", { request: b.request });
    if (!preview.approved || preview.digest_hex !== mirror.digestHex) throw new Error(`preview ${JSON.stringify(preview)} vs mirror ${mirror.digestHex}`);
    b.request.expected_digest_hex = mirror.digestHex; // compare-only assertion; the contract signs its own digest
    const args = { request: b.request, request_mpc_sign: true };
    state.approved = { args, reference: wireE8(b.ref), limit: wireE8(b.limit), expiresAfterMs: b.request.expires_after_ms, recommendation: b.recommendation, overridden: b.overridden };
    save(state);
    log(`${b.request.order.asset_symbol}: ref ${wireE8(b.ref)}, limit ${wireE8(b.limit)}, size ${wireE8(mirror.sizeE8)}, nonce ${b.request.order.nonce}; TS digest ${mirror.digestHex}`);
    const r = await send(solver, G, [actions.functionCall("sign_executable_hedge", args, 300n * TGAS, SIGN_DEPOSIT)]);
    if (r.status.Failure) throw new Error(`sign_executable_hedge failed: ${JSON.stringify(r.status.Failure)} (tx ${r.transaction.hash})`);
    const sig = JSON.parse(decode(r.status.SuccessValue) || "null") as State["hlSignature"] | null;
    if (!sig) throw new Error(`MPC callback returned no signature (tx ${r.transaction.hash})`);
    state.hlSignature = sig;
    const ex = await receiptExecutors(r.transaction.hash, S);
    state.txs.APPROVED_EXECUTABLE_HEDGE_SIGNED = {
      kind: "APPROVED_EXECUTABLE_HEDGE_SIGNED",
      label: "Approved order: contract builds the Hyperliquid order and has the MPC sign its digest",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "sign_executable_hedge",
      expect: "success",
      expectedReceipt: { predecessorId: G, receiverId: MPC, methodName: "sign" },
      mpcReceipt: ex.includes(MPC),
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `Solver submits raw ${b.request.order.asset_symbol} legs (spot $${b.request.order.spot_long_usd_cents / 100}, short $${b.request.order.perp_short_usd_cents / 100}), limit ${wireE8(b.limit)} vs reference ${wireE8(b.ref)} and nonce ${b.request.order.nonce} ms, valid for 45 minutes (expiresAfter). The contract recomputes risk, checks the size caps, builds one IOC sell of ${wireE8(mirror.sizeE8)} on Hyperliquid testnet market ${b.market.asset}, computes the EIP-712 digest itself, calls ${MPC}.sign, and stores {r, s, v}.`,
    };
    save(state);
    log(`approved + MPC-signed: ${r.transaction.hash}`);
  }
  const att = await view<{ digest_hex: string; action_json: string; expires_after_ms: number; order: { nonce: number }; hl_signature: { r: string; s: string; v: number } | null; commitment_hex: string; connection_id_hex: string; size_e8: number; market: V31Market; limit_px_e8: number; reference_px_e8: number; mpc_status: string }>(G, "get_attestation", { index: 0 });
  const recovered = recoverAddress(att.digest_hex, state.hlSignature!);
  if (recovered !== state.derived.evmAddress.toLowerCase()) throw new Error(`signature recovers to ${recovered}, not the derived ${state.derived.evmAddress}`);
  if (JSON.stringify(att.hl_signature) !== JSON.stringify(state.hlSignature)) throw new Error("stored hl_signature differs from the callback result");
  log(`signature over the on-chain digest recovers to the derived address ${recovered}`);
  const approvedNonce = att.order.nonce;

  // 4 ---- the audit attack, and an over-long expiry -----------------------------------------
  const assertRejected = async (r: SendResult, want: string) => {
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!err.includes(want)) throw new Error(`expected ${want}, got ${err || decode(r.status.SuccessValue)} (tx ${r.transaction.hash})`);
    const ex = await receiptExecutors(r.transaction.hash, S);
    if (ex.includes(MPC)) throw new Error(`rejected tx ${r.transaction.hash} has an MPC receipt`);
    const last = await view<number>(G, "get_last_nonce", {});
    const count = await view<number>(G, "get_attestation_count", {});
    if (last !== approvedNonce || count !== 1) throw new Error(`state changed after a rejection: last_nonce ${last}, attestations ${count}`);
    return err;
  };
  const priorRequest = state.approved!.args.request;
  if (!state.txs.INFLATION_ATTACK_REJECTED) {
    // Same legs, limit = reference = one tenth of the market price. Against the deployed v3 this was approved
    // and would have signed ~10x the approved size (checked with a read-only preview before v3.1 was built).
    const market = state.markets.table.find((m) => m.symbol === priorRequest.order.asset_symbol)!;
    const tiny = roundDownToValidPerpPrice(BigInt(priorRequest.reference_px_e8) / 10n, market.sz_decimals);
    const nonce = Date.now();
    const request = { ...priorRequest, run_id: "inflation-attack", order: { ...priorRequest.order, nonce }, limit_px_e8: Number(tiny), reference_px_e8: Number(tiny), expires_after_ms: nonce + EXPIRY_AHEAD_MS, expected_digest_hex: null };
    const args = { request, request_mpc_sign: true };
    state.inflation = { args, limit: wireE8(tiny), reference: wireE8(tiny) };
    const preview = await view<{ approved: boolean; violations: string[] }>(G, "preview_executable_hedge", { request });
    if (preview.approved || !preview.violations.some((v) => v.startsWith("ORDER_SIZE_CAP"))) throw new Error(`preview should refuse the inflation attack with ORDER_SIZE_CAP: ${JSON.stringify(preview)}`);
    const r = await send(solver, G, [actions.functionCall("sign_executable_hedge", args, 300n * TGAS, SIGN_DEPOSIT)]);
    const err = await assertRejected(r, "ORDER_SIZE_CAP");
    const detail = err.match(/ORDER_SIZE_CAP[^"\\]*/)?.[0] ?? "ORDER_SIZE_CAP";
    state.txs.INFLATION_ATTACK_REJECTED = {
      kind: "INFLATION_ATTACK_REJECTED",
      label: "Price-inflation attack (limit = reference = 1/10 of market) rejected by the coin size cap",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "sign_executable_hedge",
      expect: "failure",
      expectedError: "ORDER_SIZE_CAP",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `The approved legs with limit = reference = ${wireE8(tiny)} (about a tenth of the market). Sizing from that price would sell ~10x the approved notional; the contract's per-market size cap, which no solver-supplied price can move, refuses it: ${detail}. No MPC receipt; last_nonce stays ${approvedNonce}.`,
    };
    save(state);
    log(`inflation attack rejected on-chain: ${r.transaction.hash}`);
  }
  if (!state.txs.EXPIRY_TOO_FAR_REJECTED) {
    const nonce = Date.now();
    const request = { ...priorRequest, run_id: "expiry-too-far", order: { ...priorRequest.order, nonce }, expires_after_ms: nonce + 2 * 3_600_000, expected_digest_hex: null };
    const args = { request, request_mpc_sign: true };
    state.expiry = { args };
    const r = await send(solver, G, [actions.functionCall("sign_executable_hedge", args, 300n * TGAS, SIGN_DEPOSIT)]);
    await assertRejected(r, "EXPIRY_TOO_FAR");
    state.txs.EXPIRY_TOO_FAR_REJECTED = {
      kind: "EXPIRY_TOO_FAR_REJECTED",
      label: "expiresAfter two hours ahead rejected (policy maximum is one hour)",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "sign_executable_hedge",
      expect: "failure",
      expectedError: "EXPIRY_TOO_FAR",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: "The approved request with a fresh nonce and expiresAfter set 2 hours ahead. The contract allows at most 1 hour, so a collected signature cannot stay usable at Hyperliquid for days. No MPC receipt.",
    };
    save(state);
    log(`over-long expiry rejected on-chain: ${r.transaction.hash}`);
  }

  // 5 ---- byte-identical replay ---------------------------------------------------------
  if (!state.txs.REPLAY_REJECTED) {
    const r = await send(solver, G, [actions.functionCall("sign_executable_hedge", state.approved!.args, 300n * TGAS, SIGN_DEPOSIT)]);
    const err = await assertRejected(r, "NONCE_ALREADY_USED");
    state.txs.REPLAY_REJECTED = {
      kind: "REPLAY_REJECTED",
      label: "Byte-identical replay of the approved request rejected on-chain",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "sign_executable_hedge",
      expect: "failure",
      expectedError: "NONCE_ALREADY_USED",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: `The exact arguments of the approved transaction (nonce ${approvedNonce}) sent again to get a second signature. Rejected: ${err.includes("STALE_ORDER") ? "NONCE_ALREADY_USED and STALE_ORDER" : "NONCE_ALREADY_USED"}; no MPC receipt.`,
    };
    save(state);
    log(`replay rejected: ${r.transaction.hash}`);
  }

  // 6 ---- private callback ------------------------------------------------------------------
  if (!state.txs.PRIVATE_CALLBACK_REJECTED) {
    const before = JSON.stringify(await view(G, "get_attestation", { index: 0 }));
    const r = await send(solver, G, [actions.functionCall("on_mpc_signed", { index: 0 }, 30n * TGAS, 0n)]);
    const err = JSON.stringify(r.status.Failure ?? "");
    if (!/is private/i.test(err)) throw new Error(`private callback not rejected: ${err || decode(r.status.SuccessValue)} (tx ${r.transaction.hash})`);
    const after = JSON.stringify(await view(G, "get_attestation", { index: 0 }));
    if (before !== after) throw new Error("attestation changed after the private-callback attempt");
    state.txs.PRIVATE_CALLBACK_REJECTED = {
      kind: "PRIVATE_CALLBACK_REJECTED",
      label: "Solver calling the #[private] MPC callback directly is rejected",
      hash: r.transaction.hash,
      signerId: S,
      receiverId: G,
      methodName: "on_mpc_signed",
      expect: "failure",
      expectedError: "is private",
      mpcReceipt: false,
      blockHash: r.transaction_outcome.block_hash,
      explorerUrl: explorer(r.transaction.hash),
      summary: "Only the contract itself may deliver an MPC result. A direct call from the solver panics with 'Method on_mpc_signed is private'; attestation #0 is unchanged.",
    };
    save(state);
    log(`private callback rejected: ${r.transaction.hash}`);
  }

  // 7 ---- proof file ------------------------------------------------------------------------
  const finalAcct = (await viewAccount(G))!;
  const config = await view<Record<string, unknown>>(G, "get_config", {});
  const existing = JSON.parse(readFileSync(PROOF_FILE, "utf8"));
  if (existing.version === 3) {
    mkdirSync("proofs", { recursive: true });
    writeFileSync(V3_COPY, readFileSync(PROOF_FILE)); // byte-identical copy of the v3 proof
  } else if (existing.version !== 3.1) {
    throw new Error(`testnet-proof.json is version ${existing.version}; expected the v3 proof to supersede (or an existing v3.1 proof to refresh). Refusing to overwrite.`);
  }
  const v3Bytes = readFileSync(V3_COPY);
  const v3Proof = JSON.parse(v3Bytes.toString("utf8"));
  const order: Kind[] = ["CREATE_V31_ACCOUNT", "DEPLOY_INIT_AND_LOCK", "APPROVED_EXECUTABLE_HEDGE_SIGNED", "INFLATION_ATTACK_REJECTED", "EXPIRY_TOO_FAR_REJECTED", "REPLAY_REJECTED", "PRIVATE_CALLBACK_REJECTED"];
  const action = JSON.parse(att.action_json);
  const proof = {
    network: "testnet",
    version: 3.1,
    release: "v3.1",
    createdAt: new Date().toISOString(),
    contract: {
      accountId: G,
      codeHash: finalAcct.code_hash,
      wasmPath: WASM_PATH,
      wasmBytes: wasm.length,
      wasmSha256Hex: wasmSha.toString("hex"),
      sourcePath: "contracts/risk-guard-v31/src/lib.rs",
      policy: POLICY,
      hlNetwork: HL_NETWORK,
      markets: state.markets.table,
      marketsFetchedAt: state.markets.fetchedAt,
      marketsSource: `${HL_INFO} {"type":"meta"} (live table == pinned HYPERLIQUID_PERPS_TESTNET)`,
      mpcSignerContract: MPC,
      mpcPath: PATH,
      locked: true,
      accessKeys: 0,
      storage: {
        storageAmountPerByteYocto: perByte.toString(),
        wasmStakeYocto: wasmStake.toString(),
        fundedYocto: funding.toString(),
        storageUsageBytes: finalAcct.storage_usage,
        stakeChargedYocto: (BigInt(finalAcct.storage_usage) * perByte).toString(),
      },
      config,
    },
    accounts: { guard: G, solver: S },
    hedgeKey: {
      path: PATH,
      predecessor: G,
      derivedPublicKey: state.derived.publicKey,
      evmAddress: state.derived.evmAddress,
      note: "Hyperliquid must recover THIS address from the signature. It differs from v3's key (a different contract is the MPC caller) and from v2's zerodelta/hedge/arbitrum key.",
    },
    approvedHedge: {
      index: 0,
      args: state.approved!.args,
      referencePx: state.approved!.reference,
      limitPx: state.approved!.limit,
      expiresAfterMs: att.expires_after_ms,
      swarmRecommendation: state.approved!.recommendation,
      demoOverride: state.approved!.overridden,
      market: att.market,
      sizeE8: att.size_e8,
      connectionIdHex: att.connection_id_hex,
      digestHex: att.digest_hex,
      commitmentHex: att.commitment_hex,
      digestMatchesTsMirror: true,
      /** POST body for https://api.hyperliquid-testnet.xyz/exchange. `expiresAfter` is part of the signed digest. */
      exchangeRequest: { action, nonce: att.order.nonce, expiresAfter: att.expires_after_ms, signature: state.hlSignature, vaultAddress: null },
      recoveredAddressOffline: recovered,
    },
    rehearsal: {
      note: "Throwaway keyed account used to rehearse deploy + init before the real locked deploy; deleted afterwards, funds returned to the solver.",
      accountId: RH,
      transactions: [state.rehearsal.created, state.rehearsal.deployed, state.rehearsal.deleted],
      previewDigestMatchedTsMirror: true,
    },
    inflationAttempt: { args: state.inflation!.args, limit: state.inflation!.limit, reference: state.inflation!.reference, expectedError: "ORDER_SIZE_CAP" },
    expiryAttempt: { args: state.expiry!.args, expectedError: "EXPIRY_TOO_FAR" },
    replayAttempt: { nonce: approvedNonce, expectedError: "NONCE_ALREADY_USED" },
    transactions: order.map((k) => state.txs[k]!),
    supersededV3: {
      contract: v3Proof.contract.accountId,
      hedgeAddress: v3Proof.hedgeKey.evmAddress,
      note: "Risk Guard v3 stays deployed and locked, so it cannot be patched. A pre-merge audit found the issues below; v3.1 is the deployment this project stands behind. The v3 proof is kept unchanged under previousDeployment.",
      findings: [
        "HIGH: size = approved notional / limit price, and the limit is only checked against a reference the same solver supplies, so limit = reference = a small price got an order many times the approved size approved (confirmed with a read-only preview of the deployed contract: 2x at 1/2 price, 10x at 1/10). Fixed in v3.1 by per-market size caps in coins.",
        "MEDIUM: no cumulative cap, so approved hedges could stack. Fixed in v3.1 by a rolling-window size cap and an order-count cap.",
        "MEDIUM: no expiresAfter, so a signature stayed usable at Hyperliquid for days. Fixed in v3.1 by a policy-bounded expiresAfter hashed into the order.",
        "LOW: an MPC response that did not deserialize left the attestation Pending; the $10 Hyperliquid minimum was not enforced. Fixed in v3.1.",
      ],
    },
    previousDeploymentFile: { path: V3_COPY, sha256: createHash("sha256").update(v3Bytes).digest("hex") },
    previousDeployment: v3Proof,
  };
  writeFileSync(PROOF_FILE, JSON.stringify(proof, null, 2) + "\n");
  log(`wrote ${PROOF_FILE} (v3.1 + v3 + v2 under previousDeployment) and ${V3_COPY}`);
  for (const t of proof.transactions) log(`  ${t.label}: ${t.explorerUrl}`);
}

if (process.argv[1]?.endsWith("testnet-setup-v31.ts")) {
  main().catch((err) => {
    console.error(`[testnet-setup-v31] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
