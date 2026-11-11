# From contract-gated signature to an executable Hyperliquid hedge

## Status

| Step | Status |
|---|---|
| 1. A contract that builds the Hyperliquid action and EIP-712 digest on-chain, checks them against the risk policy, and only then calls `sign` with that digest | **Done on testnet (v3).** [`zerodelta-guard-v3-a9c75f.testnet`](https://testnet.nearblocks.io/address/zerodelta-guard-v3-a9c75f.testnet), approved [tx `2SAhjj5X…`](https://testnet.nearblocks.io/txns/2SAhjj5Xju19NA3t9KsjTGAoQp5RWyhTbwEpqC6wUdkF). Hyperliquid testnet recovered the contract's hedge address `0xef63…2c66` from the signature ([`hl-acceptance.json`](../hl-acceptance.json)). |
| 2. The MPC-derived key becomes the Hyperliquid account (or an approved agent wallet), and funds sit there | Not done. The testnet faucet requires a mainnet deposit from the same address, which this project deliberately does not make. |
| 3. On-chain price bounds | **Partly done.** v3 enforces a ±100 bps band around a reference price and Hyperliquid's tick rules; the reference is still a trusted solver input, not an oracle. |
| 4. Nonce and expiry rules tied to block time | **Done (v3).** Millisecond nonces within −5 min / +60 s of block time. |
| 5. Funding, withdrawals, liquidation monitoring and an independent audit before real funds | Not done. |

## What the v2 contract signs

`zerodelta-guard-fb604f.testnet` asks NEAR Chain Signatures to sign

```
keccak256("zerodelta-hedge-v1|<contract>|<asset>|<treasury>|<spot>|<perp_short>|<perp_long>|<collateral>|<slippage>|<nonce>")
```

That is a **ZeroDelta order commitment**. It proves the contract approved exactly these parameters, and the signature recovers to the key derived for the contract. It is not a Hyperliquid action signature, so Hyperliquid would reject it. The v2 contract is immutable and kept as history.

## How Hyperliquid authenticates an order

From the official Python SDK ([`hyperliquid/utils/signing.py`](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py)) and the [signing docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing):

1. Build the action. An order is `{"type": "order", "orders": [{"a": asset, "b": isBuy, "p": px, "s": sz, "r": reduceOnly, "t": {"limit": {"tif": "Ioc"}}}], "grouping": "na"}`. Field order matters, and numbers are strings normalised by `float_to_wire`.
2. `connectionId = keccak256(msgpack(action) || nonce_u64_be || vault_flag [|| vault_address] [|| 0x00 || expiresAfter_u64_be])`. The nonce is a millisecond timestamp.
3. Sign the EIP-712 struct `Agent(string source, bytes32 connectionId)` with `source = "a"` (mainnet) or `"b"` (testnet), domain `{name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0}`.
4. POST `{action, nonce, signature: {r, s, v}}` to `/exchange`. Hyperliquid recovers the signer from the payload and checks it is the account or an approved API wallet.

## What v3 does on-chain

[`contracts/risk-guard-v3/src/hl.rs`](../contracts/risk-guard-v3/src/hl.rs) is an integer-only port of the TypeScript module below: `float_to_wire` on 1e-8 fixed-point integers, a msgpack encoder with `@msgpack/msgpack`'s exact byte layout, `connectionId` (no vault, no expiry) and the EIP-712 digest. `sign_executable_hedge` builds one IOC sell from the approved legs (testnet market index from the deploy-time table, size = approved perp short ÷ limit in whole lots), enforces the price band and tick rules, computes the digest and has the MPC sign it. It never takes a digest from the solver. See the [contract README](../contracts/risk-guard-v3/README.md).

Correctness evidence:

- The Rust port reproduces the official SDK's vectors (production `connectionId`, dummy-action and limit-order signatures on mainnet and testnet): [`tests/sdk_vectors.rs`](../contracts/risk-guard-v3/tests/sdk_vectors.rs).
- 64 order actions and 110 contract-level cases are byte-identical to the TypeScript module ([`tests/ts_parity.rs`](../contracts/risk-guard-v3/tests/ts_parity.rs)); [`tests/hlParity.test.ts`](../tests/hlParity.test.ts) fails if the fixture is stale.
- On testnet, the contract's digest for the approved order equals the TypeScript rebuild, and Hyperliquid testnet recovered the contract's hedge address from the MPC signature, with two corrupted controls recovering other addresses.

Market indices differ between networks (testnet BTC 3, ETH 4, SOL 0, NEAR 54; mainnet BTC 0, ETH 1, SOL 5, NEAR 74). The v3 deploy fetched the testnet table live, aborted on any difference from the pinned table, and stored it in the contract.

## The offline TypeScript module

[`src/lib/hyperliquid/exchangeSigning.ts`](../src/lib/hyperliquid/exchangeSigning.ts) reproduces the SDK's signing and its published test vectors ([`tests/hyperliquid.test.ts`](../tests/hyperliquid.test.ts), using the SDK's public test key). `buildHedgeAction` sizes with exact integers ([`fixedPoint.ts`](../src/lib/hyperliquid/fixedPoint.ts)); an earlier float version could under-count by one lot at boundaries. `checkActionMatchesApprovedHedge` is the off-chain check used by the v2 demo. [`v3Hedge.ts`](../src/lib/hyperliquid/v3Hedge.ts) mirrors exactly what the v3 contract builds.

## What is still needed for real execution

1. Fund the MPC-derived address on Hyperliquid, or have the contract sign an `approveAgent` for it, which would need a separately reviewed signing path.
2. An authenticated price oracle for the band instead of a solver-supplied reference.
3. Funding, withdrawals and liquidation monitoring, plus an independent security audit, before real funds.
