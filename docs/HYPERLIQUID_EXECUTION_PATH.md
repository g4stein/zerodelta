# From contract-gated signature to an executable Hyperliquid hedge

## What the deployed contract signs today

`zerodelta-guard-fb604f.testnet` asks NEAR Chain Signatures to sign

```
keccak256("zerodelta-hedge-v1|<contract>|<asset>|<treasury>|<spot>|<perp_short>|<perp_long>|<collateral>|<slippage>|<nonce>")
```

That is a **ZeroDelta order commitment**. It proves the contract approved exactly these parameters, and the signature recovers to the key derived for the contract. It is **not** a Hyperliquid action signature, so Hyperliquid would reject it, and ZeroDelta does not execute any hedge. The deployed contract is immutable and will not change.

## How Hyperliquid actually authenticates an order

From the official Python SDK ([`hyperliquid/utils/signing.py`](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py)) and the [signing docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing):

1. Build the action. An order is `{"type": "order", "orders": [{"a": asset, "b": isBuy, "p": px, "s": sz, "r": reduceOnly, "t": {"limit": {"tif": "Ioc"}}}], "grouping": "na"}`. Field order matters, and numbers are strings normalised by `float_to_wire`.
2. `connectionId = keccak256(msgpack(action) || nonce_u64_be || vault_flag [|| vault_address] [|| 0x00 || expiresAfter_u64_be])`. The nonce is a millisecond timestamp.
3. Sign the EIP-712 struct `Agent(string source, bytes32 connectionId)` with `source = "a"` (mainnet) or `"b"` (testnet), domain `{name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0}`.
4. POST `{action, nonce, signature: {r, s, v}}` to `/exchange`. Hyperliquid recovers the signer from the payload and checks it is the account or an approved API wallet.

## What this repo adds (offline only)

[`src/lib/hyperliquid/exchangeSigning.ts`](../src/lib/hyperliquid/exchangeSigning.ts) is a readiness module. It never contacts Hyperliquid or NEAR.

- Ports `float_to_wire`, `order_request_to_order_wire`, `action_hash`, the phantom agent and the EIP-712 digest.
- Reproduces the official SDK's published test vectors byte-for-byte ([`tests/hyperliquid.test.ts`](../tests/hyperliquid.test.ts), using the SDK's public test key from `tests/signing_test.py`): the order signature for mainnet and testnet, the dummy-action signature and the production `connectionId`.
- `buildHedgeAction` turns the approved order (NEAR, perp short $33,273.35) into an IOC sell on market 74 at a given limit price, respecting `szDecimals`.
- `checkActionMatchesApprovedHedge` takes a trusted reference price (mark or oracle) and rejects tampering after approval: wrong market, wrong side, reduce-only, extra orders, wrong TIF, too many size decimals, a limit price more than 100 bps from the reference, or size × reference price more than 50 bps from the approved perp short. The reference price is essential: an IOC sell fills at the bid, so checking size × limit price alone would accept 100× the size at 1/100 of the price (a test covers this). In this offline module the caller supplies the reference price; a production version would take it from an authenticated oracle.
- A test shows that the action digest differs from the contract's commitment, which is why the existing MPC signature can't be reused.

Market indices and size decimals were read from Hyperliquid `info {"type": "meta"}` on 2026-11-09 (BTC 0, ETH 1, SOL 5, NEAR 74) and are hard-coded; they would need to be fetched at run time in production.

## What genuine end-to-end enforcement would need

1. **A new contract (v3) that signs the executable digest.** It would recompute the Hyperliquid `connectionId` on-chain from the raw order (msgpack + keccak256, both feasible in WASM) and the EIP-712 digest, check them against the same risk policy, and only then call `sign` with that digest. Then the MPC signature *is* the Hyperliquid signature, and no off-chain component can swap the order.
2. **The MPC-derived key must be the Hyperliquid account or an approved agent wallet**, and the funds must sit in that account. Approving an agent wallet is itself a user-signed action that the contract would have to sign.
3. **On-chain price bounds.** The contract would need the limit price inside a band around an oracle price (otherwise a correct-looking order could be placed far off-market).
4. **Nonce and expiry rules** tied to block time, so signed orders can't be held back and replayed later.
5. **Funding, withdrawals and liquidation monitoring**, plus an independent security audit, before real funds.

None of this is implemented on-chain. Real trading would also need a funded Hyperliquid account, which this project deliberately does not have.
