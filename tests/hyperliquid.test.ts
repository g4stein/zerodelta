/**
 * Offline Hyperliquid execution-readiness tests.
 *
 * Reference vectors are copied from the official SDK test file
 * https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/tests/signing_test.py
 * The private key 0x0123…0123 is the SDK's public test key, not a secret.
 * Nothing here contacts Hyperliquid or NEAR.
 */
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  actionHash,
  buildHedgeAction,
  checkActionMatchesApprovedHedge,
  floatToIntForHashing,
  floatToWire,
  orderAction,
  orderWire,
  signL1Action,
  type OrderAction,
} from "../src/lib/hyperliquid/exchangeSigning";
import { TESTNET_PROOF } from "../src/lib/near/riskGuardContract";
import { computeHedgePayloadHex } from "../src/lib/near/orderCommitment";

const SDK_TEST_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

describe("Hyperliquid signing matches the official SDK vectors", () => {
  it("float_to_wire normalisation", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(1670.1)).toBe("1670.1");
    expect(floatToWire(0.0147)).toBe("0.0147");
    expect(floatToWire(-0)).toBe("0");
    expect(() => floatToWire(0.123456789)).toThrow(/rounding/);
  });

  it("test_phantom_agent_creation_matches_production (connectionId)", () => {
    const action = orderAction([orderWire({ asset: 4, isBuy: true, sz: 0.0147, limitPx: 1670.1, reduceOnly: false, tif: "Ioc" })]);
    expect(`0x${bytesToHex(actionHash(action, 1677777606040))}`).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  it("test_l1_action_signing_matches (dummy action with a large integer)", () => {
    const action = { type: "dummy", num: floatToIntForHashing(1000) };
    expect(signL1Action(SDK_TEST_KEY, action, 0, true)).toEqual({
      r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      v: 27,
    });
    expect(signL1Action(SDK_TEST_KEY, action, 0, false)).toEqual({
      r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      v: 28,
    });
  });

  it("test_l1_action_signing_order_matches (limit order, mainnet and testnet)", () => {
    const action = orderAction([orderWire({ asset: 1, isBuy: true, sz: 100, limitPx: 100, reduceOnly: false, tif: "Gtc" })]);
    expect(signL1Action(SDK_TEST_KEY, action, 0, true)).toEqual({
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      v: 28,
    });
    expect(signL1Action(SDK_TEST_KEY, action, 0, false)).toEqual({
      r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
      s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
      v: 27,
    });
  });

  it("msgpack field order is part of the hash", () => {
    const a = orderAction([orderWire({ asset: 1, isBuy: true, sz: 100, limitPx: 100, reduceOnly: false, tif: "Gtc" })]);
    const reordered = { orders: a.orders, type: "order", grouping: "na" };
    expect(bytesToHex(actionHash(reordered, 0))).not.toBe(bytesToHex(actionHash(a, 0)));
  });
});

describe("Binding an executable Hyperliquid order to the approved hedge (offline)", () => {
  const approved = TESTNET_PROOF.approvedOrder.order; // NEAR, perp short $33,273.35
  const px = 3.6; // illustrative limit price, not a live quote

  it("builds an IOC short whose notional matches the approved perp short", () => {
    const action = buildHedgeAction(approved, px);
    const o = action.orders[0];
    expect(o.a).toBe(74); // NEAR perp index
    expect(o.b).toBe(false); // sell
    expect(o.t.limit.tif).toBe("Ioc");
    const check = checkActionMatchesApprovedHedge(action, approved, px);
    expect(check.ok).toBe(true);
    expect(check.deviationBps).toBeLessThan(5);
  });

  it("detects every kind of tampering after approval", () => {
    const base = buildHedgeAction(approved, px);
    const mutate = (fn: (a: OrderAction) => void) => {
      const copy = structuredClone(base);
      fn(copy);
      return checkActionMatchesApprovedHedge(copy, approved, px).violations.join(" ");
    };
    expect(mutate((a) => (a.orders[0].b = true))).toMatch(/WRONG_SIDE/);
    expect(mutate((a) => (a.orders[0].a = 1))).toMatch(/WRONG_MARKET/);
    expect(mutate((a) => (a.orders[0].s = floatToWire(Number(a.orders[0].s) * 10)))).toMatch(/NOTIONAL_MISMATCH/);
    expect(mutate((a) => (a.orders[0].r = true))).toMatch(/REDUCE_ONLY/);
    expect(mutate((a) => a.orders.push(a.orders[0]))).toMatch(/EXPECTED_ONE_ORDER/);
    // 100x the size at 1/100 of the price keeps size x limit price constant: the reference band catches it
    expect(
      mutate((a) => {
        a.orders[0].s = String(Number(a.orders[0].s) * 100);
        a.orders[0].p = String(px / 100);
      }),
    ).toMatch(/PRICE_OUTSIDE_BAND.*NOTIONAL_MISMATCH|NOTIONAL_MISMATCH|PRICE_OUTSIDE_BAND/);
    // and the signed digest changes, so a signature over the approved action can't be reused
    const tampered = structuredClone(base);
    tampered.orders[0].s = floatToWire(Number(tampered.orders[0].s) + 1);
    expect(bytesToHex(actionHash(tampered, 1))).not.toBe(bytesToHex(actionHash(base, 1)));
  });

  it("size/price inversion is rejected on both the price band and the notional", () => {
    const base = buildHedgeAction(approved, px);
    const inverted = structuredClone(base);
    inverted.orders[0].s = String(Number(base.orders[0].s) * 100);
    inverted.orders[0].p = String(px / 100);
    const r = checkActionMatchesApprovedHedge(inverted, approved, px);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/PRICE_OUTSIDE_BAND/);
    expect(r.violations.join(" ")).toMatch(/NOTIONAL_MISMATCH/);
  });

  it("refuses to judge without a trusted reference price", () => {
    const r = checkActionMatchesApprovedHedge(buildHedgeAction(approved, px), approved, 0);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("NO_TRUSTED_REFERENCE_PRICE");
  });

  it("float_to_wire refuses values that would print in exponent notation", () => {
    expect(() => floatToWire(1e21)).toThrow(/out of range/);
    expect(() => floatToWire(Number.NaN)).toThrow(/out of range/);
  });

  it("the deployed contract's signed digest is NOT a Hyperliquid action digest", () => {
    const action = buildHedgeAction(approved, px);
    const zerodeltaPayload = computeHedgePayloadHex(TESTNET_PROOF.contract.accountId, approved);
    expect(zerodeltaPayload).toBe(TESTNET_PROOF.mpcSignature.payloadHex);
    for (const nonce of [0, approved.nonce]) expect(bytesToHex(actionHash(action, nonce))).not.toBe(zerodeltaPayload);
  });
});
