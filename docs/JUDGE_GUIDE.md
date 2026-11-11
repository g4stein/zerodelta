# ZeroDelta judge guide

**Live demo:** [zerodelta.vercel.app](https://zerodelta.vercel.app/) · **Repo:** [github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta) · **Primary track:** 06 / SEC AI Security & Defense

## 30-second version

AI agents run a delta-neutral carry strategy (spot long + equal perp short) for a treasury. The agents never hold the signing key. The key is derived by NEAR Chain Signatures for a NEAR contract with **zero access keys**, and that contract only requests a signature after it recomputes the risk from the raw order legs.

In **v3** the contract also builds the executable Hyperliquid order itself and computes its EIP-712 digest on-chain, so the MPC signature *is* a Hyperliquid order signature. Hyperliquid testnet recovered exactly the contract's MPC-derived hedge address from it (`0xef63…2c66`); a flipped `v` and a flipped bit of `s` recover different addresses. No funds moved and nothing was filled.

## The three strongest technical points

**1. The keyless contract is the signer, and it signs the executable order.** `sign_executable_hedge` builds one IOC sell from the approved legs (testnet market index, size = perp short ÷ limit in whole lots, limit within 100 bps of the reference, Hyperliquid tick rules), computes `connectionId` and the EIP-712 digest, then itself calls `v1.signer-prod.testnet.sign`. It never accepts a digest from the solver. Evidence: [tx `2SAhjj5X…`](https://testnet.nearblocks.io/txns/2SAhjj5Xju19NA3t9KsjTGAoQp5RWyhTbwEpqC6wUdkF), with the receipt `zerodelta-guard-v3-a9c75f.testnet → v1.signer-prod.testnet.sign`; the Access Keys tab on [Nearblocks](https://testnet.nearblocks.io/address/zerodelta-guard-v3-a9c75f.testnet) is empty.

**2. The exchange validates the binding.** [`hl-acceptance.json`](../hl-acceptance.json): Hyperliquid testnet `/exchange` recovered `0xef639b571185dc6ee0e4680de4e8dd81e7e02c66` from the real signature, `0xd9cf…3608` with `v` flipped and `0x3f5d…9860` with one bit of `s` flipped. The link from the risk-checked legs to that digest is verify §10's *recorded digest == fresh TS rebuild* plus the live *contract view rebuilds the same digest today*.

**3. Reproducible adversarial proof.** v3: 44 Rust tests (official Hyperliquid SDK vectors, 110 contract-level cases byte-identical to the TypeScript mirror, an adversarial test for every rejection, 15/15 deliberate contract bugs caught). v2: 33 Rust tests. 113 TypeScript tests. `npm run verify` (75 checks) re-fetches every historical transaction of both contracts from an archival RPC and checks that no rejected transaction produced an MPC receipt.

## Where to click (about 3 minutes)

1. **Do** open [zerodelta.vercel.app](https://zerodelta.vercel.app/) **→ see** the top bar, a **LIVE READ-ONLY CHECK** of NEAR and the v2 contract, and under it the **v3 panel**.
2. **Do** read the v3 panel left to right **→ see** approved legs → contract-built order (IOC sell on testnet market 0) → digest (green checks: *recomputed in your browser* equals the contract's digest) → MPC `{r, s, v}` (recovers to the hedge address in your browser; flipped `v` does not) → Hyperliquid testnet's recorded answer for the real and both corrupted signatures. The top-right badges are read live from the v3 contract: *locked (0 keys)* and *attestation #0 Signed; digest + {r,s,v} match*.
3. **Do** click the links under the panel **→ see** the rejected v3 transactions on Nearblocks: `PRICE_OUT_OF_BAND`, `NONCE_ALREADY_USED`, `Method on_mpc_signed is private`.
4. **Do** click the amber **Simulate Compromised Solver** (v2 demo, unchanged) **→ see** the solver's claim (≈0% delta) next to what its payload really commits to (≈1000% delta, 10x), the deployed contract's live verdict and the matching historical on-chain rejection.
5. **Do** click the green **Execute Autonomous Delta-Neutral Rebalance** **→ see** Agent 1's ranking (funding minus live 1Click costs), the Agent 1/2 negotiation, Agent 3's 8 checks and the contract's verdict. This run is a **SIMULATED EXECUTION** against the v2 contract. If funding is negative, Agent 1 says **NO_TRADE**; tick the demo override to see the full flow.

## Reproduce

```bash
npm ci && npm run typecheck && npm test && npm run build
npm run verify              # live, read-only; §10 is v3
npm run verify:offline      # no network
npm run hl:acceptance       # POSTs the recorded signed order to Hyperliquid TESTNET; expect PASS
cd contracts/risk-guard && cargo test      # v2, Rust 1.81
cd contracts/risk-guard-v3 && cargo test   # v3, Rust 1.81
```

`npm run hl:acceptance` sends no NEAR transaction and moves no funds; it passes only if the address in Hyperliquid's answer equals the pinned hedge address and both corrupted signatures recover other addresses. Details: [VERIFICATION.md](VERIFICATION.md).

## Key files

| What | File |
|---|---|
| v3 contract (builds the order, computes the digest, signs) | [`contracts/risk-guard-v3/src/lib.rs`](../contracts/risk-guard-v3/src/lib.rs), [`hl.rs`](../contracts/risk-guard-v3/src/hl.rs), [README](../contracts/risk-guard-v3/README.md) |
| v3 tests | [`sdk_vectors.rs`](../contracts/risk-guard-v3/tests/sdk_vectors.rs), [`ts_parity.rs`](../contracts/risk-guard-v3/tests/ts_parity.rs), [`adversarial.rs`](../contracts/risk-guard-v3/tests/adversarial.rs) |
| v3 TypeScript mirror | [`src/lib/hyperliquid/v3Hedge.ts`](../src/lib/hyperliquid/v3Hedge.ts), [`fixedPoint.ts`](../src/lib/hyperliquid/fixedPoint.ts), [`exchangeSigning.ts`](../src/lib/hyperliquid/exchangeSigning.ts) |
| v3 deploy + proof txs, exchange check | [`scripts/testnet-setup-v3.ts`](../scripts/testnet-setup-v3.ts), [`scripts/hl-acceptance.ts`](../scripts/hl-acceptance.ts) |
| v2 contract and tests | [`contracts/risk-guard/src/lib.rs`](../contracts/risk-guard/src/lib.rs), [`tests/adversarial.rs`](../contracts/risk-guard/tests/adversarial.rs) |
| Agents | [`scannerAgent.ts`](../src/lib/agents/scannerAgent.ts), [`solverAgent.ts`](../src/lib/agents/solverAgent.ts), [`guardianAgent.ts`](../src/lib/agents/guardianAgent.ts), [`orchestrator.ts`](../src/lib/swarm/orchestrator.ts) |
| Verification harness | [`scripts/verify-hackathon.ts`](../scripts/verify-hackathon.ts) |
| Proof data | [`testnet-proof.json`](../testnet-proof.json) (v3, v2 under `previousDeployment`), [`hl-acceptance.json`](../hl-acceptance.json) |
| Threat model | [SECURITY_MODEL.md](SECURITY_MODEL.md) |

## Why NEAR specifically

- **Chain Signatures with contract callers.** The MPC key is a function of the calling account, and a NEAR contract can be the caller. That is what lets a smart contract, rather than a person, be the only holder of signing authority over an external-chain key, here a Hyperliquid key.
- **Keyless contract accounts.** NEAR accounts can delete every access key, which makes the policy and code provably immutable and leaves no side door.
- **NEAR Intents.** Spot legs are priced through live 1Click quotes and the signed NEP-413 intent is executed by the real `intents.near` contract in `simulate_intents`, which verifies the signature and stops at the balance check.

## Not implemented (please don't credit these)

- No funds move, no order is placed or filled, nothing runs on mainnet. v3 proves the exchange accepts the signature as the hedge key's; the hedge address has no Hyperliquid account (the testnet faucet requires a mainnet deposit, which we didn't make).
- The v3 reference price is a trusted solver input; size follows the approved notional, so a bad price can't enlarge the position.
- The TEE is software-simulated; there is no hardware attestation.
- The contracts trust the solver's treasury size, collateral and slippage figures. v2's findings F-1 and F-2 remain in the immutable v2 contract and are fixed in v3 ([SECURITY_MODEL.md](SECURITY_MODEL.md)).
- The three "agents" are deterministic TypeScript modules, not LLMs. Their coordination (ranking, slice negotiation, independent checks) is real; there is no model inference.
- Dashboard clicks never create transactions. The on-chain transactions were sent once, by `scripts/testnet-setup.ts` (v2) and `scripts/testnet-setup-v3.ts` (v3).
