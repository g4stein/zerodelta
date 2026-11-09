# ZeroDelta judge guide

**Live demo:** [zerodelta.vercel.app](https://zerodelta.vercel.app/) · **Repo:** [github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta) · **Primary track:** 06 / SEC AI Security & Defense

## 30-second version

AI agents run a delta-neutral carry strategy (spot long + equal perp short) for a treasury. The agents never hold the signing key. The key is derived by NEAR Chain Signatures for a NEAR contract with **zero access keys**, and that contract only requests a signature after it recomputes the risk from the raw order legs and checks the order's keccak256 fingerprint and nonce. A lying solver gets a failed transaction, not a signature. Five real testnet transactions show one approval and three blocked attacks.

## The three strongest technical points

**1. Contract-gated MPC authorization.** `record_rebalance` itself calls `v1.signer-prod.testnet.sign`, so the MPC network derives the key from the contract account. The deploy transaction deleted the account's only key: no person or agent can sign as it, change the policy, or redeploy. Evidence: receipt `zerodelta-guard-fb604f.testnet → v1.signer-prod.testnet.sign` inside [tx 2](https://testnet.nearblocks.io/txns/DZaDDUGQQLBkdZHiZxn95NtrmeUiGrd3a7af4hn37JfV); Access Keys tab on [Nearblocks](https://testnet.nearblocks.io/address/zerodelta-guard-fb604f.testnet) is empty.

**2. Independent order-risk recomputation and payload commitment.** The contract takes raw legs in cents, computes net delta and leverage itself (rounded up), and requires the signed payload to equal `keccak256` of every order field plus its own account id. Safe-looking numbers with a payload for a different order fail with `PAYLOAD_COMMITMENT_MISMATCH` ([tx 4](https://testnet.nearblocks.io/txns/4PpxYCPEqwtLnuGR6i1Te2wWvs3Ynb94KqqqphEvbSHq)).

**3. Reproducible adversarial proof.** 33 Rust tests on the contract, 91 TypeScript tests, and `npm run verify` (57 checks) that re-fetches every historical transaction from an archival RPC and checks that no rejected transaction produced an MPC receipt.

## Where to click (about 3 minutes)

1. Open [zerodelta.vercel.app](https://zerodelta.vercel.app/). The top bar is a **LIVE READ-ONLY CHECK** of NEAR and the contract; the row below it links the five **HISTORICAL ON-CHAIN PROOF** transactions.
2. **Approved run:** leave pair on *Auto* and click the green **Execute Autonomous Delta-Neutral Rebalance**. Look at Agent 1's ranking table (funding minus live 1Click costs), the Agent 1/2 negotiation box, Agent 3's 8 checks, and "Testnet contract verdict". The run is a **SIMULATED EXECUTION**: `intents.near` dry-runs the signed intent and the contract call is prepared, not sent. If live funding is negative, Agent 1 says **NO_TRADE** and stays in USDC; tick the demo override to see the full flow anyway.
3. **Flagship attack:** click the amber **Simulate Compromised Solver**. The side-by-side panel shows the solver's claim (≈0% delta), the order its payload really commits to (≈1000% delta, 10x), which checks caught it, the deployed contract's live verdict, and the matching historical on-chain rejection.
4. **Rogue AI:** the red button injects an unhedged 10x long; it fails on the math both off-chain and in the contract.
5. Proof inspector → **On-chain proof (testnet)** tab: live contract state, this run recomputed by the contract, and the five transactions with Nearblocks links.

## Reproduce

```bash
npm ci && npm run typecheck && npm test && npm run build
npm run verify            # live, read-only
npm run verify:offline    # no network
cd contracts/risk-guard && cargo test   # needs Rust 1.81
```

Details: [VERIFICATION.md](VERIFICATION.md).

## Key files

| What | File |
|---|---|
| Deployed contract | [`contracts/risk-guard/src/lib.rs`](../contracts/risk-guard/src/lib.rs) |
| Contract adversarial tests | [`contracts/risk-guard/tests/adversarial.rs`](../contracts/risk-guard/tests/adversarial.rs) |
| TS mirror of the commitment | [`src/lib/near/orderCommitment.ts`](../src/lib/near/orderCommitment.ts) |
| On-chain reads, tx + receipt verification | [`src/lib/near/riskGuardContract.ts`](../src/lib/near/riskGuardContract.ts) |
| Agents | [`scannerAgent.ts`](../src/lib/agents/scannerAgent.ts), [`solverAgent.ts`](../src/lib/agents/solverAgent.ts), [`guardianAgent.ts`](../src/lib/agents/guardianAgent.ts), [`orchestrator.ts`](../src/lib/swarm/orchestrator.ts) |
| Verification harness | [`scripts/verify-hackathon.ts`](../scripts/verify-hackathon.ts) |
| Proof data | [`testnet-proof.json`](../testnet-proof.json) |
| Threat model | [SECURITY_MODEL.md](SECURITY_MODEL.md) |

## Why NEAR specifically

- **Chain Signatures with contract callers.** The MPC key is a function of the calling account, and a NEAR contract can be the caller. That is what lets a smart contract, rather than a person, be the only holder of signing authority over an external-chain key.
- **Keyless contract accounts.** NEAR accounts can delete every access key, which makes the policy and code provably immutable and leaves no side door.
- **NEAR Intents.** Spot legs are priced through live 1Click quotes and the signed NEP-413 intent is executed by the real `intents.near` contract in `simulate_intents`, which verifies the signature and stops at the balance check.

## Not implemented (please don't credit these)

- No funds move and no trades execute. Settlement is a dry run.
- The MPC signature covers a ZeroDelta order commitment, not a Hyperliquid action; it cannot be submitted to Hyperliquid ([HYPERLIQUID_EXECUTION_PATH.md](HYPERLIQUID_EXECUTION_PATH.md)). The repo only contains an offline signing module matched to the official SDK's vectors.
- The TEE is software-simulated; there is no hardware attestation.
- The contract trusts the solver's treasury size and slippage figures. Open findings F-1 (nonce exhaustion) and F-2 (storage exhaustion) are documented in [SECURITY_MODEL.md](SECURITY_MODEL.md).
- The three "agents" are deterministic TypeScript modules, not LLMs. Their coordination (ranking, slice negotiation, independent checks) is real; there is no model inference.
- Dashboard clicks never create transactions. The five on-chain transactions were sent once by `scripts/testnet-setup.ts`.
