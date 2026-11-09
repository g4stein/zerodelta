/**
 * Live NEAR network access layer.
 *
 * - NEAR JSON-RPC (testnet + mainnet) with endpoint failover and timeouts.
 * - NEAR Chain Signatures MPC contract reads (`v1.signer-prod.testnet`).
 * - NEAR Intents Verifier reads + `simulate_intents` dry-runs (`intents.near`).
 * - NEAR Intents 1Click API (`/v0/tokens`, `/v0/quote` with `dry: true`).
 *
 * Every function either returns live data or a clearly labelled failure /
 * fallback object. Nothing here throws on network errors, so the UI and the
 * verification harness never crash when offline.
 */
import { bytesToHex, canonicalJson, fromBase58, keccak256Bytes, keccak256Hex, utf8ToBytes } from "../crypto/encoding";
import type { SignedNep413Intent } from "./nep413";

export type NearNetwork = "testnet" | "mainnet";

/**
 * FastNEAR first: since Nov 2026 rpc.*.near.org answers some requests with a JSON-RPC
 * -429 "endpoint deprecated" error. Both stay in the list for failover.
 */
export const RPC_ENDPOINTS: Record<NearNetwork, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"],
};

/** JSON-RPC errors that describe the endpoint, not the request: try the next endpoint. */
export function isTransientRpcError(error: { code?: number; message?: string; cause?: { name?: string } }): boolean {
  const name = error.cause?.name ?? "";
  if (["TOO_MANY_REQUESTS", "INTERNAL_ERROR", "TIMEOUT_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET"].includes(name)) return true;
  if (error.code === -429 || error.code === 429) return true;
  if (!name && /deprecated|rate limit|too many|unavailable/i.test(error.message ?? "")) return true;
  return false;
}

export const MPC_CONTRACT = "v1.signer-prod.testnet";
export const INTENTS_VERIFIER = "intents.near";
export const ONECLICK_BASE = "https://1click.chaindefuser.com";

const DEFAULT_TIMEOUT_MS = 8_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "timeout" : err.message;
  return String(err);
}

export interface RpcSuccess<T> {
  ok: true;
  result: T;
  endpoint: string;
  latencyMs: number;
}
export interface RpcFailure {
  ok: false;
  error: string;
  endpoint?: string;
}
export type RpcResponse<T> = RpcSuccess<T> | RpcFailure;

/** JSON-RPC call with automatic failover across public endpoints. */
export async function nearRpc<T>(
  network: NearNetwork,
  method: string,
  params: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcResponse<T>> {
  const errors: string[] = [];
  for (const endpoint of RPC_ENDPOINTS[network]) {
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "zerodelta", method, params }),
        },
        timeoutMs,
      );
      if (!res.ok) {
        errors.push(`${endpoint}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string; cause?: { name?: string } } };
      if (body.error) {
        const label = body.error.cause?.name ?? body.error.message?.slice(0, 120) ?? "rpc error";
        if (isTransientRpcError(body.error)) {
          errors.push(`${endpoint}: ${label}`);
          continue;
        }
        // A semantic JSON-RPC error (e.g. UNKNOWN_ACCOUNT) is authoritative; don't fail over.
        return { ok: false, endpoint, error: label };
      }
      return { ok: true, result: body.result as T, endpoint, latencyMs: Date.now() - started };
    } catch (err) {
      errors.push(`${endpoint}: ${errorMessage(err)}`);
    }
  }
  return { ok: false, error: errors.join("; ") || "no endpoints" };
}

// ---------------------------------------------------------------------------
// Network status
// ---------------------------------------------------------------------------

export interface NetworkStatus {
  live: boolean;
  network: NearNetwork;
  chainId?: string;
  protocolVersion?: number;
  latestBlockHeight?: number;
  latestBlockHash?: string;
  latestBlockTime?: string;
  gasPriceYocto?: string;
  endpoint?: string;
  latencyMs?: number;
  error?: string;
}

interface StatusResult {
  chain_id: string;
  protocol_version: number;
  sync_info: { latest_block_height: number; latest_block_hash: string; latest_block_time: string };
}

export async function getNetworkStatus(network: NearNetwork): Promise<NetworkStatus> {
  const [status, gas] = await Promise.all([
    nearRpc<StatusResult>(network, "status", []),
    nearRpc<{ gas_price: string }>(network, "gas_price", [null]),
  ]);
  if (!status.ok) return { live: false, network, error: status.error };
  return {
    live: true,
    network,
    chainId: status.result.chain_id,
    protocolVersion: status.result.protocol_version,
    latestBlockHeight: status.result.sync_info.latest_block_height,
    latestBlockHash: status.result.sync_info.latest_block_hash,
    latestBlockTime: status.result.sync_info.latest_block_time,
    gasPriceYocto: gas.ok ? gas.result.gas_price : undefined,
    endpoint: status.endpoint,
    latencyMs: status.latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Accounts and view calls
// ---------------------------------------------------------------------------

export interface AccountState {
  live: boolean;
  network: NearNetwork;
  accountId: string;
  exists: boolean;
  isContract?: boolean;
  balanceNear?: string;
  codeHash?: string;
  storageUsageBytes?: number;
  blockHeight?: number;
  blockHash?: string;
  error?: string;
}

interface ViewAccountResult {
  amount: string;
  code_hash: string;
  storage_usage: number;
  block_height: number;
  block_hash: string;
}

const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export function yoctoToNearString(yocto: string, decimals = 2): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, decimals);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

export async function viewAccount(network: NearNetwork, accountId: string): Promise<AccountState> {
  const r = await nearRpc<ViewAccountResult>(network, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (!r.ok) {
    const missing = r.error.includes("UNKNOWN_ACCOUNT");
    return { live: missing, network, accountId, exists: false, error: r.error };
  }
  return {
    live: true,
    network,
    accountId,
    exists: true,
    isContract: r.result.code_hash !== EMPTY_CODE_HASH,
    balanceNear: yoctoToNearString(r.result.amount),
    codeHash: r.result.code_hash,
    storageUsageBytes: r.result.storage_usage,
    blockHeight: r.result.block_height,
    blockHash: r.result.block_hash,
  };
}

export type ViewResult<T> =
  | { ok: true; value: T; blockHeight: number; endpoint: string }
  | { ok: false; error: string; contractPanic?: string };

interface CallFunctionResult {
  result?: number[];
  error?: string;
  block_height: number;
  logs: string[];
}

/** Calls a read-only contract method. Contract panics are returned, not thrown. */
export async function viewFunction<T>(
  network: NearNetwork,
  contractId: string,
  methodName: string,
  args: unknown = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ViewResult<T>> {
  const r = await nearRpc<CallFunctionResult>(
    network,
    "query",
    {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    timeoutMs,
  );
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.result || typeof r.result !== "object") return { ok: false, error: "malformed call_function response" };
  if (r.result.error || !Array.isArray(r.result.result)) {
    const raw = r.result.error ?? "empty result";
    const panic = /panic_msg: \\?"([^"\\]*)/.exec(raw)?.[1];
    return { ok: false, error: raw, contractPanic: panic ?? raw };
  }
  const text = Buffer.from(r.result.result).toString("utf8");
  try {
    return { ok: true, value: JSON.parse(text) as T, blockHeight: r.result.block_height, endpoint: r.endpoint };
  } catch {
    return { ok: false, error: "view result is not valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// NEAR Chain Signatures (MPC)
// ---------------------------------------------------------------------------

export interface MpcContractInfo {
  live: boolean;
  contractId: string;
  version?: string;
  rootPublicKey?: string;
  signatureDomains?: number;
  blockHeight?: number;
  error?: string;
}

export async function getMpcContractInfo(): Promise<MpcContractInfo> {
  const [version, rootKey, state] = await Promise.all([
    viewFunction<string>("testnet", MPC_CONTRACT, "version"),
    viewFunction<string>("testnet", MPC_CONTRACT, "public_key"),
    viewFunction<{ Running?: { domains?: { domains?: unknown[] } } }>("testnet", MPC_CONTRACT, "state"),
  ]);
  if (!version.ok && !rootKey.ok) {
    return { live: false, contractId: MPC_CONTRACT, error: version.ok ? undefined : version.error };
  }
  return {
    live: true,
    contractId: MPC_CONTRACT,
    version: version.ok ? version.value : undefined,
    rootPublicKey: rootKey.ok ? rootKey.value : undefined,
    signatureDomains: state.ok ? state.value.Running?.domains?.domains?.length : undefined,
    blockHeight: rootKey.ok ? rootKey.blockHeight : undefined,
  };
}

/** EIP-55 checksummed address from a 64-byte uncompressed secp256k1 key (no 0x04 prefix). */
export function evmAddressFromSecp256k1(publicKey: string): string {
  const raw = fromBase58(publicKey.replace(/^secp256k1:/, ""));
  const xy = raw.length === 65 ? raw.slice(1) : raw;
  if (xy.length !== 64) throw new Error(`unexpected secp256k1 key length ${raw.length}`);
  const addr = bytesToHex(keccak256Bytes(xy).slice(-20));
  const hash = keccak256Hex(utf8ToBytes(addr));
  let out = "0x";
  for (let i = 0; i < addr.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}

export interface DerivedMpcAccount {
  live: boolean;
  path: string;
  predecessor: string;
  derivedPublicKey?: string;
  evmAddress?: string;
  error?: string;
}

/** Asks the live MPC contract which secp256k1 key (and thus EVM address) a NEAR account controls at `path`. */
export async function getMpcDerivedAccount(path: string, predecessor: string): Promise<DerivedMpcAccount> {
  const r = await viewFunction<string>("testnet", MPC_CONTRACT, "derived_public_key", {
    path,
    predecessor,
    domain_id: 0,
  });
  if (!r.ok) return { live: false, path, predecessor, error: r.error };
  return { live: true, path, predecessor, derivedPublicKey: r.value, evmAddress: evmAddressFromSecp256k1(r.value) };
}

// ---------------------------------------------------------------------------
// NEAR Intents Verifier (intents.near) dry-run
// ---------------------------------------------------------------------------

export type IntentSimulationStatus =
  | "EXECUTED" // signature valid and intents executed in simulation
  | "SIGNATURE_ACCEPTED_UNFUNDED" // signature valid, contract stopped at balance check
  | "INVALID_SIGNATURE"
  | "REJECTED" // other contract-level rejection (nonce, deadline, ...)
  | "UNREACHABLE";

export interface IntentSimulation {
  status: IntentSimulationStatus;
  contractId: string;
  network: NearNetwork;
  intentHashes: string[];
  panicMessage?: string;
  currentSalt?: string;
  blockHeight?: number;
  error?: string;
}

interface SimulateOutput {
  intents_executed: { intent_hash: string; account_id: string; nonce: string }[];
  state?: { current_salt?: string };
}

/**
 * Runs the signed intents through `intents.near`'s `simulate_intents` view method on
 * NEAR mainnet. This executes the real Verifier contract code (signature check,
 * nonce check, balance accounting) without committing state or spending funds.
 */
export async function simulateIntents(signed: SignedNep413Intent[]): Promise<IntentSimulation> {
  const base = { contractId: INTENTS_VERIFIER, network: "mainnet" as const, intentHashes: [] as string[] };
  const r = await viewFunction<SimulateOutput>("mainnet", INTENTS_VERIFIER, "simulate_intents", { signed }, 10_000);
  if (r.ok) {
    return {
      ...base,
      status: "EXECUTED",
      intentHashes: r.value.intents_executed.map((i) => i.intent_hash),
      currentSalt: r.value.state?.current_salt,
      blockHeight: r.blockHeight,
    };
  }
  if (!r.contractPanic) return { ...base, status: "UNREACHABLE", error: r.error };
  const panic = r.contractPanic;
  if (/invalid signature/i.test(panic)) return { ...base, status: "INVALID_SIGNATURE", panicMessage: panic };
  if (/insufficient balance/i.test(panic)) return { ...base, status: "SIGNATURE_ACCEPTED_UNFUNDED", panicMessage: panic };
  return { ...base, status: "REJECTED", panicMessage: panic };
}

// ---------------------------------------------------------------------------
// NEAR Intents 1Click API
// ---------------------------------------------------------------------------

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

export interface OneClickTokenFeed {
  live: boolean;
  source: string;
  tokens: OneClickToken[];
  count: number;
  chains: string[];
  fetchedAt: string;
  latencyMs?: number;
  error?: string;
}

/** Minimal snapshot used only if the live 1Click API is unreachable. Prices are from 2026-11-08. */
export const ONECLICK_TOKEN_SNAPSHOT: OneClickToken[] = [
  { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, blockchain: "near", symbol: "USDC", price: 0.9995 },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 3.64 },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", price: 89.36 },
  { assetId: "nep141:arb.omft.near", decimals: 18, blockchain: "arb", symbol: "ETH", price: 2230.49 },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: 2230.49 },
  { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: 75792 },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, blockchain: "arb", symbol: "USDC", price: 0.9995 },
  { assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", decimals: 6, blockchain: "sol", symbol: "USDC", price: 0.9995 },
];

function summarizeTokens(tokens: OneClickToken[]) {
  return { count: tokens.length, chains: [...new Set(tokens.map((t) => t.blockchain))].sort() };
}

export async function fetchOneClickTokens(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<OneClickTokenFeed> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(`${ONECLICK_BASE}/v0/tokens`, { headers: { accept: "application/json" } }, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tokens = (await res.json()) as OneClickToken[];
    if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("empty token list");
    return {
      live: true,
      source: `${ONECLICK_BASE}/v0/tokens`,
      tokens,
      ...summarizeTokens(tokens),
      fetchedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      live: false,
      source: "bundled-snapshot-2026-11-08",
      tokens: ONECLICK_TOKEN_SNAPSHOT,
      ...summarizeTokens(ONECLICK_TOKEN_SNAPSHOT),
      fetchedAt: new Date().toISOString(),
      error: errorMessage(err),
    };
  }
}

export interface OneClickQuoteRequest {
  dry: true;
  swapType: "EXACT_INPUT";
  slippageTolerance: number; // basis points
  originAsset: string;
  depositType: "INTENTS";
  destinationAsset: string;
  amount: string; // smallest units of originAsset
  refundTo: string;
  refundType: "INTENTS";
  recipient: string;
  recipientType: "INTENTS" | "DESTINATION_CHAIN";
  deadline: string;
}

export interface OneClickQuote {
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  timeEstimate: number;
}

export interface OneClickQuoteResponse {
  live: boolean;
  quote?: OneClickQuote;
  appFeeBps: number;
  quoteSignature?: string;
  correlationId?: string;
  timestamp?: string;
  latencyMs?: number;
  error?: string;
}

interface RawQuoteResponse {
  quote: OneClickQuote;
  quoteRequest?: { appFees?: { fee: number }[] };
  signature?: string;
  correlationId?: string;
  timestamp?: string;
  message?: string;
}

/** Requests a dry-run (non-binding, no deposit address) quote from the 1Click API. */
export async function fetchOneClickQuote(
  request: OneClickQuoteRequest,
  timeoutMs = 10_000,
): Promise<OneClickQuoteResponse> {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      `${ONECLICK_BASE}/v0/quote`,
      { method: "POST", headers: { "content-type": "application/json" }, body: canonicalJson(request) },
      timeoutMs,
    );
    const body = (await res.json().catch(() => ({}))) as Partial<RawQuoteResponse>;
    if (!res.ok || !body.quote) throw new Error(body.message ?? `HTTP ${res.status}`);
    const appFeeBps = (body.quoteRequest?.appFees ?? []).reduce((s, f) => s + (f.fee ?? 0), 0);
    return {
      live: true,
      quote: body.quote,
      appFeeBps,
      quoteSignature: body.signature,
      correlationId: body.correlationId,
      timestamp: body.timestamp,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { live: false, appFeeBps: 0, error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Aggregated telemetry for the dashboard header and GET /api/swarm
// ---------------------------------------------------------------------------

export interface LiveTelemetry {
  fetchedAt: string;
  testnet: NetworkStatus;
  mainnet: NetworkStatus;
  intentsVerifier: AccountState;
  mpcSigner: AccountState;
  mpc: MpcContractInfo;
  oneClick: Omit<OneClickTokenFeed, "tokens"> & { sample: OneClickToken[] };
}

export async function getLiveTelemetry(): Promise<LiveTelemetry> {
  const [testnet, mainnet, intentsVerifier, mpcSigner, mpc, tokens] = await Promise.all([
    getNetworkStatus("testnet"),
    getNetworkStatus("mainnet"),
    viewAccount("mainnet", INTENTS_VERIFIER),
    viewAccount("testnet", MPC_CONTRACT),
    getMpcContractInfo(),
    fetchOneClickTokens(),
  ]);
  const { tokens: list, ...rest } = tokens;
  const interesting = new Set(["wNEAR", "SOL", "ETH", "BTC", "USDC"]);
  return {
    fetchedAt: new Date().toISOString(),
    testnet,
    mainnet,
    intentsVerifier,
    mpcSigner,
    mpc,
    oneClick: { ...rest, sample: list.filter((t) => interesting.has(t.symbol)).slice(0, 12) },
  };
}
