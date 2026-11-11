/** Internal consistency of recorded exchange evidence, not authentication of a historical server response. */
import { actionHash, l1SigningDigest } from "./exchangeSigning";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "../crypto/encoding";
import { recoverAddress } from "./recover";

export type Classification = "PASS" | "FAIL" | "OTHER" | "SPENT";
export function parseRecoveredAddress(text: string): string | null {
  try {
    const b = JSON.parse(text);
    if (!b || b.status !== "err" || typeof b.response !== "string") return null;
    return b.response.match(/^User or API Wallet (0x[0-9a-fA-F]{40}) does not exist\.?$/)?.[1].toLowerCase() ?? null;
  } catch { return null; }
}
export function classify(recovered: string | null, expected: string, text = ""): Classification {
  if (!recovered) return /duplicate nonce/i.test(text) ? "SPENT" : "OTHER";
  return recovered === expected.toLowerCase() ? "PASS" : "FAIL";
}
export const flipLowBit = (hex: string) => `0x${(BigInt(hex) ^ 1n).toString(16).padStart(64, "0")}`;

export function verifyRecordedAcceptance(proof: any, record: any): string[] {
  const problems: string[] = [];
  try {
    const expected = String(proof.hedgeKey.evmAddress).toLowerCase();
    const request = proof.approvedHedge.exchangeRequest;
    const digest = proof.approvedHedge.digestHex;
    if (!["testnet", "mainnet"].includes(proof.contract.hlNetwork)) problems.push("unknown exchange network");
    const rebuilt = bytesToHex(l1SigningDigest(actionHash(request.action, request.nonce, request.vaultAddress ?? null, request.expiresAfter ?? null), proof.contract.hlNetwork === "mainnet"));
    if (rebuilt !== digest) problems.push("exchange request does not rebuild the signed digest");
    if (record.verdict !== "PASS" || record.expectedAddress !== expected || record.digestHex !== digest) problems.push("record header differs from proof");
    if (recoverAddress(digest, request.signature) !== expected) problems.push("proof signature does not recover the pinned hedge address");
    if (!Array.isArray(record.results) || record.results.length !== 3) return [...problems, "exactly one real case and two controls are required"];
    const signatures = [request.signature, { ...request.signature, v: request.signature.v === 27 ? 28 : 27 }, { ...request.signature, s: flipLowBit(request.signature.s) }];
    const normalize = (r: any) => ({ action: r.action, nonce: r.nonce, expiresAfter: r.expiresAfter ?? null, vaultAddress: r.vaultAddress ?? null, signature: r.signature });
    for (const [i, r] of record.results.entries()) {
      const want = i === 0 ? "PASS" : "FAIL";
      const role = i === 0 ? "real" : "control";
      if (r.role !== role) problems.push(`case ${i}: wrong role`);
      if (Object.keys(r.request).some(k => !["action", "nonce", "expiresAfter", "vaultAddress", "signature"].includes(k)) || canonicalJson(normalize(r.request)) !== canonicalJson(normalize({ ...request, signature: signatures[i] }))) problems.push(`case ${i}: request differs from the expected order or control`);
      const local = recoverAddress(digest, signatures[i]);
      const reported = parseRecoveredAddress(r.rawResponse);
      const derived = classify(reported, expected, r.rawResponse);
      if (r.http !== 200 || r.networkError || !reported || reported !== local || derived !== want) problems.push(`case ${i}: raw response does not match independent recovery`);
      if (r.recoveredAddress !== reported || r.locallyRecoveredAddress !== local || r.classification !== derived || r.hyperliquidAgreesWithLocalRecovery !== (reported === local) || r.ok !== true) problems.push(`case ${i}: stored metadata disagrees with recomputation`);
    }
  } catch (err) { problems.push(`malformed evidence: ${err instanceof Error ? err.message : String(err)}`); }
  return problems;
}
