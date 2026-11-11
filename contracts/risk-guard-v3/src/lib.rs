//! ZeroDelta Risk Guard v3 (work in progress on branch `v3-executable-signing`).
//!
//! CP1: [`hl`] ports the verified Hyperliquid signing logic from
//! `src/lib/hyperliquid/exchangeSigning.ts` to integer-only Rust so the contract can
//! build the executable order and its EIP-712 digest on-chain. The contract itself
//! (risk recompute, price band, nonce, commitment, guard-gated MPC) is added in CP2.
//! The deployed v2 contract in `contracts/risk-guard` is not changed.

pub mod hl;
