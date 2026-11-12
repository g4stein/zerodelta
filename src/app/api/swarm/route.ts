import { createGate, createShortCache, readJsonObject, requestError } from "@/lib/server/requestPolicy";
import { NextResponse } from "next/server";
import { getLiveTelemetry } from "@/lib/near/rpcClient";
import { getOnchainProofStatus } from "@/lib/near/riskGuardContract";
import { getV3OnchainStatus } from "@/lib/near/riskGuardV3";
import { runSwarm } from "@/lib/swarm/orchestrator";
import { parseSwarmRequest } from "@/lib/swarm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const enterSwarm = createGate(12, 2);
const telemetrySnapshot = createShortCache(async () => {
  const [telemetry, onchain, onchainV3] = await Promise.all([
    getLiveTelemetry(), getOnchainProofStatus(),
    getV3OnchainStatus().catch(() => ({ live: false, contractId: "", error: "Contract status unavailable" })),
  ]);
  return { ...telemetry, onchain, onchainV3 };
}, 10_000);

/** GET /api/swarm — live NEAR RPC + Chain Signatures + 1Click telemetry + on-chain testnet proof status (v2 and v3). */
export async function GET() {
  try {
    return NextResponse.json(await telemetrySnapshot(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return requestError(err, "Telemetry unavailable; please retry shortly");
  }
}

/**
 * POST /api/swarm — run the 3-agent pipeline.
 * Body: { mode: "rebalance" | "rogue", treasuryUsd: number, pair: "NEAR" | "SOL" | "ETH", sliceCount: number }
 */
export async function POST(req: Request) {
  let release: (() => void) | undefined;
  try {
    release = enterSwarm();
    const body = await readJsonObject(req);
    const run = await runSwarm(parseSwarmRequest(body));
    return NextResponse.json(run, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return requestError(err, "Swarm unavailable; please retry shortly");
  } finally {
    release?.();
  }
}
