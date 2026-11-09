# ZeroDelta Risk Guard contract

Rust NEAR smart contract (near-sdk 5.5) deployed at [`zerodelta-guard-05eb36.testnet`](https://testnet.nearblocks.io/address/zerodelta-guard-05eb36.testnet).

| Method | Kind | Who | What it does |
|---|---|---|---|
| `new(solver, policy)` | init | guard account | Stores the owner, solver and policy (`max_delta_bps`, `max_leverage_x100`, `max_slippage_bps`) and emits `policy_registered`. |
| `set_policy(policy)` | change | owner only | Updates the policy. |
| `record_rebalance(rebalance)` | change | solver only | Checks the four hashes are 64-char lowercase hex and every metric is within the policy. If not, it panics with `ZERODELTA_REJECTED: …` and the transaction fails. Otherwise it stores the attestation and emits `rebalance_recorded`. |
| `check_rebalance(net_delta_bps, leverage_x100, slippage_bps)` | view | anyone | Runs the same policy check for free. |
| `get_policy`, `get_config`, `get_attestation_count`, `get_attestation(index)`, `get_attestations(from_index, limit)` | view | anyone | Read state. |

Units: `net_delta_bps` = |net delta| / treasury × 10,000; `leverage_x100` = notional / collateral × 100; `slippage_bps` = slice slippage in bps. The app rounds every metric **up** before sending it, so the on-chain check is never looser than the off-chain one.

## Build

The committed `res/zerodelta_risk_guard.wasm` is the exact file that was deployed: its sha256 (base58) equals the on-chain code hash `7TeTFvS3Pi8Kshxbx9MB41tSyEnxL8g28THd3GroEhw4`, which `npm run verify` checks.

To rebuild (Rust 1.81 is used because newer Rust emits WASM features the NEAR runtime does not accept):

```bash
rustup toolchain install 1.81.0 --target wasm32-unknown-unknown
npm run contract:build
```

`Cargo.lock` pins dependency versions that support Rust 1.81. A rebuild on a different machine is not guaranteed to be byte-identical.
