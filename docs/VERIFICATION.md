# Reproducing ZeroDelta's verification

Everything below runs on a normal laptop. Nothing signs or broadcasts a transaction, and no API keys are needed.

## 1. Setup

```bash
git clone https://github.com/g4stein/zerodelta.git && cd zerodelta
npm ci          # Node.js >= 20.9
```

## 2. The checks

| Command | What it proves | Network | Count |
|---|---|---|---|
| `npm run typecheck` | Whole repo type-checks | none | — |
| `npm test` | TypeScript unit + integration tests: NEP-413, scanner ranking and NO_TRADE, negotiation, 8 guard invariants, compromised solver, payload swap, replay, stale and concurrent nonces, intent/attestation/envelope tampering, mocked RPC failures, TS/Rust mirror vectors, Hyperliquid SDK vectors, exact sizing, the v3 build mirror, parity-fixture freshness, the v2 history and v3 proof data, the acceptance classifier | none (fetch is mocked where used) | 113 tests in 5 files |
| `cd contracts/risk-guard && cargo test` | The v2 contract's logic: 18 unit tests in `src/lib.rs` + 15 adversarial tests in `tests/adversarial.rs` (rounding boundaries, every order field bound by the payload, invalid symbols, u64 extremes, deposits, nonce floor) | none | 33 tests (needs Rust; 1.81 matches the deployed build) |
| `cd contracts/risk-guard-v3 && cargo test` | The v3 contract: Hyperliquid encoding units, the official SDK vectors, 64 actions and 110 contract-level cases byte-identical to the TypeScript mirror, and an adversarial test for every rejection | none | 44 tests (Rust 1.81) |
| `npm run verify:offline` | Offline subset of the harness, including both proofs, both WASM hashes, MPC signature recovery, the recorded Hyperliquid acceptance, NO_TRADE and Hyperliquid vectors | none | 29 pass, 36 skipped (live-only) |
| `npm run verify` | Everything above plus live read-only checks: NEAR RPC, `intents.near` `simulate_intents`, 1Click, Hyperliquid, both contracts' state, and every historical transaction re-fetched from an archival RPC | public endpoints | 75 checks |
| `npm run hl:acceptance` | POSTs the recorded MPC-signed order and two corrupted copies to Hyperliquid **testnet** `/exchange`; PASS only if the real signature recovers the pinned hedge address and both copies recover other addresses | Hyperliquid testnet (POST, no NEAR tx, no funds) | 3 requests |
| `npm run build` | Production Next.js build | none | — |

`npm run verify` exits non-zero if any check FAILs. A WARN means a live source was unreachable and a labelled fallback was used; SKIP only happens in offline mode. Public RPCs do rate-limit: the client fails over between FastNEAR and `rpc.*.near.org`, and a check that still can't reach the network fails rather than pretending to pass.

## 3. What the live on-chain checks look at

All read-only, via `EXPERIMENTAL_tx_status`, `view_account`, `view_access_key_list` and view calls:

- Contract `zerodelta-guard-fb604f.testnet` has **0 access keys**, code hash `6VqcNeQLfWWN7XyFHbvhZJoDoZLNQMEsgRpapn1jJEqk` (= sha256 of the committed WASM), policy 200/300/25, solver `zerodelta-solver-fb604f.testnet`, MPC target `v1.signer-prod.testnet` / `zerodelta/hedge/arbitrum`.
- [Tx 1](https://testnet.nearblocks.io/txns/12skMoFQC6sNfB6YNqmpEiK8DCQUWYFPcDLNoAvXM5Lx) deploy + `new` + delete key: success.
- [Tx 2](https://testnet.nearblocks.io/txns/DZaDDUGQQLBkdZHiZxn95NtrmeUiGrd3a7af4hn37JfV) approved order: success, contains the receipt `zerodelta-guard-fb604f.testnet → v1.signer-prod.testnet.sign`, return value = recorded signature.
- [Tx 3](https://testnet.nearblocks.io/txns/H46fyRHiFoVrY6L3k9758ceRB6bhfT9v4onqZKkbonQo), [Tx 4](https://testnet.nearblocks.io/txns/4PpxYCPEqwtLnuGR6i1Te2wWvs3Ynb94KqqqphEvbSHq), [Tx 5](https://testnet.nearblocks.io/txns/3rQrPFjByJmK676YJyX7v785unoSr6FanWTdrKfXqSff): failed with `DELTA_NEUTRALITY`, `PAYLOAD_COMMITMENT_MISMATCH`, `NONCE_ALREADY_USED`, and **none** has a receipt to the MPC contract.
- Attestation #0 on-chain holds the same decision hash, payload and signature; the signature recovers (offline, secp256k1) to `derived_public_key(zerodelta/hedge/arbitrum, zerodelta-guard-fb604f.testnet)`.
- `check_order_params` on the recorded orders: approved order → only `NONCE_ALREADY_USED` (already used), rogue → delta + leverage, swap → payload mismatch; the contract's `compute_payload` equals the TypeScript keccak256.

You can check the same things by hand on [Nearblocks](https://testnet.nearblocks.io/address/zerodelta-guard-fb604f.testnet) (Access Keys tab: none; Contract tab: methods).

## 3b. Section 10: Risk Guard v3

Offline (also run in CI):

- **v2 history unchanged:** `proofs/testnet-proof.v2.json` hashes to `99a0feb3…` (the original v2 file), and `testnet-proof.json`'s `previousDeployment` equals it.
- **v3 code and market table:** the committed v3 WASM hashes to the recorded code hash `CJ1BEUKB…`, and the stored market table is the Hyperliquid **testnet** table (BTC 3, ETH 4, SOL 0, NEAR 54).
- **Recorded v3 digest == TS mirror rebuilt from the recorded request.** This is the binding proof: the same legs, prices and nonce produce exactly the action, digest and commitment the contract recorded and the MPC signed.
- **Signature recovery:** the recorded `{r, s, v}` recovers to the pinned hedge address `0xef63…2c66`; flipped `v` does not.
- **Recorded Hyperliquid acceptance:** `hl-acceptance.json` is PASS for the real signature and FAIL (different address) for both controls; each recovered address appears in the raw response and equals local recovery.
- **The Rust parity fixture is current.**

Live, read-only:

- Every v3 transaction re-fetched from the archival RPC with the expected status and error: create, deploy + init + delete key, approved sign, `PRICE_OUT_OF_BAND`, `NONCE_ALREADY_USED`, `Method on_mpc_signed is private`.
- No rejected v3 transaction has a receipt to `v1.signer-prod.testnet`; the approved one has the contract-originated `sign` receipt and returned the recorded `{r, s, v}`.
- The v3 contract has 0 access keys, the recorded code hash, policy, market table, network, MPC target and solver.
- Attestation #0 holds the built action, digest, commitment and Hyperliquid signature.
- **The contract's own view rebuilds the same digest today** for the recorded request (and now rejects it because the nonce is used and stale).
- The live `derived_public_key` for (v3 contract, `zerodelta/hedge/hyperliquid`) is the pinned address.

The harness never posts to Hyperliquid; `npm run hl:acceptance` does that separately.

## 4. The committed report

`npm run verify` writes its report to `verify-report.local.json` (git-ignored), so running it never dirties the repo. `npm run verify:report` writes the committed snapshot `verify-report.json` instead. Each report records:

- `source.commit`: the commit the run started from; `source.dirty` (true if tracked files had uncommitted changes) and `source.uncommittedDiffSha256` (sha256 of `git diff HEAD`, identifying exactly which uncommitted changes ran).
- `environment` (Node, platform, Rust), `totals`, per-section counts, the contract and transaction ids, and every check's detail.

A report can't name the commit that contains it, so a committed report always describes its parent commit or uncommitted work on top of it. For a report tied to an exact commit, use the CI artifact (below) or run `npm run verify` yourself.

## 5. CI

[`.github/workflows/verify.yml`](../.github/workflows/verify.yml) runs on every push and pull request: `npm ci`, typecheck, tests, build, offline verification (uploads `verify-report-offline-<sha>` as an artifact), and the v2 and v3 Rust tests, with checks that both deployed WASM files and the original v2 proof file are byte-unchanged. Live verification is a separate manual job (`workflow_dispatch` with `live = true`) because public RPC availability is outside the repo's control.
