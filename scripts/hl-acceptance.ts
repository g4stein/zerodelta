/**
 * Hyperliquid TESTNET signer-recovery check for the v3.1 contract's MPC signature.
 *
 *   npm run hl:acceptance            offline: re-verify the RECORDED evidence (hl-acceptance.json). Writes nothing.
 *   npm run hl:acceptance -- --live  post the recorded request (+2 corrupted controls) to Hyperliquid testnet now.
 *                                    Writes only hl-acceptance.local.json (git-ignored). Never touches the recorded file.
 *   npm run hl:acceptance -- --live --record   as --live, and overwrite hl-acceptance.json only after a live PASS.
 *
 * Why offline is the default: Hyperliquid remembers (signer, nonce). After the first post, the same request is
 * answered "Invalid nonce: duplicate nonce", with no recovered address, so a live re-run cannot PASS again.
 * --live reports that case as SPENT (not a pass). The recorded file is the evidence from the first post.
 *
 * What a pass shows: Hyperliquid recovered the contract's MPC-derived hedge address from the signature, and
 * different addresses from the two corrupted copies. It does NOT show an order was placed: the hedge address
 * has no Hyperliquid account, so nothing can fill. The address in the response is the proof, not the error text.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { recoverAddress } from "./testnet-setup-v3";
import { parseRecoveredAddress, classify, flipLowBit, verifyRecordedAcceptance, type Classification } from "../src/lib/hyperliquid/acceptance";
export { parseRecoveredAddress, classify } from "../src/lib/hyperliquid/acceptance";

const EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";
const RECORDED = "hl-acceptance.json";
const LOCAL = "hl-acceptance.local.json";

type Sig = { r: string; s: string; v: number };
const LIVE = process.argv.includes("--live");
const RECORD = process.argv.includes("--record");

/** Offline: re-check the recorded evidence against testnet-proof.json. Writes nothing. */
function verifyRecorded() {
  const proof = JSON.parse(readFileSync("testnet-proof.json", "utf8"));
  const rec = JSON.parse(readFileSync(RECORDED, "utf8"));
  const expected = String(proof.hedgeKey.evmAddress).toLowerCase();
  const problems = verifyRecordedAcceptance(proof, rec);
  if (problems.length) {
    console.error(`OFFLINE CHECK FAILED:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  console.log(`recorded run at ${rec.ranAt}: ${rec.results?.length} cases`);
  for (const r of rec.results ?? []) console.log(`  ${r.classification.padEnd(5)} ${r.case}: Hyperliquid recovered ${r.recoveredAddress}`);
  console.log(`OFFLINE CHECK PASSED: recorded Hyperliquid responses match testnet-proof.json (hedge address ${expected}). Nothing written. Use --live to post again (expect SPENT).`);
}

async function main() {
  if (!LIVE) return verifyRecorded();
  const proof = JSON.parse(readFileSync("testnet-proof.json", "utf8"));
  if (proof.version !== 3.1) throw new Error("testnet-proof.json is not the v3.1 deployment");
  const expected = String(proof.hedgeKey.evmAddress).toLowerCase();
  const { action, nonce, expiresAfter, signature, vaultAddress } = proof.approvedHedge.exchangeRequest as { action: unknown; nonce: number; expiresAfter: number; signature: Sig; vaultAddress: string | null };
  const digestHex: string = proof.approvedHedge.digestHex;

  const cases: { name: string; role: "real" | "control"; signature: Sig }[] = [
    { name: "real MPC signature", role: "real", signature },
    { name: "control: v flipped", role: "control", signature: { ...signature, v: signature.v === 27 ? 28 : 27 } },
    { name: "control: lowest bit of s flipped", role: "control", signature: { ...signature, s: flipLowBit(signature.s) } },
  ];

  const results = [];
  for (const c of cases) {
    // Same body shape as the SDK; vaultAddress omitted when null.
    const body: Record<string, unknown> = { action, nonce, signature: c.signature, expiresAfter };
    if (vaultAddress) body.vaultAddress = vaultAddress;
    const sentAt = new Date().toISOString();
    let http = 0;
    let text = "";
    let networkError: string | null = null;
    try {
      const res = await fetch(EXCHANGE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      http = res.status;
      text = await res.text();
    } catch (e) {
      networkError = e instanceof Error ? e.message : String(e);
    }
    const recovered = parseRecoveredAddress(text);
    let localRecovered: string | null = null;
    try {
      localRecovered = recoverAddress(digestHex, c.signature);
    } catch (e) {
      localRecovered = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const classification = classify(recovered, expected, text);
    const ok = c.role === "real" ? classification === "PASS" : classification === "FAIL";
    results.push({
      case: c.name,
      role: c.role,
      sentAt,
      request: body,
      http,
      rawResponse: text,
      networkError,
      recoveredAddress: recovered,
      classification,
      expectedForThisCase: c.role === "real" ? "PASS (recovers the hedge address)" : "FAIL (recovers a different address)",
      ok,
      locallyRecoveredAddress: localRecovered,
      hyperliquidAgreesWithLocalRecovery: recovered !== null && recovered === localRecovered,
    });
  }

  const real = results[0];
  const controls = results.slice(1);
  const distinct = new Set(results.map((r) => r.recoveredAddress).filter(Boolean)).size === results.length;
  const pass = real.ok && controls.every((r) => r.ok) && distinct && results.every((r) => r.hyperliquidAgreesWithLocalRecovery);
  const report = {
    purpose: "Hyperliquid TESTNET accepts the NEAR MPC signature obtained by the locked Risk Guard v3.1 contract as a signature by the contract's hedge key",
    endpoint: EXCHANGE,
    ranAt: new Date().toISOString(),
    contract: proof.contract.accountId,
    signingTransaction: proof.transactions.find((t: { kind: string }) => t.kind === "APPROVED_EXECUTABLE_HEDGE_SIGNED")?.hash,
    hedgeKeyPath: proof.hedgeKey.path,
    expectedAddress: expected,
    digestHex,
    nonce,
    expiresAfter,
    nonceNote: "The recorded request is posted unchanged. Recovery does not depend on nonce age (tested), but Hyperliquid rejects a repeated (signer, nonce).",
    results,
    allRecoveredAddressesDistinct: distinct,
    verdict: pass ? "PASS" : "FAIL",
    meaning: pass
      ? "Hyperliquid recovered exactly the contract's MPC-derived hedge address from the real signature, and different addresses from both corrupted copies. Signer recovery is proven. No order was placed: that address has no Hyperliquid account."
      : "The acceptance criteria were not met; see results.",
  };
  const spent = results.some((r) => r.classification === "SPENT");
  if (spent) (report as { verdict: string }).verdict = "SPENT";
  const out = RECORD && report.verdict === "PASS" ? RECORDED : LOCAL;
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const r of results) console.log(`${r.classification.padEnd(5)} ${r.ok ? "ok " : "BAD"} ${r.case}: HL recovered ${r.recoveredAddress ?? "(none)"} | local ${r.locallyRecoveredAddress} | HTTP ${r.http} ${r.rawResponse.slice(0, 120)}${r.networkError ? ` network: ${r.networkError}` : ""}`);
  console.log(`verdict: ${report.verdict} (expected ${expected}); wrote ${out}`);
  if (spent) console.log("SPENT: Hyperliquid already saw this (signer, nonce), so a live re-run cannot show recovery. See the recorded hl-acceptance.json.");
  if (RECORD && report.verdict !== "PASS") console.log("Not recorded: only a live PASS overwrites hl-acceptance.json.");
  if (!pass) process.exit(1);
}

if (process.argv[1]?.endsWith("hl-acceptance.ts")) {
  main().catch((e) => {
    console.error(`[hl-acceptance] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
