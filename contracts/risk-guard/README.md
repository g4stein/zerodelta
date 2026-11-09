# ZeroDelta Risk Guard v2 contract

Rust NEAR smart contract (near-sdk 5.5) deployed at [`zerodelta-guard-fb604f.testnet`](https://testnet.nearblocks.io/address/zerodelta-guard-fb604f.testnet). The deploy transaction deleted the account's only access key, so the policy, the solver and the code are immutable, and only this code can act as the account.

| Method | Kind | Who | What it does |
|---|---|---|---|
| `new(solver, policy, mpc_signer_contract?, mpc_path?)` | init | deployer | Stores the solver, the policy (`max_delta_bps`, `max_leverage_x100`, `max_slippage_bps`) and the MPC target (default `v1.signer-prod.testnet`, path `zerodelta/hedge/arbitrum`). |
| `record_rebalance(rebalance, request_mpc_sign?)` | change, payable | solver only | Recomputes net delta and leverage from the raw legs, checks the slippage ceiling, checks that `hedge_order_payload_hex == keccak256(canonical order)`, and that the nonce is above `last_nonce`. Then stores the attestation and, if `request_mpc_sign` (≥ 1 yocto attached, ~300 Tgas), calls the MPC contract's `sign` itself and stores the signature in the `on_mpc_signed` callback. Any failure panics with `ZERODELTA_REJECTED: …`. |
| `on_mpc_signed(index)` | private callback | this contract | Marks the attestation `Signed` (with the signature) or `Failed`. |
| `check_order_params(order, hedge_order_payload_hex)` | view | anyone | Runs every check for free and returns the contract-computed metrics, the expected payload and the violations. |
| `compute_payload(order)` | view | anyone | The payload the contract would accept for an order. |
| `check_rebalance(net_delta_bps, leverage_x100, slippage_bps)` | view | anyone | Legacy check on pre-computed metrics; not used for authorization. |
| `get_policy`, `get_config`, `get_last_nonce`, `get_attestation_count`, `get_attestation(index)`, `get_attestations(from_index, limit)` | view | anyone | Read state. |

Rejection reasons: `UNAUTHORIZED_SOLVER`, `MALFORMED_HASH`, `INVALID_ORDER`, `DELTA_NEUTRALITY`, `LEVERAGE_CEILING`, `SLIPPAGE_CEILING`, `PAYLOAD_COMMITMENT_MISMATCH`, `NONCE_ALREADY_USED`, `MPC_DEPOSIT_REQUIRED`, `UNEXPECTED_DEPOSIT`, `INSUFFICIENT_GAS`.

Commitment preimage (all integers in USD cents, decimal):

```
zerodelta-hedge-v1|<contract id>|<asset>|<treasury>|<spot_long>|<perp_short>|<perp_long>|<collateral>|<quoted_slippage_bps>|<nonce>
```

Metrics are rounded **up**: `net_delta_bps = ceil(|spot + perp_long − perp_short| × 10 000 / treasury)`, `leverage_x100 = ceil((spot + perp_short + perp_long) × 100 / collateral)`.

## Test

```bash
cargo test     # 18 unit tests: valid order, rogue math, payload swap, replay, older nonce,
               # unauthorized caller, guard account itself, inflated collateral, malformed hash,
               # MPC promise + callback (success and failure), deposit rules, slippage, vectors
```

## Build

The committed `res/zerodelta_risk_guard.wasm` is the exact deployed file: its sha256 (base58) equals the on-chain code hash `6VqcNeQLfWWN7XyFHbvhZJoDoZLNQMEsgRpapn1jJEqk`, which `npm run verify` checks.

Rebuild with Rust 1.81 (newer Rust emits WASM features the NEAR runtime rejects):

```bash
rustup toolchain install 1.81.0 --target wasm32-unknown-unknown
npm run contract:build
```

`Cargo.lock` pins dependency versions that support Rust 1.81. A rebuild on another machine is not guaranteed to be byte-identical.
