# Judging requirements and reproducible evidence

Primary track: **06 / SEC — AI Security & Defense**. Supporting demonstrations: DeFi and Swarms; Business describes the treasury use case. This document maps claims to evidence; it does not certify a score, prize outcome, or the saved submission fields.

Source: [official HACKATHON.md](https://nearhackathon.com/HACKATHON.md), retrieved 2026-11-12. Rules can change; consult that source before the deadline. The event starts November 1; Q-001 permits eligible code from the October 19 announcement. The official deadline is **2026-11-14 23:59 UTC** (November 15, 05:29 India Standard Time).

## Repository requirements

| Requirement | Evidence / verification | Boundary |
|---|---|---|
| Public repository through judging (Q-014, procedure 1) | [Public repository](https://github.com/g4stein/zerodelta), [LICENSE](../LICENSE) | Keep public; MIT is permitted. |
| Work in the eligible window; separate relevant changes (Q-001–004) | README development-history section, first commit November 8, dedicated executable-signing branch, historical submission tag and linked diffs | The tag is a historical snapshot; current hardening is on main. |
| Disclose libraries, boilerplate and AI-written code (Q-005) | README “Built with, and disclosure”, package manifests and Cargo lockfiles | AI assistance is allowed; it is not an independent security audit. |
| Explain product, problem, NEAR role and reproducible behavior (procedure 1, Q-017) | README first sections, [judge guide](JUDGE_GUIDE.md), API examples and [verification guide](VERIFICATION.md) | Commands distinguish offline checks from read-only live dependencies. |
| Testnet eligibility (Q-010) | Locked testnet contracts, transaction links, pinned proof files, verifier §9–11 | All tracks permit testnet; signer recovery does not establish a funded execution. |
| Track fit / integration (Q-011) | Contract-enforced policy and Chain Signatures; live Intents dry-run integration | Hints are not mandatory integrations. Real hardware TEE protection is not implemented. |
| Feature verification and reproducibility (Q-017) | TypeScript/Rust tests, offline/live verifier, exchange-evidence verifier, CI WASM byte comparison | Human judges decide; an automated result is preliminary evidence. |

## What the project demonstrates

| Review area | Concrete path | What must not be inferred |
|---|---|---|
| Technical implementation | Run the documented checks; inspect the keyless v3.1 contract, constructed order/digest, MPC receipt and exchange signer recovery | No filled order, verified profit or production-safe treasury. |
| Design and interaction | Open the demo → select size attack → check proposal → see `ORDER_SIZE_CAP`; inspect the remaining-price-risk scenario | A view call creates no signature or transaction. |
| Impact | Demonstrates moving external-order signing authority into immutable policy instead of an agent-held key | No adoption, revenue, realized yield or independently verified holdings is established. |
| Originality | Inspect the binding from raw legs to a contract-built executable order and contract-originated MPC signature | No claim of exclusive invention or a ranking against all entries. |
| Sustainability | Reproduce WASM, inspect threat model, disclosed audit history and production pathway | Immutable deployed code needs a new deployment for future fixes. |

These review areas are useful preparation, not a published numerical scoring rubric. The official rules do not publish weights for them.

## Explicit remaining boundaries

- Software-simulated TEE; no vendor-backed hardware attestation.
- Solver-supplied holdings, reference price, treasury, collateral and slippage remain trusted. A naked $80,000 short can pass by inflating reported treasury/collateral; coin caps limit signing volume, not actual outstanding positions.
- The immutable v3.1 deployment cannot sign closing buys, reduce-only orders or withdrawals. Recorded attempts consume window capacity even when MPC fails or orders never fill.
- Hyperliquid testnet signer recovery is recorded evidence; the account is unfunded and no order filled.
- Dashboard swarm runs demonstrate the historical v2 policy; the current read-only checker and executable-signing proof use v3.1.
- [Demo safeguards](DEMO_OPERATIONS.md) are instance-level; deployment-wide quotas require external configuration.

## Outside this repository review

The saved application, contact/consent/payout details and required public demo-post deliverable are separate submission requirements. They were not changed or certified in this pass. The project has already been submitted; do not submit it again. Any changes to saved fields go through the organizers' request-changes process.

Keep the hosted demo available through November 18, ideally November 25 (Q-012). A repository checklist alone cannot establish complete submission compliance.
