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
| `npm test` | TypeScript unit + integration tests: NEP-413, scanner ranking and NO_TRADE, negotiation, 8 guard invariants, compromised solver, payload swap, replay, stale and concurrent nonces, intent/attestation/envelope tampering, mocked RPC failures, TS/Rust mirror vectors, Hyperliquid SDK vectors, recorded proof data | none (fetch is mocked where used) | 91 tests in 3 files |
| `cd contracts/risk-guard && cargo test` | The deployed contract's logic: 18 unit tests in `src/lib.rs` + 15 adversarial tests in `tests/adversarial.rs` (rounding boundaries, every order field bound by the payload, invalid symbols, u64 extremes, deposits, nonce floor) | none | 33 tests (needs Rust; 1.81 matches the deployed build) |
| `npm run verify:offline` | Offline subset of the harness, including the recorded proof data, WASM hash, MPC signature recovery, NO_TRADE and Hyperliquid vectors | none | 22 pass, 25 skipped (live-only) |
| `npm run verify` | Everything above plus live read-only checks: NEAR RPC, `intents.near` `simulate_intents`, 1Click, Hyperliquid, the deployed contract's state, and every historical transaction re-fetched from an archival RPC | public endpoints | 57 checks |
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

## 4. The committed report

`verify-report.json` is the output of a real `npm run verify` run. It records:

- `source.commit`: the commit the run used, and `source.dirty` (true if tracked files had uncommitted changes, e.g. the run that produced the report before it was committed).
- `environment` (Node, platform, Rust), `totals`, per-section counts, the contract and transaction ids, and every check's detail.

A report can't name the commit that contains it, so a committed report always describes its parent commit or uncommitted work on top of it. For a report tied to an exact commit, use the CI artifact (below) or run `npm run verify` yourself; it overwrites the file.

## 5. CI

[`.github/workflows/verify.yml`](../.github/workflows/verify.yml) runs on every push and pull request: `npm ci`, typecheck, tests, build, offline verification (uploads `verify-report-offline-<sha>` as an artifact), and the Rust tests with a check that the deployed WASM is byte-unchanged. Live verification is a separate manual job (`workflow_dispatch` with `live = true`) because public RPC availability is outside the repo's control.
