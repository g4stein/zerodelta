/**
 * Keeps the Rust parity fixture honest: regenerates the TS -> Rust vectors from the verified
 * TypeScript module and fails if contracts/risk-guard-v3/tests/fixtures/hl_vectors.json is stale.
 * Offline only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildHlVectors, HL_VECTORS_PATH } from "../scripts/hl-vectors";
import { buildHlVectorsV31, HL_VECTORS_V31_PATH } from "../scripts/hl-vectors-v31";

describe("Rust port parity fixture", () => {
  it("is exactly what the TypeScript module produces today", () => {
    const committed = JSON.parse(readFileSync(HL_VECTORS_PATH, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildHlVectors())));
  });

  it("includes the SDK production connectionId case shape and u64 nonce extremes", () => {
    const v = buildHlVectors();
    expect(v.orders.some((o) => o.nonce === "18446744073709551615")).toBe(true);
    expect(v.orders.some((o) => o.orders.length > 15)).toBe(true);
  });

  it("v3.1 fixture is exactly what the TypeScript module produces today", () => {
    const committed = JSON.parse(readFileSync(HL_VECTORS_V31_PATH, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildHlVectorsV31())));
  });
});
