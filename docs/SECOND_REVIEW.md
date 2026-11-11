# Second review: close reproduced off-chain consistency gaps

Reviewed baseline: main `b57e062`. This follow-up leaves all deployed contracts, WASM binaries, recorded transaction proofs and exchange response artifacts unchanged.

| Finding | Resolution | Regression evidence |
|---|---|---|
| Negative reported delta hides a perp LONG | Derive exposure from canonical leg direction and cent-rounded notionals; apply integer-rounded risk limits | Re-attested directional plan rejected; 201-bps boundary rejected |
| Failed quotes become valid by flipping metadata | Trusted adapter retains immutable quote hashes, recipient, mode, eligibility and time under random receipt IDs; guardian checks that record and binds quote hashes into attestation | Unchanged old attestation fails binding; fresh malicious attestation still cannot validate altered evidence |
| Intent minima can be reduced by changing solver quotes | Verify complete quote evidence, bind fill USD to executable plan legs, and enforce requested slippage minimum at the network boundary | Altered quote and signed intent rejected despite a valid new software attestation |
| Slice fields not fully checked | Validate assets, leg IDs, positive amounts/minima, exact totals, indices/count, recipient and release schedule | Eleven classes of correctly encrypted and freshly attested malicious slices rejected |
| Audit verifier accepts changed explanations or truncated history | Canonical hashes cover explanations; guardian signature seals root/count/decision; caller supplies expected signing identity and decision hash | Changed detail, truncated/empty histories, wrong root/key/decision/signature rejected |
| Acceptance command trusts stored PASS flags | Shared strict verifier rebuilds digest, checks requests and exact controls, parses responses and recomputes recovery/classification | Twelve corrupt-record variants rejected; jointly edited proof/action rejected; real preserved evidence still passes |
| Arbitrary plan hash copied into decisions | Require equality with canonical plan hash; signed decision/prepared call use recomputed value | Fabricated plan hash rejects authorization; decision carries actual hash |

## Boundaries

This does not make the application production-safe for funds. The quote adapter is trusted code in the same server process, not a sandbox for arbitrary remote code execution. HTTP quote provenance is not a vendor-signed quote, and the TEE remains software-simulated. The audit seal authenticates a history relative to the caller's expected guardian key; that ephemeral key still needs an external trust source and is not an on-chain anchor. Historical exchange HTTP responses are unsigned: their internal consistency can be verified, their historical origin cannot be proven cryptographically offline.

The locked contract still trusts reported actual holdings, collateral, slippage and reference price. Its rolling window limits signing flow rather than outstanding positions. Independent oracle and position verification require separate design and deployment.

## Validation

- 184 TypeScript tests across eight files (40 additional cases).
- Type checking, production build and offline verification.
- Live verification against public NEAR/1Click/Hyperliquid read-only endpoints; no transaction broadcast.
- Production preview scenarios remain unchanged; browser smoke checks cover the preview and guard demo.
- CI retains all 132 Rust tests and byte-for-byte rebuild comparisons for the three historical WASM binaries.

Exact-commit verification outputs are CI artifacts; the prior committed report remains a labelled historical snapshot.
