import { verifyRecordedAcceptance } from "../src/lib/hyperliquid/acceptance";
/**
 * ZeroDelta automated verification harness  —  `npm run verify`
 *
 * Checks every claim in README.md against reality:
 *   1. NEP-413 Ed25519 intent signing (local, real cryptography)
 *   2. Live NEAR JSON-RPC on testnet + mainnet
 *   3. Live NEAR Chain Signatures MPC contract (v1.signer-prod.testnet)
 *   4. Live intents.near Verifier dry-run (simulate_intents on mainnet)
 *   5. Live NEAR Intents 1Click API (/v0/tokens, /v0/quote dry)
 *   6. Live Hyperliquid funding feed
 *   7. Deterministic risk policy, TS/Rust mirror vectors, adversarial cases offline
 *   8. Full live swarm: multi-asset ranking, Agent 1/2 negotiation, approved
 *      rebalance, rogue trade, compromised solver; the deployed contract
 *      recomputes each order (`check_order_params`)
 *   9. On-chain testnet proof: locked Risk Guard v2 contract, policy, attestation,
 *      contract-issued MPC sign receipt, and every transaction in
 *      testnet-proof.json re-checked with EXPERIMENTAL_tx_status (archival RPC),
 *      plus offline MPC signature recovery
 *  10. Risk Guard v3 (testnet): v2 history preserved, v3 wasm/code hash, testnet market
 *      table, recorded digest == TS mirror, MPC signature recovers to the hedge address,
 *      recorded Hyperliquid acceptance, parity fixture current (all offline); then every
 *      v3 tx re-checked, no MPC receipt on rejected txs, locked contract config,
 *      attestation #0, on-chain digest == TS digest, live derived key (live, read-only).
 *      Nothing is posted to Hyperliquid by this harness; see `npm run hl:acceptance`.
 *
 * Result levels: PASS, WARN (live source unavailable, labelled fallback used),
 * SKIP (offline mode), FAIL. Exit code is 1 if anything FAILs, else 0.
 *
 * Offline mode (no network): `ZERODELTA_OFFLINE=1 npm run verify` or `npm run verify -- --offline`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { actionHash, buildHedgeAction, checkActionMatchesApprovedHedge, orderAction, orderWire, signL1Action } from "../src/lib/hyperliquid/exchangeSigning";
import { runScannerAgent, probeEntryCosts } from "../src/lib/agents/scannerAgent";
import { FUNDING_SNAPSHOT } from "../src/lib/market/fundingFeed";
import { ONECLICK_TOKEN_SNAPSHOT } from "../src/lib/near/rpcClient";
import {
  TESTNET_PROOF,
  checkOrderOnchain,
  getOnchainGuardState,
  verifyMpcSignature,
  verifyProofTx,
  type OnchainAttestation,
  type TxVerification,
} from "../src/lib/near/riskGuardContract";
import { commitmentPreimage, computeHedgePayloadHex, computeOrderMetrics } from "../src/lib/near/orderCommitment";
import { RISK_GUARD_CONTRACT_ID } from "../src/lib/near/deployment";
import { getSolverEnclave } from "../src/lib/agents/solverAgent";
import { viewFunction } from "../src/lib/near/rpcClient";
import { sha256Bytes, toBase58 } from "../src/lib/crypto/encoding";
import { KeyPair, KeyPairSigner, type KeyPairEd25519 } from "near-api-js";
import {
  buildIntentMessage,
  createEphemeralSigner,
  generateNonce,
  signNep413,
  tamperSignature,
  verifyNep413,
} from "../src/lib/near/nep413";
import {
  INTENTS_VERIFIER,
  MPC_CONTRACT,
  fetchOneClickQuote,
  fetchOneClickTokens,
  getMpcContractInfo,
  getMpcDerivedAccount,
  getNetworkStatus,
  simulateIntents,
  viewAccount,
} from "../src/lib/near/rpcClient";
import { fetchFundingFeed } from "../src/lib/market/fundingFeed";
import { evaluateRiskInvariants, GUARDIAN_NEAR_ACCOUNT, HEDGE_DERIVATION_PATH, runGuardianAgent, verifyGuardianDecision } from "../src/lib/agents/guardianAgent";
import { runSwarm, verifyAuditChain } from "../src/lib/swarm/orchestrator";
import { USDC_NEAR_ASSET } from "../src/lib/swarm/types";
import { bytesToHex } from "../src/lib/crypto/encoding";
import { V3_PROOF_JSON, V31_PROOF_JSON } from "../src/lib/near/proofFile";
import { getAccessKeyCount, type ProofTx } from "../src/lib/near/riskGuardContract";
import { nearRpc } from "../src/lib/near/rpcClient";
import { HYPERLIQUID_PERPS_TESTNET } from "../src/lib/hyperliquid/exchangeSigning";
import { buildV3Hedge, type V3Market } from "../src/lib/hyperliquid/v3Hedge";
import { buildV31Hedge, coinsToE8, V31_SIZE_CAPS, type V31Market } from "../src/lib/hyperliquid/v31Hedge";
import { recoverAddress } from "./testnet-setup-v3";
import { buildHlVectors, HL_VECTORS_PATH } from "./hl-vectors";
import { buildHlVectorsV31, HL_VECTORS_V31_PATH } from "./hl-vectors-v31";

/** Key-order-independent JSON, for comparing objects that were re-serialised. */
const canonicalJson = (o: unknown): string =>
  JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

type Level = "PASS" | "WARN" | "SKIP" | "FAIL";
interface Result {
  section: string;
  name: string;
  level: Level;
  detail: string;
}

const offline = process.argv.includes("--offline") || process.env.ZERODELTA_OFFLINE === "1";
/** Untracked by default so local runs don't dirty the repo; `npm run verify:report` refreshes the committed snapshot. */
const REPORT_PATH = process.env.VERIFY_REPORT_PATH ?? "verify-report.local.json";
const results: Result[] = [];
const color = { PASS: "\x1b[32m", WARN: "\x1b[33m", SKIP: "\x1b[90m", FAIL: "\x1b[31m", reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m" };
const icon: Record<Level, string> = { PASS: "✔", WARN: "▲", SKIP: "○", FAIL: "✘" };

let section = "";
function heading(title: string) {
  section = title;
  console.log(`\n${color.bold}${color.cyan}▸ ${title}${color.reset}`);
}
function record(name: string, level: Level, detail: string) {
  results.push({ section, name, level, detail });
  console.log(`  ${color[level]}${icon[level]} ${level}${color.reset}  ${name}${detail ? `  ${"\x1b[90m"}— ${detail}${color.reset}` : ""}`);
}
function check(name: string, ok: boolean, detail: string, failLevel: Level = "FAIL") {
  record(name, ok ? "PASS" : failLevel, detail);
  return ok;
}
async function live(name: string, fn: () => Promise<void>) {
  if (offline) return record(name, "SKIP", "offline mode");
  try {
    await fn();
  } catch (err) {
    record(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  const started = Date.now();
  console.log(`${color.bold}ZeroDelta — hackathon verification harness${color.reset}`);
  console.log(`mode: ${offline ? "OFFLINE (live checks skipped)" : "LIVE (real NEAR RPC, intents.near, 1Click, Hyperliquid)"}`);

  // 1 ------------------------------------------------------------------------
  heading("1. NEP-413 Ed25519 intent cryptography");
  const signer = createEphemeralSigner();
  check("Ephemeral ed25519 key + implicit account", /^[0-9a-f]{64}$/.test(signer.accountId), `${signer.publicKey} → ${signer.accountId}`);
  const nonce = generateNonce();
  check("32-byte random nonce", nonce.length === 32, bytesToHex(nonce));
  const probeMessage = buildIntentMessage({ signer_id: signer.accountId, deadline: new Date(Date.now() + 10 * 60_000).toISOString(), intents: [] });
  const probe = signNep413(signer.keyPair, { message: probeMessage, nonce, recipient: INTENTS_VERIFIER });
  const v = verifyNep413(probe.signed);
  check("Signature verifies (tweetnacl)", v.tweetnaclValid, `sig ${probe.signatureHex.slice(0, 32)}…`);
  check("Signature verifies (near-api-js PublicKey.verify)", v.nearApiJsValid, `sha256(borsh) ${probe.payloadHashHex.slice(0, 32)}…`);
  const kp = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
  const p = { message: "zerodelta", nonce: generateNonce(), recipient: INTENTS_VERIFIER };
  const theirs = await new KeyPairSigner(kp).signNep413Message("zerodelta.near", p);
  check("Byte-identical to near-api-js KeyPairSigner.signNep413Message", bytesToHex(theirs.signature) === signNep413(kp, p).signatureHex, "independent implementation cross-check");
  check("Tampered signature rejected locally", !verifyNep413(tamperSignature(probe.signed)).valid, "1 bit flipped");

  // 2 ------------------------------------------------------------------------
  heading("2. Live NEAR JSON-RPC");
  for (const network of ["testnet", "mainnet"] as const) {
    await live(`${network} status + gas price`, async () => {
      const s = await getNetworkStatus(network);
      check(`${network} status + gas price`, s.live && (s.latestBlockHeight ?? 0) > 0, s.live ? `block #${s.latestBlockHeight} ${s.latestBlockHash} · gas ${s.gasPriceYocto} · ${s.endpoint} ${s.latencyMs}ms` : String(s.error));
    });
  }
  await live(`view_account ${INTENTS_VERIFIER} (mainnet)`, async () => {
    const a = await viewAccount("mainnet", INTENTS_VERIFIER);
    check(`view_account ${INTENTS_VERIFIER} (mainnet)`, a.exists && a.isContract === true, a.exists ? `contract code ${a.codeHash}, ${a.storageUsageBytes?.toLocaleString()} bytes storage, block #${a.blockHeight}` : String(a.error));
  });
  await live(`view_account ${MPC_CONTRACT} (testnet)`, async () => {
    const a = await viewAccount("testnet", MPC_CONTRACT);
    check(`view_account ${MPC_CONTRACT} (testnet)`, a.exists && a.isContract === true, a.exists ? `contract code ${a.codeHash}, balance ${a.balanceNear} NEAR` : String(a.error));
  });

  // 3 ------------------------------------------------------------------------
  heading("3. NEAR Chain Signatures MPC (v1.signer-prod.testnet)");
  await live("MPC contract version + root public key", async () => {
    const m = await getMpcContractInfo();
    check("MPC contract version + root public key", m.live && Boolean(m.rootPublicKey?.startsWith("secp256k1:")), `v${m.version}, ${m.signatureDomains ?? "?"} domains, root ${m.rootPublicKey?.slice(0, 30)}…`);
  });
  await live("derived_public_key → hedge EVM address", async () => {
    const d = await getMpcDerivedAccount(HEDGE_DERIVATION_PATH, GUARDIAN_NEAR_ACCOUNT);
    check("derived_public_key → hedge EVM address", d.live && /^0x[0-9a-fA-F]{40}$/.test(d.evmAddress ?? ""), d.live ? `${GUARDIAN_NEAR_ACCOUNT} / ${HEDGE_DERIVATION_PATH} → ${d.evmAddress}` : String(d.error));
  });

  // 4 ------------------------------------------------------------------------
  heading("4. Live intents.near Verifier (simulate_intents on mainnet)");
  await live("Signed NEP-413 auth probe executes", async () => {
    const r = await simulateIntents([probe.signed]);
    check("Signed NEP-413 auth probe executes", r.status === "EXECUTED" && r.intentHashes.length === 1, r.status === "EXECUTED" ? `intent_hash ${r.intentHashes[0]} (salt ${r.currentSalt})` : `${r.status} ${r.panicMessage ?? r.error ?? ""}`);
  });
  await live("Tampered signature rejected by contract", async () => {
    const s2 = createEphemeralSigner();
    const signed = signNep413(s2.keyPair, {
      message: buildIntentMessage({ signer_id: s2.accountId, deadline: new Date(Date.now() + 600_000).toISOString(), intents: [] }),
      nonce: generateNonce(),
      recipient: INTENTS_VERIFIER,
    });
    const r = await simulateIntents([tamperSignature(signed.signed)]);
    check("Tampered signature rejected by contract", r.status === "INVALID_SIGNATURE", `${r.status}: ${r.panicMessage ?? r.error ?? ""}`);
  });
  await live("token_diff rebalance intent passes signature check", async () => {
    const s3 = createEphemeralSigner();
    const signed = signNep413(s3.keyPair, {
      message: buildIntentMessage({
        signer_id: s3.accountId,
        deadline: new Date(Date.now() + 600_000).toISOString(),
        intents: [{ intent: "token_diff", diff: { [USDC_NEAR_ASSET]: "-1000000000", "nep141:wrap.near": "270000000000000000000000000" } }],
      }),
      nonce: generateNonce(),
      recipient: INTENTS_VERIFIER,
    });
    const r = await simulateIntents([signed.signed]);
    check("token_diff rebalance intent passes signature check", r.status === "SIGNATURE_ACCEPTED_UNFUNDED" || r.status === "EXECUTED", `${r.status}: ${r.panicMessage ?? "executed"} (expected: unfunded demo account)`);
  });

  // 5 ------------------------------------------------------------------------
  heading("5. Live NEAR Intents 1Click API");
  await live("GET /v0/tokens", async () => {
    const t = await fetchOneClickTokens();
    const hasNear = t.tokens.some((x) => x.assetId === "nep141:wrap.near");
    check("GET /v0/tokens", t.live && hasNear, t.live ? `${t.count} assets across ${t.chains.length} chains (${t.chains.slice(0, 8).join(", ")}…) in ${t.latencyMs}ms` : `fallback: ${t.error}`);
  });
  await live("POST /v0/quote (dry)", async () => {
    const q = await fetchOneClickQuote({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 25,
      originAsset: USDC_NEAR_ASSET,
      depositType: "INTENTS",
      destinationAsset: "nep141:wrap.near",
      amount: "1000000000",
      refundTo: signer.accountId,
      refundType: "INTENTS",
      recipient: signer.accountId,
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (q.live && q.quote) record("POST /v0/quote (dry)", "PASS", `1000 USDC → ${q.quote.amountOutFormatted} wNEAR ($${Number(q.quote.amountOutUsd).toFixed(2)}), quote sig ${q.quoteSignature?.slice(0, 24)}…`);
    else record("POST /v0/quote (dry)", "WARN", `live quote unavailable (${q.error}); the solver falls back to its deterministic local quote`);
  });

  // 6 ------------------------------------------------------------------------
  heading("6. Live perp funding feed (Hyperliquid)");
  await live("metaAndAssetCtxs funding", async () => {
    const f = await fetchFundingFeed();
    const desc = Object.values(f.markets).map((m) => `${m.symbol} ${(m.fundingHourly * 24 * 365 * 100).toFixed(2)}% APR`).join(", ");
    if (f.live) record("metaAndAssetCtxs funding", "PASS", desc);
    else record("metaAndAssetCtxs funding", "WARN", `snapshot used (${f.error})`);
  });

  // 7 ------------------------------------------------------------------------
  heading("7. Deterministic risk policy, contract mirror and adversarial cases (offline)");
  check("Net delta 2.00% allowed, 2.01% blocked", evaluateRiskInvariants({ netDeltaRatio: 0.02, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral && !evaluateRiskInvariants({ netDeltaRatio: 0.0201, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral, "|spotLong − perpShort| / treasury ≤ 0.02");
  check("Leverage 3.0x allowed, 3.01x blocked", evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3, maxPriceImpactBps: 0 }).leverageOk && !evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3.01, maxPriceImpactBps: 0 }).leverageOk, "notional / collateral ≤ 3.0");
  check("Slippage 25 bps allowed, 25.01 bps blocked", evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25 }).slippageOk && !evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25.01 }).slippageOk, "≤ 25 bps");
  const vec = { asset_symbol: "NEAR", treasury_usd_cents: 5_000_000, spot_long_usd_cents: 2_495_000, perp_short_usd_cents: 2_495_000, perp_long_usd_cents: 0, collateral_usd_cents: 5_000_000, quoted_slippage_bps: 2, nonce: 7 };
  const rogueVec = { ...vec, spot_long_usd_cents: 4_970_000, perp_short_usd_cents: 0, perp_long_usd_cents: 45_000_000 };
  check(
    "TS mirror matches the Rust unit-test vectors",
    commitmentPreimage("zerodelta-guard.testnet", vec) === "zerodelta-hedge-v1|zerodelta-guard.testnet|NEAR|5000000|2495000|2495000|0|5000000|2|7" &&
      computeOrderMetrics(vec).leverage_x100 === 100 &&
      computeOrderMetrics(rogueVec).net_delta_bps === 99_940 &&
      computeOrderMetrics(rogueVec).leverage_x100 === 1000,
    "preimage + ceil-rounded delta/leverage identical to contracts/risk-guard/src/lib.rs tests",
  );
  const offA = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: false });
  check("Offline hedged plan approved (8 invariants)", offA.guardian.decision === "APPROVED" && offA.guardian.checks.length === 8, `${offA.resolved.pair}: net delta ${(offA.guardian.metrics.netDeltaRatio * 100).toFixed(2)}%, leverage ${offA.guardian.metrics.leverage.toFixed(2)}x`);
  const replay = runGuardianAgent({ runId: "replay", expectedSignerId: offA.solver.signer.accountId, allowOfflineQuotes: true, solver: offA.solver, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex] });
  check("Offline replay of the approved order rejected", replay.decision === "REJECTED" && replay.violations.join() === "REPLAY_AND_MPC_GATE", replay.checks.find((c) => c.id === "REPLAY_AND_MPC_GATE")!.detail ?? "");
  const offB = await runSwarm({ mode: "rogue", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
  check("Offline rogue 10x long rejected", offB.guardian.decision === "REJECTED" && offB.guardian.violations.includes("DELTA_NEUTRALITY") && offB.guardian.violations.includes("LEVERAGE_CEILING"), `violations: ${offB.guardian.violations.join(", ")}`);
  const offC = await runSwarm({ mode: "spoofed_metrics", pair: "NEAR", treasuryUsd: 50_000, sliceCount: "auto" }, { live: false });
  check("Offline compromised solver (spoofed metrics) rejected", offC.guardian.decision === "REJECTED" && offC.guardian.violations.includes("ORDER_PAYLOAD_BINDING") && !offC.guardian.violations.includes("DELTA_NEUTRALITY"), `claimed delta ${(offC.guardian.metrics.netDeltaRatio * 100).toFixed(2)}% looks safe; violations: ${offC.guardian.violations.join(", ")}`);
  const offD = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 1_000_000, sliceCount: 1 }, { live: false });
  const offEvents = offD.audit.events.map((e) => e.event);
  check("Offline Agent 1/2 reslice negotiation", offD.negotiation.length > 1 && offEvents.includes("SCANNER_RESLICE_ADJUSTMENT") && offD.negotiation.at(-1)!.action === "ACCEPTED", offD.negotiation.map((n) => `${n.sliceCount} slices ${n.observedSlippageBps} bps`).join(" -> "));

  const negFunding = { live: false, source: "test", fetchedAt: "", markets: Object.fromEntries(Object.entries(FUNDING_SNAPSHOT).map(([k, m]) => [k, { ...m, fundingHourly: -0.00001 }])) };
  const snapTokens = { live: false, source: "test", tokens: ONECLICK_TOKEN_SNAPSHOT, count: ONECLICK_TOKEN_SNAPSHOT.length, chains: [], fetchedAt: "" };
  const noTrade = runScannerAgent({ pair: "AUTO", treasuryUsd: 50_000, tokens: snapTokens, funding: negFunding, costs: await probeEntryCosts(false, "x") });
  const offE = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 4 }, { live: false });
  check("Offline NO_TRADE: no negative-carry trade is recommended or settled", noTrade.recommendation === "NO_TRADE" && offE.economics.settlementWithheld && offE.settlement.status === "NO_TRADE" && offE.guardian.mpcSignRequest === null, `${noTrade.recommendationReason.slice(0, 90)}…`);
  const SDK_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123"; // public test key from the official SDK tests
  const hlOrder = orderAction([orderWire({ asset: 1, isBuy: true, sz: 100, limitPx: 100, reduceOnly: false, tif: "Gtc" })]);
  const hlSig = signL1Action(SDK_KEY, hlOrder, 0, true);
  const hlConn = bytesToHex(actionHash(orderAction([orderWire({ asset: 4, isBuy: true, sz: 0.0147, limitPx: 1670.1, reduceOnly: false, tif: "Ioc" })]), 1677777606040));
  check(
    "Offline Hyperliquid signing matches official SDK test vectors",
    hlSig.r === "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e" && hlSig.s === "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e" && hlSig.v === 28 && hlConn === "0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
    "hyperliquid-python-sdk tests/signing_test.py: order signature + phantom agent connectionId",
  );
  const hedge = buildHedgeAction(TESTNET_PROOF.approvedOrder.order, 3.6);
  const tampered = structuredClone(hedge);
  tampered.orders[0].b = true;
  // 100x the size at 1/100 of the price: same size x limit price, caught by the reference-price band
  const inverted = structuredClone(hedge);
  inverted.orders[0].s = String(Number(hedge.orders[0].s) * 100);
  inverted.orders[0].p = "0.036";
  check(
    "Offline: executable hedge bound to approved order; side flip and size/price inversion detected; not the contract digest",
    checkActionMatchesApprovedHedge(hedge, TESTNET_PROOF.approvedOrder.order, 3.6).ok && !checkActionMatchesApprovedHedge(tampered, TESTNET_PROOF.approvedOrder.order, 3.6).ok && !checkActionMatchesApprovedHedge(inverted, TESTNET_PROOF.approvedOrder.order, 3.6).ok && bytesToHex(actionHash(hedge, 0)) !== TESTNET_PROOF.mpcSignature.payloadHex,
    "readiness module only: the deployed contract signs a ZeroDelta commitment, not a Hyperliquid action",
  );

  // 8 ------------------------------------------------------------------------
  heading("8. Full live swarm (ranking, negotiation, dry-run settlement, contract cross-check)");
  await live("Autonomous delta-neutral rebalance ($50,000, AUTO pair, auto slices)", async () => {
    // simulateUnprofitable keeps this a pipeline check even if live carry is negative today;
    // the economic recommendation is reported (and checked for consistency) separately.
    const r = await runSwarm({ mode: "rebalance", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto", simulateUnprofitable: true }, { live: true });
    check("  Agent 1 recommendation is consistent with the live matrix", (r.economics.recommendation === "TRADE") === (r.scanner.selected.eligible && r.sources.funding.live && r.costProbes[r.resolved.pair].source === "1click-live"), `${r.economics.reason.slice(0, 120)}${r.economics.overridden ? " (pipeline check used the demo override)" : ""}`);
    const g = r.guardian;
    const m = r.scanner.opportunityMatrix;
    const liveCosts = Object.values(r.costProbes).filter((c) => c.source === "1click-live").length;
    check("  Agent 1 ranked all 4 markets by net-of-cost carry", m.length === 4 && r.resolved.pair === m[0].asset && liveCosts >= 1, m.map((o) => `#${o.rank} ${o.asset} ${o.grossCarryAprPct}% gross -> ${o.netCarryAprPct}% net`).join(" | ") + ` (${liveCosts}/4 live cost probes)`, liveCosts >= 1 ? "FAIL" : "WARN");
    const last = r.negotiation.at(-1)!;
    check("  Agent 1/2 slice negotiation converged", r.negotiation.length >= 1 && (last.action === "ACCEPTED" || last.action === "AT_SLICE_LIMIT"), r.negotiation.map((n) => `${n.sliceCount}sl ${n.observedSlippageBps}bps ${n.action}`).join(" -> "));
    check("Autonomous delta-neutral rebalance ($50,000, AUTO pair, auto slices)", g.decision === "APPROVED", `${g.decision} ${r.resolved.pair}; net delta ${(g.metrics.netDeltaRatio * 100).toFixed(2)}%, leverage ${g.metrics.leverage.toFixed(2)}x, slippage ${g.metrics.maxPriceImpactBps} bps, ${r.resolved.sliceCount} slices`);
    check("  intents.near accepted the swarm's signed intent", r.settlement.status === "DRY_RUN_SETTLED", `${r.settlement.simulation?.status}: ${r.settlement.simulation?.panicMessage ?? "executed"}`);
    const req = g.mpcSignRequest;
    check(
      "  MPC request is routed through the Risk Guard contract",
      Boolean(req) && req!.contractId === RISK_GUARD_CONTRACT_ID && req!.forwardsTo.predecessor === RISK_GUARD_CONTRACT_ID && req!.forwardsTo.args.request.payload_v2.Ecdsa === computeHedgePayloadHex(RISK_GUARD_CONTRACT_ID, r.solver.order) && Boolean(r.mpcAccount?.evmAddress),
      `${req?.contractId}.record_rebalance -> ${MPC_CONTRACT}.sign(${req?.forwardsTo.args.request.payload_v2.Ecdsa.slice(0, 16)}…) -> hedge key ${r.mpcAccount?.evmAddress}`,
    );
    check("  Approval proof + audit chain verify", verifyGuardianDecision(g) && verifyAuditChain(r.audit.events, r.audit.seal, g.guardianPublicKey, g.decisionHash), `decision ${g.decisionHash.slice(0, 16)}…, audit root ${r.audit.rootHash.slice(0, 16)}…`);
    const oc = r.onchainCheck;
    const ts = computeOrderMetrics(r.solver.order);
    check(
      "  Deployed contract recomputes the same order and approves it",
      oc?.live === true && oc.approved === true && oc.expectedPayloadHex === r.solver.hedgeOrderPayloadHex && oc.netDeltaBps === ts.net_delta_bps && oc.leverageX100 === ts.leverage_x100,
      oc?.live ? `check_order_params: ${oc.netDeltaBps} bps / ${oc.leverageX100} (x100), payload match ${oc.payloadMatches}, nonce fresh ${oc.nonceFresh}` : String(oc?.error),
    );
  });
  await live("Rogue AI directional gamble", async () => {
    const r = await runSwarm({ mode: "rogue", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: true });
    const g = r.guardian;
    check("Rogue AI directional gamble", g.decision === "REJECTED" && r.settlement.status === "BLOCKED_BY_GUARD" && g.mpcSignRequest === null, `${g.decision}; net delta ${(g.metrics.netDeltaRatio * 100).toFixed(0)}%, leverage ${g.metrics.leverage.toFixed(2)}x; violations ${g.violations.join(", ")}`);
    check("  Rejection proof signature verifies", verifyGuardianDecision(g), `guardian ${g.guardianPublicKey.slice(0, 16)}…`);
    check("  Deployed contract also rejects it on its own math", r.onchainCheck?.live === true && r.onchainCheck.approved === false && Boolean(r.onchainCheck.violations?.some((v) => v.startsWith("DELTA_NEUTRALITY"))), `${r.onchainCheck?.contractId}: ${r.onchainCheck?.violations?.join("; ") ?? r.onchainCheck?.error}`);
  });
  await live("Compromised solver (spoofed metrics)", async () => {
    const r = await runSwarm({ mode: "spoofed_metrics", pair: "AUTO", treasuryUsd: 50_000, sliceCount: "auto" }, { live: true });
    const g = r.guardian;
    check("Compromised solver (spoofed metrics)", g.decision === "REJECTED" && g.violations.includes("ORDER_PAYLOAD_BINDING") && g.violations.includes("ENVELOPE_INTEGRITY"), `claimed delta ${(g.metrics.netDeltaRatio * 100).toFixed(2)}%; violations ${g.violations.join(", ")}`);
    check("  Deployed contract flags PAYLOAD_COMMITMENT_MISMATCH", r.onchainCheck?.live === true && r.onchainCheck.payloadMatches === false && Boolean(r.onchainCheck.violations?.some((v) => v.startsWith("PAYLOAD_COMMITMENT_MISMATCH"))), `${r.onchainCheck?.violations?.map((v) => v.slice(0, 60)).join("; ") ?? r.onchainCheck?.error}`);
  });

  // 9 ------------------------------------------------------------------------
  heading("9. On-chain NEAR testnet proof (locked Risk Guard v2 + real transactions)");
  const proof = TESTNET_PROOF;
  const C = proof.contract.accountId;
  check("testnet-proof.json lists the locked v2 contract and 5 transactions", proof.version === 2 && proof.contract.locked && proof.transactions.length === 5 && C === RISK_GUARD_CONTRACT_ID, `${C}; solver ${proof.accounts.solver}; ${proof.transactions.length} txs`);
  const wasm = readFileSync(proof.contract.wasmPath);
  const wasmB58 = toBase58(sha256Bytes(new Uint8Array(wasm)));
  check("Committed contract WASM hashes to the recorded code hash", wasmB58 === proof.contract.codeHash, `sha256(${proof.contract.wasmPath}) = ${wasmB58}`);
  const mpcSig = verifyMpcSignature(proof.mpcSignature);
  check("MPC signature recovers to the contract's derived key (offline)", mpcSig.valid && proof.mpcSignature.predecessor === C && proof.mpcSignature.payloadHex === proof.approvedOrder.hedgeOrderPayloadHex, mpcSig.valid ? `predecessor ${proof.mpcSignature.predecessor} -> ${proof.mpcSignature.evmAddress}` : String(mpcSig.reason ?? "mismatch"));
  check("Recorded orders reproduce their payloads (offline)", computeHedgePayloadHex(C, proof.approvedOrder.order) === proof.approvedOrder.hedgeOrderPayloadHex && computeHedgePayloadHex(C, proof.payloadSwapAttempt.order) !== proof.payloadSwapAttempt.hedgeOrderPayloadHex, "approved: keccak256(order) == payload; swap attack: payload belongs to a different order");
  const txResults = new Map<string, TxVerification>();
  for (const tx of proof.transactions) {
    await live(tx.label, async () => {
      const v = await verifyProofTx(tx);
      txResults.set(tx.kind, v);
      check(tx.label, v.matchesExpectation, `${v.onchainStatus} · ${tx.signerId} -> ${tx.receiverId}.${tx.methodName} · ${v.detail} · via ${v.endpoint ?? "n/a"} · ${tx.explorerUrl}`);
    });
  }
  await live("Guard-gated MPC: the contract itself called v1.signer-prod.testnet.sign", async () => {
    const v = txResults.get("RECORD_AND_SIGN_APPROVED_REBALANCE");
    const ret = v?.returnValue ? (JSON.parse(v.returnValue) as { big_r: string; s: string; recovery_id: number } | null) : null;
    const ok = Boolean(v?.gateReceipt) && v!.gateReceipt!.predecessorId === C && v!.signerId === proof.accounts.solver && ret?.big_r === proof.mpcSignature.signature?.big_r && ret?.s === proof.mpcSignature.signature?.s;
    check("Guard-gated MPC: the contract itself called v1.signer-prod.testnet.sign", ok, `tx signer ${v?.signerId}; sign receipt predecessor ${v?.gateReceipt?.predecessorId}; tx return value = recorded signature: ${ret?.big_r === proof.mpcSignature.signature?.big_r}`);
  });
  await live("Live derived hedge key matches the proof", async () => {
    const d = await getMpcDerivedAccount(proof.mpcSignature.path, C);
    check("Live derived hedge key matches the proof", d.live && d.derivedPublicKey === proof.mpcSignature.derivedPublicKey && d.evmAddress === proof.mpcSignature.evmAddress, `${C} / ${proof.mpcSignature.path} -> ${d.evmAddress}`);
  });
  await live("Contract is locked; code, policy and MPC target match", async () => {
    const g = await getOnchainGuardState();
    const p = g.policy;
    const ok = g.live && g.locked === true && g.codeHashMatchesProof === true && p?.max_delta_bps === 200 && p?.max_leverage_x100 === 300 && p?.max_slippage_bps === 25 && g.config?.mpc_signer_contract === MPC_CONTRACT && g.config?.solver === proof.accounts.solver;
    check("Contract is locked; code, policy and MPC target match", ok, g.live ? `${g.accessKeyCount} access keys; code ${g.codeHash}; policy ${p?.max_delta_bps}/${p?.max_leverage_x100}/${p?.max_slippage_bps}; mpc ${g.config?.mpc_signer_contract}; last_nonce ${g.config?.last_nonce}` : String(g.error));
  });
  await live("Attestation #0 holds the decision, payload and MPC signature", async () => {
    const r = await viewFunction<OnchainAttestation | null>("testnet", C, "get_attestation", { index: proof.approvedOrder.index });
    const a = r.ok ? r.value : null;
    const ok = Boolean(a) && a!.decision_hash === proof.approvedOrder.decisionHash && a!.hedge_order_payload_hex === proof.approvedOrder.hedgeOrderPayloadHex && a!.recorded_by === proof.accounts.solver && a!.mpc_status === "Signed" && a!.mpc_signature?.s === proof.mpcSignature.signature?.s && a!.net_delta_bps === proof.approvedOrder.contractMetrics.net_delta_bps;
    check("Attestation #0 holds the decision, payload and MPC signature", ok, a ? `decision ${a.decision_hash.slice(0, 12)}…, contract math ${a.net_delta_bps} bps / ${a.leverage_x100}, mpc ${a.mpc_status}` : r.ok ? "missing" : r.error);
  });
  await live("Contract check_order_params: replay, rogue math and payload swap", async () => {
    const [a, b, c, pay] = await Promise.all([
      checkOrderOnchain(proof.approvedOrder.order, proof.approvedOrder.hedgeOrderPayloadHex),
      checkOrderOnchain(proof.rogueAttempt.order, proof.rogueAttempt.hedgeOrderPayloadHex),
      checkOrderOnchain(proof.payloadSwapAttempt.order, proof.payloadSwapAttempt.hedgeOrderPayloadHex),
      viewFunction<string>("testnet", C, "compute_payload", { order: proof.approvedOrder.order }),
    ]);
    const replayOnly = a.violations?.length === 1 && a.violations[0].startsWith("NONCE_ALREADY_USED");
    const rogueMath = Boolean(b.violations?.some((v) => v.startsWith("DELTA_NEUTRALITY"))) && Boolean(b.violations?.some((v) => v.startsWith("LEVERAGE_CEILING")));
    const swap = c.payloadMatches === false && Boolean(c.violations?.some((v) => v.startsWith("PAYLOAD_COMMITMENT_MISMATCH")));
    const mirror = pay.ok && pay.value === computeHedgePayloadHex(C, proof.approvedOrder.order);
    check("Contract check_order_params: replay, rogue math and payload swap", replayOnly && rogueMath && swap && mirror, `approved order now -> ${a.violations?.[0]?.slice(0, 40)}; rogue -> ${b.violations?.map((v) => v.split(":")[0]).join("+")}; swap -> ${c.violations?.map((v) => v.split(":")[0]).join("+")}; contract compute_payload == TS keccak: ${mirror}`);
  });

  // 10 -----------------------------------------------------------------------
  heading("10. Risk Guard v3 (SUPERSEDED by v3.1): historical executable signature (testnet)");
  const v3 = V3_PROOF_JSON as any;
  if (!v3) {
    record("testnet-proof.json has a v3 deployment", "FAIL", "no v3 section");
  } else {
    const G3: string = v3.contract.accountId;
    const v2Bytes = readFileSync(v3.previousDeploymentFile.path);
    const v2Sha = Buffer.from(sha256Bytes(new Uint8Array(v2Bytes))).toString("hex");
    check(
      "v2 proof preserved unchanged (byte-identical file + previousDeployment)",
      v2Sha === "99a0feb37566af1578148481191cad69511b78f2bcac552f729cabb09b138581" && v3.previousDeploymentFile.sha256 === v2Sha && canonicalJson(v3.previousDeployment) === canonicalJson(JSON.parse(v2Bytes.toString("utf8"))),
      `${v3.previousDeploymentFile.path} sha256 ${v2Sha.slice(0, 16)}…; previousDeployment == that file`,
    );
    const wasm3 = readFileSync(v3.contract.wasmPath);
    const wasm3B58 = toBase58(sha256Bytes(new Uint8Array(wasm3)));
    check("Committed v3 WASM hashes to the recorded code hash", wasm3B58 === v3.contract.codeHash && wasm3.length === v3.contract.wasmBytes, `sha256(${v3.contract.wasmPath}) = ${wasm3B58}; ${wasm3.length} bytes`);
    check(
      "v3 market table is the Hyperliquid TESTNET table (not mainnet indices)",
      JSON.stringify(v3.contract.markets) === JSON.stringify(Object.entries(HYPERLIQUID_PERPS_TESTNET).map(([symbol, m]) => ({ symbol, asset: m.asset, sz_decimals: m.szDecimals }))) && v3.contract.hlNetwork === "testnet",
      `${v3.contract.markets.map((m: V3Market) => `${m.symbol}=${m.asset}`).join(" ")} fetched ${v3.contract.marketsFetchedAt}`,
    );
    const req = v3.approvedHedge.args.request;
    const rebuilt = buildV3Hedge(G3, "testnet", v3.approvedHedge.market, req.order, BigInt(req.limit_px_e8), BigInt(req.reference_px_e8), v3.contract.policy);
    check(
      "Recorded v3 digest == TS mirror rebuilt from the recorded request (offline)",
      rebuilt.violations.length === 0 && rebuilt.digestHex === v3.approvedHedge.digestHex && rebuilt.commitmentHex === v3.approvedHedge.commitmentHex && JSON.stringify(rebuilt.action) === JSON.stringify(v3.approvedHedge.exchangeRequest.action),
      `${req.order.asset_symbol} IOC sell ${rebuilt.action?.orders[0].s} @ ${rebuilt.action?.orders[0].p} on market ${v3.approvedHedge.market.asset}; digest ${rebuilt.digestHex.slice(0, 16)}…`,
    );
    const sig3 = v3.approvedHedge.exchangeRequest.signature;
    const rec3 = recoverAddress(v3.approvedHedge.digestHex, sig3);
    const recFlip = recoverAddress(v3.approvedHedge.digestHex, { ...sig3, v: sig3.v === 27 ? 28 : 27 });
    check("v3 MPC signature recovers to the pinned hedge address; flipped v does not (offline)", rec3 === v3.hedgeKey.evmAddress.toLowerCase() && recFlip !== rec3, `${v3.hedgeKey.path} -> ${rec3}`);
    const acc = JSON.parse(readFileSync("proofs/hl-acceptance.v3.json", "utf8"));
    const accOk = verifyRecordedAcceptance(v3, acc).length === 0;
    check(
      "Hyperliquid testnet /exchange recovered the hedge address from the MPC signature (recorded)",
      accOk,
      `${acc.ranAt}: real -> ${acc.results[0]?.recoveredAddress}; v flipped -> ${acc.results[1]?.recoveredAddress}; s bit flipped -> ${acc.results[2]?.recoveredAddress}`,
    );
    const fixture = JSON.parse(readFileSync(HL_VECTORS_PATH, "utf8"));
    check("Rust parity fixture is current (regenerated from the TS modules)", canonicalJson(fixture) === canonicalJson(JSON.parse(JSON.stringify(buildHlVectors()))), `${fixture.orders.length} actions, ${fixture.hedges.length} contract-level cases`);

    const v3Tx = new Map<string, TxVerification>();
    for (const tx of v3.transactions as ProofTx[]) {
      await live(`v3: ${tx.label}`, async () => {
        const v = await verifyProofTx(tx);
        v3Tx.set(tx.kind, v);
        check(`v3: ${tx.label}`, v.matchesExpectation, `${v.onchainStatus} · ${tx.signerId} -> ${tx.receiverId}.${tx.methodName} · ${v.detail} · ${tx.explorerUrl}`);
      });
    }
    await live("v3: no rejected transaction produced an MPC receipt; the approved one did", async () => {
      const rejected = (v3.transactions as ProofTx[]).filter((t) => t.expect === "failure");
      const clean = rejected.every((t) => v3Tx.get(t.kind)?.found && !v3Tx.get(t.kind)!.receipts.some((rc) => rc.receiverId === MPC_CONTRACT));
      const ap = v3Tx.get("APPROVED_EXECUTABLE_HEDGE_SIGNED");
      const ret = ap?.returnValue ? JSON.parse(ap.returnValue) : null;
      const signed = Boolean(ap?.gateReceipt) && ap!.gateReceipt!.predecessorId === G3 && ret?.r === sig3.r && ret?.s === sig3.s && ret?.v === sig3.v;
      check("v3: no rejected transaction produced an MPC receipt; the approved one did", clean && signed, `${rejected.length} rejected txs without MPC receipts; approved tx returned the recorded {r, s, v}: ${signed}`);
    });
    await live("v3: contract is locked; code, policy, markets and MPC target match", async () => {
      const [cfg, acct, keys] = await Promise.all([
        viewFunction<any>("testnet", G3, "get_config"),
        nearRpc<{ code_hash: string }>("testnet", "query", { request_type: "view_account", finality: "final", account_id: G3 }),
        getAccessKeyCount(G3),
      ]);
      const c = cfg.ok ? cfg.value : null;
      const ok =
        keys === 0 &&
        acct.ok &&
        acct.result?.code_hash === v3.contract.codeHash &&
        c &&
        JSON.stringify(c.policy) === JSON.stringify(v3.contract.policy) &&
        JSON.stringify(c.markets) === JSON.stringify(v3.contract.markets) &&
        c.hl_network === "testnet" &&
        c.mpc_signer_contract === MPC_CONTRACT &&
        c.mpc_path === v3.hedgeKey.path &&
        c.solver === v3.accounts.solver &&
        c.last_nonce >= req.order.nonce;
      check("v3: contract is locked; code, policy, markets and MPC target match", Boolean(ok), `${keys} access keys; code ${acct.ok ? acct.result?.code_hash : "?"}; last_nonce ${c?.last_nonce}; attestations ${c?.attestation_count}`);
    });
    await live("v3: attestation #0 holds the built action, digest and Hyperliquid signature", async () => {
      const r = await viewFunction<any>("testnet", G3, "get_attestation", { index: 0 });
      const a = r.ok ? r.value : null;
      const ok = a && a.mpc_status === "Signed" && a.digest_hex === v3.approvedHedge.digestHex && a.commitment_hex === v3.approvedHedge.commitmentHex && a.action_json === JSON.stringify(v3.approvedHedge.exchangeRequest.action) && JSON.stringify(a.hl_signature) === JSON.stringify(sig3);
      check("v3: attestation #0 holds the built action, digest and Hyperliquid signature", Boolean(ok), a ? `${a.mpc_status}; v = ${a.hl_signature?.v}; ${a.action_json.slice(0, 60)}…` : r.ok ? "missing" : r.error);
    });
    await live("v3: contract view rebuilds the same digest today (and rejects the reused nonce)", async () => {
      const r = await viewFunction<any>("testnet", G3, "preview_executable_hedge", { request: req });
      const e = r.ok ? r.value : null;
      const ok = e && e.digest_hex === rebuilt.digestHex && e.commitment_hex === rebuilt.commitmentHex && e.approved === false && e.violations.some((x: string) => x.startsWith("NONCE_ALREADY_USED"));
      check("v3: contract view rebuilds the same digest today (and rejects the reused nonce)", Boolean(ok), e ? `on-chain digest ${e.digest_hex.slice(0, 16)}… == TS ${rebuilt.digestHex.slice(0, 16)}…; now ${e.violations.map((x: string) => x.split(":")[0]).join("+")}` : r.ok ? "no result" : r.error);
    });
    await live("v3: live derived hedge key matches the pinned address", async () => {
      const d = await getMpcDerivedAccount(v3.hedgeKey.path, G3);
      check("v3: live derived hedge key matches the pinned address", d.live && d.derivedPublicKey === v3.hedgeKey.derivedPublicKey && d.evmAddress?.toLowerCase() === v3.hedgeKey.evmAddress.toLowerCase(), `${G3} / ${v3.hedgeKey.path} -> ${d.evmAddress}`);
    });
  }


  // 10 -----------------------------------------------------------------------
  heading("11. Risk Guard v3.1: size caps + expiry + executable Hyperliquid signature (testnet, current)");
  const v31 = V31_PROOF_JSON as any;
  if (!v31) {
    record("testnet-proof.json has a v3.1 deployment", "FAIL", "no v3.1 section");
  } else {
    const G31: string = v31.contract.accountId;
    const v3Bytes = readFileSync(v31.previousDeploymentFile.path);
    const v3Sha = Buffer.from(sha256Bytes(new Uint8Array(v3Bytes))).toString("hex");
    check(
      "v3 proof preserved unchanged (byte-identical file == previousDeployment; v2 proof inside is unchanged)",
      v31.previousDeploymentFile.sha256 === v3Sha && canonicalJson(v31.previousDeployment) === canonicalJson(JSON.parse(v3Bytes.toString("utf8"))) && v31.previousDeployment.previousDeploymentFile.sha256 === "99a0feb37566af1578148481191cad69511b78f2bcac552f729cabb09b138581",
      `${v31.previousDeploymentFile.path} sha256 ${v3Sha.slice(0, 16)}…`,
    );
    check("Superseded v3 findings are disclosed in the proof file", Array.isArray(v31.supersededV3?.findings) && v31.supersededV3.findings.length >= 3, `${v31.supersededV3?.findings?.length ?? 0} findings recorded`);
    const wasm31 = readFileSync(v31.contract.wasmPath);
    const wasm31B58 = toBase58(sha256Bytes(new Uint8Array(wasm31)));
    check("Committed v3.1 WASM hashes to the recorded code hash", wasm31B58 === v31.contract.codeHash && wasm31.length === v31.contract.wasmBytes, `sha256(${v31.contract.wasmPath}) = ${wasm31B58}; ${wasm31.length} bytes`);
    check(
      "v3.1 market table is the Hyperliquid TESTNET table (not mainnet indices)",
      JSON.stringify(v31.contract.markets) === JSON.stringify(Object.entries(HYPERLIQUID_PERPS_TESTNET).map(([symbol, m]) => ({ symbol, asset: m.asset, sz_decimals: m.szDecimals, max_order_size_e8: Number(coinsToE8(V31_SIZE_CAPS[symbol].maxOrderCoins)), window_size_cap_e8: Number(coinsToE8(V31_SIZE_CAPS[symbol].windowCoins)) }))) && v31.contract.hlNetwork === "testnet",
      `${v31.contract.markets.map((m: V31Market) => `${m.symbol}=${m.asset} cap ${Number(m.max_order_size_e8) / 1e8}`).join(" ")} fetched ${v31.contract.marketsFetchedAt}`,
    );
    const req = v31.approvedHedge.args.request;
    const rebuilt31 = buildV31Hedge(G31, "testnet", v31.approvedHedge.market, req.order, BigInt(req.limit_px_e8), BigInt(req.reference_px_e8), BigInt(req.expires_after_ms), v31.contract.policy);
    check(
      "Recorded v3.1 digest == TS mirror rebuilt from the recorded request (offline)",
      rebuilt31.violations.length === 0 && rebuilt31.digestHex === v31.approvedHedge.digestHex && rebuilt31.commitmentHex === v31.approvedHedge.commitmentHex && JSON.stringify(rebuilt31.action) === JSON.stringify(v31.approvedHedge.exchangeRequest.action),
      `${req.order.asset_symbol} IOC sell ${rebuilt31.action?.orders[0].s} @ ${rebuilt31.action?.orders[0].p} on market ${v31.approvedHedge.market.asset}; digest ${rebuilt31.digestHex.slice(0, 16)}…`,
    );
    const sig31 = v31.approvedHedge.exchangeRequest.signature;
    const rec31 = recoverAddress(v31.approvedHedge.digestHex, sig31);
    const recFlip = recoverAddress(v31.approvedHedge.digestHex, { ...sig31, v: sig31.v === 27 ? 28 : 27 });
    check("v3.1 MPC signature recovers to the pinned hedge address; flipped v does not (offline)", rec31 === v31.hedgeKey.evmAddress.toLowerCase() && recFlip !== rec31, `${v31.hedgeKey.path} -> ${rec31}`);
    const acc = JSON.parse(readFileSync("hl-acceptance.json", "utf8"));
    const accOk = verifyRecordedAcceptance(v31, acc).length === 0;
    check(
      "Hyperliquid testnet /exchange recovered the hedge address from the MPC signature (recorded)",
      accOk,
      `${acc.ranAt}: real -> ${acc.results[0]?.recoveredAddress}; v flipped -> ${acc.results[1]?.recoveredAddress}; s bit flipped -> ${acc.results[2]?.recoveredAddress}`,
    );
    const fixture = JSON.parse(readFileSync(HL_VECTORS_V31_PATH, "utf8"));
    check("Rust parity fixture (v3.1) is current (regenerated from the TS modules)", canonicalJson(fixture) === canonicalJson(JSON.parse(JSON.stringify(buildHlVectorsV31()))), `${fixture.orders.length} actions, ${fixture.hedges.length} contract-level cases`);

    const v31Tx = new Map<string, TxVerification>();
    for (const tx of v31.transactions as ProofTx[]) {
      await live(`v3.1: ${tx.label}`, async () => {
        const v = await verifyProofTx(tx);
        v31Tx.set(tx.kind, v);
        check(`v3.1: ${tx.label}`, v.matchesExpectation, `${v.onchainStatus} · ${tx.signerId} -> ${tx.receiverId}.${tx.methodName} · ${v.detail} · ${tx.explorerUrl}`);
      });
    }
    await live("v3.1: no rejected transaction produced an MPC receipt; the approved one did", async () => {
      const rejected = (v31.transactions as ProofTx[]).filter((t) => t.expect === "failure");
      const clean = rejected.every((t) => v31Tx.get(t.kind)?.found && !v31Tx.get(t.kind)!.receipts.some((rc) => rc.receiverId === MPC_CONTRACT));
      const ap = v31Tx.get("APPROVED_EXECUTABLE_HEDGE_SIGNED");
      const ret = ap?.returnValue ? JSON.parse(ap.returnValue) : null;
      const signed = Boolean(ap?.gateReceipt) && ap!.gateReceipt!.predecessorId === G31 && ret?.r === sig31.r && ret?.s === sig31.s && ret?.v === sig31.v;
      check("v3.1: no rejected transaction produced an MPC receipt; the approved one did", clean && signed, `${rejected.length} rejected txs without MPC receipts; approved tx returned the recorded {r, s, v}: ${signed}`);
    });
    await live("v3.1: contract is locked; code, policy, markets and MPC target match", async () => {
      const [cfg, acct, keys] = await Promise.all([
        viewFunction<any>("testnet", G31, "get_config"),
        nearRpc<{ code_hash: string }>("testnet", "query", { request_type: "view_account", finality: "final", account_id: G31 }),
        getAccessKeyCount(G31),
      ]);
      const c = cfg.ok ? cfg.value : null;
      const ok =
        keys === 0 &&
        acct.ok &&
        acct.result?.code_hash === v31.contract.codeHash &&
        c &&
        JSON.stringify(c.policy) === JSON.stringify(v31.contract.policy) &&
        JSON.stringify(c.markets) === JSON.stringify(v31.contract.markets) &&
        c.hl_network === "testnet" &&
        c.mpc_signer_contract === MPC_CONTRACT &&
        c.mpc_path === v31.hedgeKey.path &&
        c.solver === v31.accounts.solver &&
        c.last_nonce >= req.order.nonce;
      check("v3.1: contract is locked; code, policy, markets and MPC target match", Boolean(ok), `${keys} access keys; code ${acct.ok ? acct.result?.code_hash : "?"}; last_nonce ${c?.last_nonce}; attestations ${c?.attestation_count}`);
    });
    await live("v3.1: attestation #0 holds the built action, digest and Hyperliquid signature", async () => {
      const r = await viewFunction<any>("testnet", G31, "get_attestation", { index: 0 });
      const a = r.ok ? r.value : null;
      const ok = a && a.mpc_status === "Signed" && a.digest_hex === v31.approvedHedge.digestHex && a.commitment_hex === v31.approvedHedge.commitmentHex && a.action_json === JSON.stringify(v31.approvedHedge.exchangeRequest.action) && JSON.stringify(a.hl_signature) === JSON.stringify(sig31);
      check("v3.1: attestation #0 holds the built action, digest and Hyperliquid signature", Boolean(ok), a ? `${a.mpc_status}; v = ${a.hl_signature?.v}; ${a.action_json.slice(0, 60)}…` : r.ok ? "missing" : r.error);
    });
    await live("v3.1: contract view rebuilds the same digest today (and rejects the reused nonce)", async () => {
      const r = await viewFunction<any>("testnet", G31, "preview_executable_hedge", { request: req });
      const e = r.ok ? r.value : null;
      const ok = e && e.digest_hex === rebuilt31.digestHex && e.commitment_hex === rebuilt31.commitmentHex && e.approved === false && e.violations.some((x: string) => x.startsWith("NONCE_ALREADY_USED"));
      check("v3.1: contract view rebuilds the same digest today (and rejects the reused nonce)", Boolean(ok), e ? `on-chain digest ${e.digest_hex.slice(0, 16)}… == TS ${rebuilt31.digestHex.slice(0, 16)}…; now ${e.violations.map((x: string) => x.split(":")[0]).join("+")}` : r.ok ? "no result" : r.error);
    });
    await live("v3.1: live derived hedge key matches the pinned address", async () => {
      const d = await getMpcDerivedAccount(v31.hedgeKey.path, G31);
      check("v3.1: live derived hedge key matches the pinned address", d.live && d.derivedPublicKey === v31.hedgeKey.derivedPublicKey && d.evmAddress?.toLowerCase() === v31.hedgeKey.evmAddress.toLowerCase(), `${G31} / ${v31.hedgeKey.path} -> ${d.evmAddress}`);
    });
  }


  // Summary --------------------------------------------------------------------
  const count = (l: Level) => results.filter((r) => r.level === l).length;
  const failed = count("FAIL");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${color.bold}Summary${color.reset}  ${color.PASS}${count("PASS")} passed${color.reset} · ${color.WARN}${count("WARN")} warnings${color.reset} · ${color.SKIP}${count("SKIP")} skipped${color.reset} · ${color.FAIL}${failed} failed${color.reset}  (${secs}s)`);
  const sh = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const bySection: Record<string, Record<Level, number>> = {};
  for (const r of results) {
    bySection[r.section] ??= { PASS: 0, WARN: 0, SKIP: 0, FAIL: 0 };
    bySection[r.section][r.level]++;
  }
  const dirty = sh("git status --porcelain --untracked-files=no");
  const diffHash = dirty ? sh("git diff HEAD | sha256sum | cut -d' ' -f1") : null;
  const report = {
    project: "ZeroDelta",
    schema: 2,
    generatedAt: new Date().toISOString(),
    overall: failed > 0 ? "FAIL" : "PASS",
    mode: offline ? "offline" : "live",
    source: {
      commit: sh("git rev-parse HEAD"),
      branch: sh("git rev-parse --abbrev-ref HEAD"),
      // true = tracked files differed from `commit` when this ran, so the report covers uncommitted changes
      dirty: dirty === null ? null : dirty.length > 0,
      // sha256 of `git diff HEAD` when dirty: identifies the exact uncommitted changes that ran
      uncommittedDiffSha256: diffHash,
      note: "`commit` is the commit the run started from. A report saved in a subsequent commit names the previously checked source; dirty describes tracked changes at the start of that run. For a report bound to one exact commit, use the CI artifact verify-report-offline-<sha>.",
    },
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, ci: Boolean(process.env.CI), rust: sh("rustc --version") },
    totals: { checks: results.length, PASS: count("PASS"), WARN: count("WARN"), SKIP: count("SKIP"), FAIL: failed, durationSec: Number(secs) },
    bySection,
    deployment: {
      network: "testnet",
      contract: TESTNET_PROOF.contract.accountId,
      codeHash: TESTNET_PROOF.contract.codeHash,
      transactions: TESTNET_PROOF.transactions.map((t) => ({ kind: t.kind, hash: t.hash, expect: t.expect, explorerUrl: t.explorerUrl })),
    },
    deploymentV3: V3_PROOF_JSON
      ? {
          network: "testnet",
          contract: (V3_PROOF_JSON as any).contract.accountId,
          codeHash: (V3_PROOF_JSON as any).contract.codeHash,
          hedgeAddress: (V3_PROOF_JSON as any).hedgeKey.evmAddress,
          transactions: ((V3_PROOF_JSON as any).transactions as ProofTx[]).map((t) => ({ kind: t.kind, hash: t.hash, expect: t.expect, explorerUrl: t.explorerUrl })),
        }
      : null,
    deploymentV31: V31_PROOF_JSON
      ? {
          network: "testnet",
          contract: (V31_PROOF_JSON as any).contract.accountId,
          codeHash: (V31_PROOF_JSON as any).contract.codeHash,
          hedgeAddress: (V31_PROOF_JSON as any).hedgeKey.evmAddress,
          transactions: ((V31_PROOF_JSON as any).transactions as ProofTx[]).map((t) => ({ kind: t.kind, hash: t.hash, expect: t.expect, explorerUrl: t.explorerUrl })),
        }
      : null,
    results,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`Machine-readable report written to ${REPORT_PATH}`);
  if (failed > 0) {
    console.log(`${color.FAIL}${color.bold}VERIFICATION FAILED${color.reset}`);
    process.exit(1);
  }
  console.log(`${color.PASS}${color.bold}ALL CHECKS PASSED${offline ? " (offline subset)" : ""}${color.reset}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${color.FAIL}verification crashed:${color.reset}`, err);
  process.exit(1);
});
