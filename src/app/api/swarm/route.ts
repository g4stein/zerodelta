import { NextResponse } from "next/server";
import { getLiveTelemetry } from "@/lib/near/rpcClient";
import { getOnchainProofStatus } from "@/lib/near/riskGuardContract";
import { runSwarm } from "@/lib/swarm/orchestrator";
import { parseSwarmRequest } from "@/lib/swarm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/swarm — live NEAR RPC + Chain Signatures + 1Click telemetry + on-chain testnet proof status. */
export async function GET() {
  try {
    const [telemetry, onchain] = await Promise.all([getLiveTelemetry(), getOnchainProofStatus()]);
    return NextResponse.json({ ...telemetry, onchain }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "telemetry failed" }, { status: 500 });
  }
}

/**
 * POST /api/swarm — run the 3-agent pipeline.
 * Body: { mode: "rebalance" | "rogue", treasuryUsd: number, pair: "NEAR" | "SOL" | "ETH", sliceCount: number }
 */
export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    const run = await runSwarm(parseSwarmRequest(body));
    return NextResponse.json(run, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "swarm run failed" }, { status: 500 });
  }
}
