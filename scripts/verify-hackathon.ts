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
 *   7. Deterministic risk-policy invariants
 *   8. Full live 3-agent swarm: hedged rebalance approved, rogue trade rejected
 *
 * Result levels: PASS, WARN (live source unavailable, labelled fallback used),
 * SKIP (offline mode), FAIL. Exit code is 1 if anything FAILs, else 0.
 *
 * Offline mode (no network): `ZERODELTA_OFFLINE=1 npm run verify` or `npm run verify -- --offline`.
 */
import { writeFileSync } from "node:fs";
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
import { evaluateRiskInvariants, GUARDIAN_NEAR_ACCOUNT, HEDGE_DERIVATION_PATH, verifyGuardianDecision } from "../src/lib/agents/guardianAgent";
import { runSwarm, verifyAuditChain } from "../src/lib/swarm/orchestrator";
import { USDC_NEAR_ASSET } from "../src/lib/swarm/types";
import { bytesToHex } from "../src/lib/crypto/encoding";

type Level = "PASS" | "WARN" | "SKIP" | "FAIL";
interface Result {
  section: string;
  name: string;
  level: Level;
  detail: string;
}

const offline = process.argv.includes("--offline") || process.env.ZERODELTA_OFFLINE === "1";
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
  heading("7. Deterministic risk-policy invariants");
  check("Net delta 2.00% allowed, 2.01% blocked", evaluateRiskInvariants({ netDeltaRatio: 0.02, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral && !evaluateRiskInvariants({ netDeltaRatio: 0.0201, leverage: 1, maxPriceImpactBps: 0 }).deltaNeutral, "|spotLong − perpShort| / treasury ≤ 0.02");
  check("Leverage 3.0x allowed, 3.01x blocked", evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3, maxPriceImpactBps: 0 }).leverageOk && !evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 3.01, maxPriceImpactBps: 0 }).leverageOk, "notional / collateral ≤ 3.0");
  check("Slippage 25 bps allowed, 25.01 bps blocked", evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25 }).slippageOk && !evaluateRiskInvariants({ netDeltaRatio: 0, leverage: 1, maxPriceImpactBps: 25.01 }).slippageOk, "≤ 25 bps");
  const offA = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
  check("Offline hedged plan approved", offA.guardian.decision === "APPROVED", `net delta ${(offA.guardian.metrics.netDeltaRatio * 100).toFixed(2)}%, leverage ${offA.guardian.metrics.leverage.toFixed(2)}x`);
  const offB = await runSwarm({ mode: "rogue", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: false });
  check("Offline rogue 10x long rejected", offB.guardian.decision === "REJECTED" && offB.guardian.violations.includes("DELTA_NEUTRALITY") && offB.guardian.violations.includes("LEVERAGE_CEILING"), `violations: ${offB.guardian.violations.join(", ")}`);

  // 8 ------------------------------------------------------------------------
  heading("8. Full live 3-agent swarm (dry-run settlement)");
  await live("Delta-neutral rebalance ($50,000, NEAR-PERP / wNEAR)", async () => {
    const r = await runSwarm({ mode: "rebalance", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: true });
    const g = r.guardian;
    const sources = r.solver.quotes.map((q) => `${q.legId}:${q.source}`).join(" ");
    check("Delta-neutral rebalance ($50,000, NEAR-PERP / wNEAR)", g.decision === "APPROVED", `${g.decision}; net delta ${(g.metrics.netDeltaRatio * 100).toFixed(2)}%, leverage ${g.metrics.leverage.toFixed(2)}x, slippage ${g.metrics.maxPriceImpactBps} bps; ${sources}`);
    check("  intents.near accepted the swarm's signed intent", r.settlement.status === "DRY_RUN_SETTLED", `${r.settlement.simulation?.status}: ${r.settlement.simulation?.panicMessage ?? "executed"}`);
    check("  Chain Signatures request prepared for hedge", Boolean(g.mpcSignRequest) && Boolean(r.mpcAccount?.evmAddress), `${MPC_CONTRACT}.sign payload ${g.mpcSignRequest?.args.request.payload_v2.Ecdsa.slice(0, 16)}… → ${r.mpcAccount?.evmAddress}`);
    check("  Approval proof + audit chain verify", verifyGuardianDecision(g) && verifyAuditChain(r.audit.events), `decision ${g.decisionHash.slice(0, 16)}…, audit root ${r.audit.rootHash.slice(0, 16)}…`);
  });
  await live("Rogue AI directional gamble", async () => {
    const r = await runSwarm({ mode: "rogue", pair: "NEAR", treasuryUsd: 50_000, sliceCount: 8 }, { live: true });
    const g = r.guardian;
    check("Rogue AI directional gamble", g.decision === "REJECTED" && r.settlement.status === "BLOCKED_BY_GUARD" && g.mpcSignRequest === null, `${g.decision}; net delta ${(g.metrics.netDeltaRatio * 100).toFixed(0)}%, leverage ${g.metrics.leverage.toFixed(2)}x; violations ${g.violations.join(", ")}`);
    check("  Rejection proof signature verifies", verifyGuardianDecision(g), `guardian ${g.guardianPublicKey.slice(0, 16)}…`);
  });

  // Summary --------------------------------------------------------------------
  const count = (l: Level) => results.filter((r) => r.level === l).length;
  const failed = count("FAIL");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${color.bold}Summary${color.reset}  ${color.PASS}${count("PASS")} passed${color.reset} · ${color.WARN}${count("WARN")} warnings${color.reset} · ${color.SKIP}${count("SKIP")} skipped${color.reset} · ${color.FAIL}${failed} failed${color.reset}  (${secs}s)`);
  writeFileSync("verify-report.json", JSON.stringify({ offline, finishedAt: new Date().toISOString(), results }, null, 2));
  console.log("Machine-readable report written to verify-report.json");
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
