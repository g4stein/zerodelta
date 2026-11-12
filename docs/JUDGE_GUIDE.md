# ZeroDelta judge guide

**Live demo:** [zerodelta.vercel.app](https://zerodelta.vercel.app/) · **Repo:** [github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta) · **Primary track:** 06 / SEC AI Security & Defense

Repository requirements: [Judging evidence](JUDGING_EVIDENCE.md). API limits and hosting boundaries: [Demo operations](DEMO_OPERATIONS.md). Web checks need Node.js >=20.9 and npm; contract tests/rebuilds additionally need Rust 1.81.0 and its WASM target.

## 30-second version

ZeroDelta demonstrates constrained external-order signing with a carry-strategy planner. Agents do not hold the derived signing key: a NEAR contract with **zero access keys** controls requests to NEAR Chain Signatures. In v3.1 it independently enforces the permitted sell order shape/market, coin caps, expiry and nonce rules, and builds the digest itself. Portfolio risk calculations use **solver-reported** holdings, treasury, collateral and prices; they cannot establish real neutrality against a compromised solver.

In **v3.1** the contract also builds the executable Hyperliquid order itself, caps its size in coins, bounds its expiry, and computes its EIP-712 digest on-chain, so the MPC signature *is* a Hyperliquid order signature. Hyperliquid testnet recovered exactly the contract's MPC-derived hedge address from it (`0xa74e…9f5e`); a flipped `v` and a flipped bit of `s` recover different addresses. That is signer recovery: no funds moved and nothing was filled. (The earlier v3 deployment had a size-inflation flaw found in our own pre-merge audit; it is kept as disclosed history, see the README.)

## The three strongest technical points

**1. The keyless contract is the signer, and it signs the executable order.** `sign_executable_hedge` builds one IOC sell from the approved legs (testnet market index, size = perp short ÷ limit in whole lots, limit within 100 bps of the reference, Hyperliquid tick rules, per-market size caps in coins, a one-hour `expiresAfter`, $10 minimum), computes `connectionId` and the EIP-712 digest, then itself calls `v1.signer-prod.testnet.sign`. It never accepts a digest from the solver. Evidence: [tx `2VWtrtEU…`](https://testnet.nearblocks.io/txns/2VWtrtEURh3QRF8iyVXq5xxaRprhcVVnwp7kYddxZvtR), with the receipt `zerodelta-guard-v31-c6e71c.testnet → v1.signer-prod.testnet.sign`; the Access Keys tab on [Nearblocks](https://testnet.nearblocks.io/address/zerodelta-guard-v31-c6e71c.testnet) is empty.

**2. The exchange's signer recovery confirms the binding.** [`hl-acceptance.json`](../hl-acceptance.json): Hyperliquid testnet `/exchange` recovered `0xa74e082a55e862845d510f8d609d315afd859f5e` from the real signature, `0x1989…c074` with `v` flipped and `0x54a3…c264` with one bit of `s` flipped. The link from the risk-checked legs to that digest is verify §11's *recorded digest == fresh TS rebuild* plus the live *contract view rebuilds the same digest today*. Hyperliquid remembers each (signer, nonce), so this exact post cannot be repeated: `npm run hl:acceptance` re-checks the recorded evidence offline, and `-- --live` reports a repeat as SPENT.

**3. Reproducible adversarial proof.** v3.1: 55 Rust tests (official Hyperliquid SDK vectors, 134 contract-level cases byte-identical to the TypeScript mirror, an adversarial test for every rejection) and a mutation run in which 27/27 deliberate contract bugs were caught ([`MUTATION_RESULTS.md`](../contracts/risk-guard-v31/MUTATION_RESULTS.md); v3: 15/15). v2: 33 Rust tests. 208 TypeScript tests. `npm run verify` (95 checks) re-fetches every historical transaction of both contracts from an archival RPC and checks that no rejected transaction produced an MPC receipt.

## Where to click (about 3 minutes)

1. **Do** open [zerodelta.vercel.app](https://zerodelta.vercel.app/) **→ see** **Try the current contract** first. Select **Within policy**, then **Attack: inflate size** and **Attack: long expiry**, clicking **Check proposal** each time. These fresh read-only v3.1 calls display the contract's verdict, order, digest and block. Select **Inspect remaining price risk** for the trusted-price limitation and **Naked short with inflated treasury** for the reported-holdings/treasury limitation: zero spot and an $80,000 short can pass with an $800 million reported treasury/collateral. The result is a live verdict, not an expected-value fallback. No transaction or signature is created. The network/v2 strip is collapsed under the current proof.
2. **Do** read the v3.1 panel left to right **→ see** approved legs → contract-built order (IOC sell on testnet market 4) → digest (green checks: *recomputed in your browser* equals the contract's digest) → MPC `{r, s, v}` (recovers to the hedge address in your browser; flipped `v` does not) → Hyperliquid testnet's recorded answer for the real and both corrupted signatures. The top-right badges are read live from the v3.1 contract: *locked (0 keys)* and *attestation #0 Signed; digest, {r,s,v} and action match the proof*.
3. **Do** click the links under the panel **→ see** the rejected v3.1 transactions on Nearblocks: `ORDER_SIZE_CAP` (the size-inflation attack), `EXPIRY_TOO_FAR`, `NONCE_ALREADY_USED`, `Method on_mpc_signed is private`.
4. **Do** click the amber **Simulate Compromised Solver** (v2 demo, unchanged) **→ see** the solver's claim (≈0% delta) next to what its payload really commits to (≈1000% delta, 10x), the deployed contract's live verdict and the matching historical on-chain rejection.
5. **Do** click the green **Execute Autonomous Delta-Neutral Rebalance** **→ see** Agent 1's ranking (funding minus live 1Click costs), the Agent 1/2 negotiation, Agent 3's 8 checks and the contract's verdict. This run is a **SIMULATED EXECUTION** against the v2 contract: the dashboard swarm uses v2, and v3.1 is the executable-signing path. If funding is negative, Agent 1 says **NO_TRADE**; tick the demo override to see the full flow.

## Reproduce

```bash
npm ci && npm run typecheck && npm test && npm run build
npm run verify              # live, read-only; §10 is v3 (superseded history), §11 is v3.1
npm run verify:offline      # no network
npm run hl:acceptance       # offline: checks recorded signer-recovery evidence; expect PASS
(cd contracts/risk-guard && cargo +1.81.0 test --locked)      # v2
(cd contracts/risk-guard-v3 && cargo +1.81.0 test --locked)   # superseded v3
(cd contracts/risk-guard-v31 && cargo +1.81.0 test --locked)  # current v3.1
```

`npm run hl:acceptance` makes no network requests and writes nothing. It checks the recorded exchange responses against the proof: the real signature must recover the pinned hedge address, and both corrupted signatures must recover different addresses. `npm run hl:acceptance -- --live` posts the recorded order and the two controls to Hyperliquid testnet; a repeated nonce is reported as `SPENT`, not a fresh pass. It writes only the git-ignored local report and sends no NEAR transaction. Details: [VERIFICATION.md](VERIFICATION.md).

## Key files

| What | File |
|---|---|
| Superseded v3 contract (historical encoding/signing path) | [`contracts/risk-guard-v3/src/lib.rs`](../contracts/risk-guard-v3/src/lib.rs), [`hl.rs`](../contracts/risk-guard-v3/src/hl.rs), [README](../contracts/risk-guard-v3/README.md) |
| v3 tests | [`sdk_vectors.rs`](../contracts/risk-guard-v3/tests/sdk_vectors.rs), [`ts_parity.rs`](../contracts/risk-guard-v3/tests/ts_parity.rs), [`adversarial.rs`](../contracts/risk-guard-v3/tests/adversarial.rs) |
| v3 TypeScript mirror | [`src/lib/hyperliquid/v3Hedge.ts`](../src/lib/hyperliquid/v3Hedge.ts), [`fixedPoint.ts`](../src/lib/hyperliquid/fixedPoint.ts), [`exchangeSigning.ts`](../src/lib/hyperliquid/exchangeSigning.ts) |
| v3.1 contract (caps, expiry, builds the order, signs) | [`contracts/risk-guard-v31/src/lib.rs`](../contracts/risk-guard-v31/src/lib.rs), [`hl.rs`](../contracts/risk-guard-v31/src/hl.rs), [`MUTATION_RESULTS.md`](../contracts/risk-guard-v31/MUTATION_RESULTS.md) |
| v3.1 TypeScript mirror, deploy + proof txs | [`v31Hedge.ts`](../src/lib/hyperliquid/v31Hedge.ts), [`scripts/testnet-setup-v31.ts`](../scripts/testnet-setup-v31.ts) |
| v3 (superseded) deploy + proof txs, exchange check | [`scripts/testnet-setup-v3.ts`](../scripts/testnet-setup-v3.ts), [`scripts/hl-acceptance.ts`](../scripts/hl-acceptance.ts) |
| v2 contract and tests | [`contracts/risk-guard/src/lib.rs`](../contracts/risk-guard/src/lib.rs), [`tests/adversarial.rs`](../contracts/risk-guard/tests/adversarial.rs) |
| Agents | [`scannerAgent.ts`](../src/lib/agents/scannerAgent.ts), [`solverAgent.ts`](../src/lib/agents/solverAgent.ts), [`guardianAgent.ts`](../src/lib/agents/guardianAgent.ts), [`orchestrator.ts`](../src/lib/swarm/orchestrator.ts) |
| Fresh read-only proposal checker | [`src/app/api/hedge-preview/route.ts`](../src/app/api/hedge-preview/route.ts), [`preview.ts`](../src/lib/hyperliquid/preview.ts) |
| Second review and regressions | [SECOND_REVIEW.md](SECOND_REVIEW.md), [`reviewRegressions.test.ts`](../tests/reviewRegressions.test.ts) |
| Source-to-WASM byte comparison | [`scripts/verify-wasm.sh`](../scripts/verify-wasm.sh) |
| Verification harness | [`scripts/verify-hackathon.ts`](../scripts/verify-hackathon.ts) |
| Proof data | [`testnet-proof.json`](../testnet-proof.json) (v3.1, v3 then v2 under `previousDeployment`), [`hl-acceptance.json`](../hl-acceptance.json) |
| Threat model | [SECURITY_MODEL.md](SECURITY_MODEL.md) |

## Why NEAR specifically

- **Chain Signatures with contract callers.** The MPC key is a function of the calling account, and a NEAR contract can be the caller. That is what lets a smart contract, rather than a person, be the only holder of signing authority over an external-chain key, here a Hyperliquid key.
- **Keyless contract accounts.** NEAR accounts can delete every access key, which makes the policy and code provably immutable and leaves no side door.
- **NEAR Intents.** Spot legs are priced through live 1Click quotes and the signed NEP-413 intent is executed by the real `intents.near` contract in `simulate_intents`, which verifies the signature and stops at the balance check.

## Not implemented (please don't credit these)

- Independent portfolio neutrality: the naked-short view can pass at 1 bps delta / 0.01× reported leverage. With the same $80,000 short but a $50,000 treasury, delta is 16,000 bps and fails. Both use unverified reported inputs.
- Closing positions and withdrawing: v3.1 signs only non-reduce-only sells. It cannot sign buys, close-only orders or withdrawals. Daily signing caps do not track accumulated positions. Do not fund this deployment as a complete carry lifecycle.
- Guaranteed strategy availability: recorded attempts consume rolling-window capacity before MPC completes, including failures and unfilled orders. No quota rollback is implemented.

- No funds move, no order is placed or filled, there is no funded execution on mainnet. v3.1 proves Hyperliquid's signer recovery returns the hedge key's address; the hedge address has no Hyperliquid account (the testnet faucet requires a mainnet deposit, which we didn't make).
- The reference price is a trusted solver input and size follows notional ÷ limit. v3.1 bounds that with per-market coin caps (per order, per 24 h, and an order count), but a cheaper price that still fits under the cap is approved (about 2× the intended size at half price). The v3 deployment had no such cap; that is the disclosed flaw.
- The TEE is software-simulated; there is no hardware attestation.
- The contracts trust the solver's treasury size, collateral and slippage figures. v2's findings F-1 and F-2 remain in the immutable v2 contract and are fixed in v3.1 ([SECURITY_MODEL.md](SECURITY_MODEL.md)).
- The three "agents" are deterministic TypeScript modules, not LLMs. Their coordination (ranking, slice negotiation, independent checks) is real; there is no model inference.
- Dashboard clicks never create transactions. The on-chain transactions were sent once, by `scripts/testnet-setup.ts` (v2) and `scripts/testnet-setup-v3.ts` (v3) and `scripts/testnet-setup-v31.ts` (v3.1).
