import { V31_PROOF_JSON } from "../near/proofFile";

export const PREVIEW_SCENARIOS = ["approved", "size-attack", "expiry-attack", "price-risk"] as const;
export type PreviewScenario = typeof PREVIEW_SCENARIOS[number];

/** Fresh read-only requests built from the pinned proof; no signatures or transaction keys. */
export function previewRequest(scenario: PreviewScenario, nowMs: number) {
  const p = V31_PROOF_JSON as any;
  const recorded = p.approvedHedge.args.request;
  const request = { ...recorded, run_id: "judge-preview", order: { ...recorded.order, nonce: nowMs }, expires_after_ms: nowMs + 600000, expected_digest_hex: null };
  if (scenario === "size-attack" || scenario === "price-risk") {
    const divisor = scenario === "size-attack" ? 10 : 2;
    // Whole-dollar prices obey the exchange tick rules; both prices move together.
    request.limit_px_e8 = Math.floor(recorded.reference_px_e8 / 1e8 / divisor) * 1e8;
    request.reference_px_e8 = request.limit_px_e8;
  }
  if (scenario === "expiry-attack") request.expires_after_ms = nowMs + 7200000;
  return request;
}
