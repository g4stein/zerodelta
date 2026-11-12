import { createGate, requestError } from "@/lib/server/requestPolicy";
import { NextResponse } from "next/server";
import { V31_PROOF_JSON } from "@/lib/near/proofFile";
import { viewFunction } from "@/lib/near/rpcClient";
import { previewRequest, type PreviewScenario, PREVIEW_SCENARIOS } from "@/lib/hyperliquid/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const enterPreview = createGate(60, 6);

/** Fixed read-only contract method and scenarios. Never signs, broadcasts or accepts a target URL. */
export async function GET(req: Request) {
  const scenario = new URL(req.url).searchParams.get("scenario") ?? "approved";
  if (!PREVIEW_SCENARIOS.includes(scenario as PreviewScenario)) return NextResponse.json({ error: "Unknown preview scenario" }, { status: 400 });
  let release: (() => void) | undefined;
  try {
    release = enterPreview();
    const p = V31_PROOF_JSON as any;
    const request = previewRequest(scenario as PreviewScenario, Date.now());
    const response = await viewFunction<Record<string, unknown>>("testnet", p.contract.accountId, "preview_executable_hedge", { request });
    const headers = { "cache-control": "no-store" };
    if (!response.ok) return NextResponse.json({ live: false, error: "Contract RPC unavailable; please retry shortly" }, { status: 503, headers });
    return NextResponse.json({ live: true, scenario, contractId: p.contract.accountId, blockHeight: response.blockHeight, checkedAt: new Date().toISOString(), request, evaluation: response.value }, { headers });
  } catch (err) {
    return requestError(err, "Contract RPC unavailable; please retry shortly", { live: false });
  } finally {
    release?.();
  }
}
