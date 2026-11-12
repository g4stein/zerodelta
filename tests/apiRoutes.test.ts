import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/near/rpcClient", () => ({ getLiveTelemetry: vi.fn(async () => ({ live: true })), viewFunction: vi.fn() }));
vi.mock("@/lib/near/riskGuardContract", () => ({ getOnchainProofStatus: vi.fn(async () => ({})) }));
vi.mock("@/lib/near/riskGuardV3", () => ({ getV3OnchainStatus: vi.fn(async () => ({})) }));
vi.mock("@/lib/swarm/orchestrator", () => ({ runSwarm: vi.fn() }));

describe("Route boundaries before upstream work", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  it.each([
    ["{", "application/json", 400],
    ["[]", "application/json", 400],
    ["x".repeat(4097), "application/json", 413],
    ["{}", "text/plain", 415],
  ])("rejects invalid POST input with %s / %s -> %s", async (body, type, status) => {
    const { POST } = await import("../src/app/api/swarm/route");
    const { runSwarm } = await import("@/lib/swarm/orchestrator");
    const response = await POST(new Request("https://example.test/api/swarm", { method: "POST", headers: { "content-type": type }, body }));
    expect(response.status).toBe(status);
    expect(runSwarm).not.toHaveBeenCalled();
  });
  it("releases concurrency slots after upstream failures and never leaks errors", async () => {
    const { POST } = await import("../src/app/api/swarm/route");
    const { runSwarm } = await import("@/lib/swarm/orchestrator");
    vi.mocked(runSwarm).mockRejectedValue(new Error("private upstream detail"));
    for (let i = 0; i < 3; i++) {
      const response = await POST(new Request("https://example.test/api/swarm", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain("private upstream detail");
    }
    expect(runSwarm).toHaveBeenCalledTimes(3);
  });
  it("keeps preview errors explicitly unavailable, without upstream detail", async () => {
    const { GET } = await import("../src/app/api/hedge-preview/route");
    const { viewFunction } = await import("@/lib/near/rpcClient");
    vi.mocked(viewFunction).mockResolvedValue({ ok: false, error: "private RPC detail", network: "testnet", method: "query", latencyMs: 0 } as any);
    const response = await GET(new Request("https://example.test/api/hedge-preview?scenario=approved"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ live: false });
  });
});
