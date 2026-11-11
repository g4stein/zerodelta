/**
 * CP4 acceptance test: does Hyperliquid TESTNET accept the v3 contract's MPC signature as a
 * signature by the contract's hedge key?  `npm run hl:acceptance`
 *
 * Posts the recorded testnet-proof.json `approvedHedge.exchangeRequest` (action, nonce, signature
 * from the NEAR MPC network, obtained by the locked v3 contract) to
 * https://api.hyperliquid-testnet.xyz/exchange, plus two negative controls with the same real
 * signature corrupted (v flipped, one bit of s flipped).
 *
 * Hyperliquid recovers the signer from the EIP-712 digest and the signature. The hedge account is not
 * funded on Hyperliquid, so the exchange answers "User or API Wallet <recovered address> does not exist".
 * That message alone proves nothing (a broken signature gets it too); the ADDRESS in it is the proof:
 *   PASS  recovered address == the MPC-derived hedge address pinned in testnet-proof.json
 *   FAIL  a different address was recovered
 *   OTHER no recovered address in the response (any other error, or an unexpected success)
 * The run passes only if the real signature is PASS and both controls recover a DIFFERENT address.
 *
 * No NEAR transaction, no funds, testnet only. Nothing can be filled: the account does not exist.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { recoverAddress } from "./testnet-setup-v3";

const EXCHANGE = "https://api.hyperliquid-testnet.xyz/exchange";
const OUT = "hl-acceptance.json";

type Sig = { r: string; s: string; v: number };
type Classification = "PASS" | "FAIL" | "OTHER";

export function parseRecoveredAddress(responseText: string): string | null {
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    return null;
  }
  const b = body as { status?: string; response?: unknown };
  if (b.status !== "err" || typeof b.response !== "string") return null;
  const m = b.response.match(/^User or API Wallet (0x[0-9a-fA-F]{40}) does not exist\.?$/);
  return m ? m[1].toLowerCase() : null;
}

export function classify(recovered: string | null, expected: string): Classification {
  if (!recovered) return "OTHER";
  return recovered === expected.toLowerCase() ? "PASS" : "FAIL";
}

const flipLowBit = (hex: string) => `0x${(BigInt(hex) ^ 1n).toString(16).padStart(64, "0")}`;

async function main() {
  const proof = JSON.parse(readFileSync("testnet-proof.json", "utf8"));
  if (proof.version !== 3) throw new Error("testnet-proof.json has no v3 deployment");
  const expected = String(proof.hedgeKey.evmAddress).toLowerCase();
  const { action, nonce, signature, vaultAddress } = proof.approvedHedge.exchangeRequest as { action: unknown; nonce: number; signature: Sig; vaultAddress: string | null };
  const digestHex: string = proof.approvedHedge.digestHex;

  const cases: { name: string; role: "real" | "control"; signature: Sig }[] = [
    { name: "real MPC signature", role: "real", signature },
    { name: "control: v flipped", role: "control", signature: { ...signature, v: signature.v === 27 ? 28 : 27 } },
    { name: "control: lowest bit of s flipped", role: "control", signature: { ...signature, s: flipLowBit(signature.s) } },
  ];

  const results = [];
  for (const c of cases) {
    // Same body shape as the SDK; vaultAddress omitted when null.
    const body: Record<string, unknown> = { action, nonce, signature: c.signature };
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
    const classification = classify(recovered, expected);
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
    purpose: "Hyperliquid TESTNET accepts the NEAR MPC signature obtained by the locked Risk Guard v3 contract as a signature by the contract's hedge key",
    endpoint: EXCHANGE,
    ranAt: new Date().toISOString(),
    contract: proof.contract.accountId,
    signingTransaction: proof.transactions.find((t: { kind: string }) => t.kind === "APPROVED_EXECUTABLE_HEDGE_SIGNED")?.hash,
    hedgeKeyPath: proof.hedgeKey.path,
    expectedAddress: expected,
    digestHex,
    nonce,
    nonceNote: "Recovery does not depend on nonce age; the recorded request is posted unchanged.",
    results,
    allRecoveredAddressesDistinct: distinct,
    verdict: pass ? "PASS" : "FAIL",
    meaning: pass
      ? "Hyperliquid recovered exactly the contract's MPC-derived hedge address from the real signature, and different addresses from both corrupted copies. The signature is exchange-valid; the order was not placed only because that address has no Hyperliquid account."
      : "The acceptance criteria were not met; see results.",
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  for (const r of results) console.log(`${r.classification.padEnd(5)} ${r.ok ? "ok " : "BAD"} ${r.case}: HL recovered ${r.recoveredAddress ?? "(none)"} | local ${r.locallyRecoveredAddress} | HTTP ${r.http} ${r.rawResponse.slice(0, 120)}${r.networkError ? ` network: ${r.networkError}` : ""}`);
  console.log(`verdict: ${report.verdict} (expected ${expected}); wrote ${OUT}`);
  if (!pass) process.exit(1);
}

if (process.argv[1]?.endsWith("hl-acceptance.ts")) {
  main().catch((e) => {
    console.error(`[hl-acceptance] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
