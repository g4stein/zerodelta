import { describe, expect, it, vi } from "vitest";
import { createGate, createShortCache, readJsonObject, requestError } from "../src/lib/server/requestPolicy";

function request(body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request("https://example.test/api/swarm", { method: "POST", body, headers });
}

describe("Public API resource boundaries", () => {
  it.each(["{", "null", "[]", "true", '"text"', ""])("rejects invalid JSON objects: %s", async body => {
    await expect(readJsonObject(request(body))).rejects.toMatchObject({ status: 400 });
  });
  it("accepts an object and JSON media-type parameters", async () => {
    expect(await readJsonObject(request('{"mode":"rogue"}', { "content-type": "application/json; charset=utf-8" }))).toEqual({ mode: "rogue" });
  });
  it("rejects unsupported media types", async () => {
    await expect(readJsonObject(request("{}", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
  });
  it("rejects oversized bodies without relying on Content-Length", async () => {
    await expect(readJsonObject(request(JSON.stringify({ data: "a".repeat(4096) })))).rejects.toMatchObject({ status: 413 });
  });
  it("rejects a declared oversized body before reading it", async () => {
    await expect(readJsonObject(request("{}", { "content-type": "application/json", "content-length": "5000" }))).rejects.toMatchObject({ status: 413 });
  });
  it("times out a stalled body", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const req = new Request("https://example.test", { method: "POST", body, duplex: "half", headers: { "content-type": "application/json" } } as RequestInit);
    await expect(readJsonObject(req, 4096, 10)).rejects.toMatchObject({ status: 408 });
  });
  it("enforces concurrency and releases a slot only once", () => {
    const enter = createGate(10, 1);
    const release = enter();
    expect(enter).toThrow("Demo is busy");
    release(); release();
    const next = enter();
    expect(enter).toThrow("Demo is busy");
    next();
  });
  it("enforces the window quota after requests finish, then resets", () => {
    let time = 0;
    const enter = createGate(2, 1, () => time);
    enter()(); enter()();
    expect(enter).toThrow("Request limit reached");
    time = 60_000;
    expect(() => enter()()).not.toThrow();
  });
  it("provides Retry-After and hides unexpected exception details", async () => {
    const enter = createGate(1, 1, () => 0);
    enter()();
    let error: unknown;
    try { enter(); } catch (err) { error = err; }
    const limited = requestError(error, "Unavailable");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const unexpected = requestError(new Error("secret upstream value"), "Unavailable");
    expect(unexpected.status).toBe(503);
    expect(await unexpected.json()).toEqual({ error: "Unavailable" });
  });
  it("coalesces polling and expires successful snapshots", async () => {
    let time = 0;
    const load = vi.fn(async () => ({ version: load.mock.calls.length }));
    const cached = createShortCache(load, 10_000, () => time);
    const results = await Promise.all([cached(), cached(), cached()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(results[1]);
    time = 9999; await cached();
    expect(load).toHaveBeenCalledTimes(1);
    time = 10_000; await cached();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("retries failed telemetry loads rather than caching an outage", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("live");
    const cached = createShortCache(load, 10_000);
    await expect(cached()).rejects.toThrow("offline");
    expect(await cached()).toBe("live");
  });
});
