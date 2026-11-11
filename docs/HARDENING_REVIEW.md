# PR #6: solver boundary hardening and judge preview

Historical validation snapshot for the first hardening pass. The subsequent review found additional cases addressed in [SECOND_REVIEW.md](SECOND_REVIEW.md).

This change addresses the review of main at `437e6f6` without changing the deployed contracts or recorded proofs.

| Finding | Change | Evidence |
|---|---|---|
| Replaced intent accepted with the original attestation | Guardian recomputes the signed payload hash and uses it for attestation and decision binding; metadata must match | `tests/intentBoundary.test.ts`: replacement payload fails hash and attestation binding |
| Validly signed but wrong operations, assets or signer accepted | Orchestrator supplies expected signer; guardian checks exactly one complete token-diff, permitted assets, spend and minimum receipts | Re-signed and re-attested malicious intents are still rejected |
| Missing reference quote becomes zero measured impact | Require validated live slice and reference quotes; unavailable data cannot prepare an MPC request | Missing slice/reference, stale timestamp, malformed values and missing validity-marker regressions |
| Invalid date accepted | Finite future deadline, maximum 30 minutes | Invalid, expired and far-future deadline regressions |
| Binary hashes do not connect source to deployment | CI rebuilds v2, v3 and v3.1 with Rust 1.81.0 and locked dependencies, remaps the historical dependency panic path, then compares entire binaries | `scripts/verify-wasm.sh`; all three rebuilt binaries match historical bytes |
| Historical evidence and fresh reads are hard to distinguish | Current v3.1 read-only preview appears first; historical signing evidence remains below; v2 telemetry is collapsed | Four browser-tested scenarios; RPC outage clears the previous verdict |

## Validation

- 144 TypeScript tests across seven files, including 26 additional regressions/scenario tests.
- Type checking and production build.
- Live verification: 95 checks, no warnings or failures, using the environment's outbound HTTP proxy.
- WASM: v2 `51ada920…`, v3 `02e49d42…`, v3.1 `82447883…`; complete byte comparisons, not normalized comparisons.
- Rust tests: v2 33 passed, v3 44 passed, v3.1 55 passed (132 total).
- Chromium: normal proposal accepted, size-inflation and long-expiry proposals rejected, half-price residual risk exposed; unknown scenario returns 400, unsupported POST returns 405, simulated RPC outage clears the verdict, no horizontal overflow at 390/1280 px, no page errors.

These results were obtained locally with Node 24 and Rust 1.81.0. CI runs the application checks on Node 22. Exact-commit verification reports are CI artifacts; the committed older report remains historical evidence.

## Remaining boundaries

No funds move, no order fills, and the TEE remains software-simulated. The contract still trusts holdings, collateral, slippage and reference prices reported by the solver. The rolling window limits signing flow, not outstanding positions. The quote timestamp is checked when the provider supplies it; absent a timestamp, freshness means a response fetched during this run. An independent oracle, authenticated holdings and position accounting need a separate contract design and deployment. The preview explicitly demonstrates the trusted-price limitation.
