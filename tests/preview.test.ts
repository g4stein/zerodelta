import { describe, expect, it } from "vitest";
import { previewRequest, PREVIEW_SCENARIOS } from "../src/lib/hyperliquid/preview";
import { V31_PROOF_JSON } from "../src/lib/near/proofFile";
import { buildV31Hedge, v31ExpiryViolations } from "../src/lib/hyperliquid/v31Hedge";
const p = V31_PROOF_JSON as any;
const now = 1794419058678;
function build(scenario: typeof PREVIEW_SCENARIOS[number]) {
  const r = previewRequest(scenario, now);
  return buildV31Hedge(p.contract.accountId, "testnet", p.approvedHedge.market, r.order, BigInt(r.limit_px_e8), BigInt(r.reference_px_e8), BigInt(r.expires_after_ms), p.contract.policy);
}
describe("Judge preview scenarios", () => {
  it("uses fresh nonces without mutating historical evidence", () => {
    const snapshot = JSON.stringify(p);
    for (const scenario of PREVIEW_SCENARIOS) {
      const r = previewRequest(scenario, now + 100000);
      expect(r.order.nonce).toBe(now + 100000);
      expect(r.expected_digest_hex).toBeNull();
    }
    expect(JSON.stringify(p)).toBe(snapshot);
  });
  it("builds an ordinary policy-compliant hedge", () => expect(build("approved").violations).toEqual([]));
  it("rejects size inflation specifically on the coin cap", () => expect(build("size-attack").violations.some(v => v.startsWith("ORDER_SIZE_CAP"))).toBe(true));
  it("exposes residual price risk within the cap", () => {
    const ordinary = build("approved"); const cheap = build("price-risk");
    expect(cheap.violations).toEqual([]);
    expect(cheap.sizeE8).toBeGreaterThan(ordinary.sizeE8);
  });
  it("makes the overlong expiry fail the actual policy bound", () => {
    const r = previewRequest("expiry-attack", now);
    expect(v31ExpiryViolations(BigInt(r.expires_after_ms), BigInt(now), BigInt(p.contract.policy.max_expiry_ms))[0]).toMatch(/^EXPIRY_TOO_FAR/);
  });
});
