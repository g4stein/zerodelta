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
| `npm test` | TypeScript unit + integration tests: NEP-413, scanner ranking and NO_TRADE, negotiation, 8 guard invariants, compromised solver, payload swap, replay, stale and concurrent nonces, intent/attestation/envelope tampering, mocked RPC failures, TS/Rust mirror vectors, Hyperliquid SDK vectors, exact sizing, the v3 and v3.1 build mirrors, parity-fixture freshness, the v2, v3 and v3.1 proof data, the acceptance classifier | none (fetch is mocked where used) | 184 tests in 8 files |
| `cd contracts/risk-guard && cargo test` | The v2 contract's logic: 18 unit tests in `src/lib.rs` + 15 adversarial tests in `tests/adversarial.rs` (rounding boundaries, every order field bound by the payload, invalid symbols, u64 extremes, deposits, nonce floor) | none | 33 tests (needs Rust; 1.81 matches the deployed build) |
| `cd contracts/risk-guard-v3 && cargo test` | The v3 contract: Hyperliquid encoding units, the official SDK vectors, 64 actions and 110 contract-level cases byte-identical to the TypeScript mirror, and an adversarial test for every rejection | none | 44 tests (Rust 1.81) |
| `cd contracts/risk-guard-v31 && cargo test` | The v3.1 contract: size caps, rolling window, expiry, minimum order value, malformed MPC response, SDK vectors, 134 contract-level cases byte-identical to the TypeScript mirror | none | 55 tests (Rust 1.81) |
| `python3 contracts/mutation-test.py v31` | Applies 27 deliberate bugs to a copy of the v3.1 source and checks each makes a test fail (`v3` runs the 15-bug set); writes `MUTATION_RESULTS.md` | none (needs Rust) | 27/27 caught |
| `npm run verify:offline` | Offline subset of the harness, including both proofs, both WASM hashes, MPC signature recovery, the recorded Hyperliquid acceptance, NO_TRADE and Hyperliquid vectors | none | 37 pass, 48 skipped (live-only) |
| `npm run verify` | Everything above plus live read-only checks: NEAR RPC, `intents.near` `simulate_intents`, 1Click, Hyperliquid, both contracts' state, and every historical transaction re-fetched from an archival RPC | public endpoints | 95 checks |
| `npm run hl:acceptance` | Offline by default: re-checks the **recorded** Hyperliquid responses in `hl-acceptance.json` against `testnet-proof.json` and writes nothing. `-- --live` posts the order and two corrupted copies to Hyperliquid **testnet** `/exchange` and writes only `hl-acceptance.local.json`. Hyperliquid remembers (signer, nonce), so a live repeat answers "duplicate nonce" and is reported as SPENT, not a pass. `-- --live --record` overwrites the recorded file only after a live PASS | offline: none; live: Hyperliquid testnet (POST, no NEAR tx, no funds) | 3 requests with `--live` |
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

## 3b. Sections 10 and 11: Risk Guard v3 (superseded) and v3.1 (current)

Section 11 runs the same checks for v3.1 (`testnet-proof.json`, `hl-acceptance.json`, `hl_vectors_v31.json`) and adds: the v3 proof is preserved byte-identically, the v3 findings are disclosed in the proof file, the stored market table carries the coin caps, the digest includes `expiresAfter`, and the size-inflation and over-long-expiry attacks were rejected on-chain with no MPC receipt. Section 10 is the same list for the superseded v3 and reads `proofs/hl-acceptance.v3.json`. The text below describes both.

Offline (also run in CI):

- **Proof history unchanged:** `proofs/testnet-proof.v2.json` is the original v2 file; `proofs/testnet-proof.v3.json` is the preserved v3 file. The top-level `testnet-proof.json` is v3.1, its `previousDeployment` is v3, and that deployment's `previousDeployment` is v2.
- **Committed WASM and market tables:** the harness checks the recorded code hashes and pinned Hyperliquid testnet markets for each deployment (BTC 3, ETH 4, SOL 0, NEAR 54). v3.1 also records coin-denominated caps and expiry policy.
- **Recorded digest == fresh TypeScript rebuild:** the recorded legs, prices, nonce and, for v3.1, `expiresAfter` must reproduce the action, digest and commitment the contract recorded and MPC signed.
- **Signature recovery:** v3.1's recorded signature recovers to `0xa74e082a55e862845d510f8d609d315afd859f5e`; the superseded v3 signature recovers to its own address `0xef63…2c66`. Corrupted signatures must recover different addresses.
- **Recorded Hyperliquid responses:** section 11 reads `hl-acceptance.json` for v3.1; section 10 reads `proofs/hl-acceptance.v3.json`. The raw exchange responses must contain the same addresses as local signature recovery. This proves signer recovery, not an order fill.
- **Parity fixtures are current:** Rust fixtures must match the TypeScript mirrors.

Live, read-only:

- Historical transactions are fetched from archival RPC and checked for the expected outcome. For v3.1 these include the size-inflation attack (`ORDER_SIZE_CAP`), over-long expiry (`EXPIRY_TOO_FAR`), replay and private-callback rejection. v3's earlier price-band rejection remains historical evidence only.
- Rejected transactions must have no MPC signing receipt; approved transactions must contain the contract-originated signing receipt and recorded signature.
- Each contract must have 0 access keys and match its recorded code hash, policy, market table, network, MPC target and solver.
- Attestation #0 must match the recorded built action, digest and signature.
- The contract view rebuilds the recorded digest today, even though the historical nonce is now used and stale.
- The live `derived_public_key` for each contract and `zerodelta/hedge/hyperliquid` must match that deployment's pinned hedge address.

The harness never posts to Hyperliquid. `npm run hl:acceptance` also runs offline by default; only `npm run hl:acceptance -- --live` posts the recorded requests. Duplicate nonces are reported as `SPENT`, not a new pass.

## 4. The committed report

`npm run verify` writes its report to `verify-report.local.json` (git-ignored), so running it never dirties the repo. `npm run verify:report` writes the committed snapshot `verify-report.json` instead. Each report records:

- `source.commit`: the commit the run started from; `source.dirty` (true if tracked files had uncommitted changes) and `source.uncommittedDiffSha256` (sha256 of `git diff HEAD`, identifying exactly which uncommitted changes ran).
- `environment` (Node, platform, Rust), `totals`, per-section counts, the contract and transaction ids, and every check's detail.

A report can't name the commit that contains it, so a committed report always describes its parent commit or uncommitted work on top of it. For a report tied to an exact commit, use the CI artifact (below) or run `npm run verify` yourself.

## 5. CI

[`.github/workflows/verify.yml`](../.github/workflows/verify.yml) runs on every push and pull request: `npm ci`, typecheck, tests, build, offline verification (uploads `verify-report-offline-<sha>` as an artifact), and the v2, v3 and v3.1 Rust tests, with checks that all three deployed WASM files and the original v2 and v3 proof files are byte-unchanged. Live verification is a separate manual job (`workflow_dispatch` with `live = true`) because public RPC availability is outside the repo's control.

## 6. Source-to-deployment reproducibility

`bash scripts/verify-wasm.sh` builds v2, v3 and v3.1 with Rust 1.81.0, the WASM target and each Cargo.lock. The original binaries embed `/root/.cache/cargo` in dependency panic locations; `--remap-path-prefix` makes that diagnostic prefix reproducible from any Cargo home. `cmp` checks complete binary equality. No committed WASM is overwritten. CI executes this in addition to the fixed historical hash checks.

The source hardening regressions live in `tests/intentBoundary.test.ts`; they cover substituted payloads, complete token-diff validation, the orchestrator's expected signer, deadlines, malformed messages, missing reference/slice quotes, invalid numeric values and stale timestamps. `tests/preview.test.ts` covers the current-contract judge scenarios.

## 7. Second-review regressions

`tests/reviewRegressions.test.ts` exercises directional orders hidden behind forged deltas, quote-validity laundering, quote minima changed with a fresh signature and attestation, aggregate impact mismatches, receipt identity and expiry, invalid amounts, fabricated plan hashes, executable-slice tampering, audit-history edits/truncation/seal forgery, and corrupted recorded exchange evidence.

The live verifier and standalone acceptance command share `verifyRecordedAcceptance`. They rebuild the exchange request digest, parse raw responses and recompute all three signature recoveries; the saved flags are compared with the result rather than trusted. `verifyAuditChain(events, seal, expectedPublicKey, expectedDecisionHash)` checks the signed complete history relative to the identity supplied by its caller. Historical immutable proof artifacts are not rewritten.

## 8. Reading check counts and source metadata

Offline mode currently records 37 passing checks and 48 live-only skips (85 result entries). Online mode executes those live sections, some of which expand into several checks, for 95 entries. The skip count is not a count of sections and is not intended to add to the online check count.

A refreshed committed report is generated from a clean source commit, then saved in a subsequent report-only commit. Read its `source.commit` and `source.dirty` fields to identify what actually ran. CI artifacts identify the exact CI head instead. The report's Rust version describes the host toolchain visible to the TypeScript harness; deployed contract builds and tests explicitly pin Rust 1.81.0 regardless of the host default.
