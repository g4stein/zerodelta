#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Rust panic locations embed dependency paths. Preserve the historical build's
# registry prefix without requiring that directory to exist on the builder.
cargo_cache="${CARGO_HOME:-${HOME}/.cargo}"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${cargo_cache}=/root/.cache/cargo"
for version in risk-guard risk-guard-v3 risk-guard-v31; do
  case "$version" in
    risk-guard) binary=zerodelta_risk_guard ;;
    risk-guard-v3) binary=zerodelta_risk_guard_v3 ;;
    risk-guard-v31) binary=zerodelta_risk_guard_v31 ;;
  esac
  (
    cd "$repo_root/contracts/$version"
    cargo +1.81.0 build --locked --release --target wasm32-unknown-unknown
    cmp "target/wasm32-unknown-unknown/release/${binary}.wasm" "res/${binary}.wasm"
    sha256sum "res/${binary}.wasm"
  )
done
