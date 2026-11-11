#!/usr/bin/env python3
"""Mutation test for the Risk Guard v3 and v3.1 contracts.

    python3 contracts/mutation-test.py v31      # or: v3

For each deliberate bug below it copies the crate to a scratch directory, applies the bug to
src/lib.rs, runs `cargo test --locked`, and records which tests failed. A bug is CAUGHT if at least one
test fails and MISSED if every test still passes. The real source is never modified. The result is written
to contracts/<crate>/MUTATION_RESULTS.md; the "N/N bugs caught" claims in the docs come from that file.

Needs Rust 1.81 (the same toolchain CI uses). Takes a few minutes: one compile per bug.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
CRATES = {"v3": "risk-guard-v3", "v31": "risk-guard-v31"}

# Each mutation: (name, [(find, replace), ...]). Every `find` must match exactly once in src/lib.rs.
COMMON = [
    ("accept any digest the solver asserts", [('} else if digest_hex.is_empty() || *expected != digest_hex {', '} else if digest_hex.is_empty() {')]),
    ("sign the solver-supplied digest", [
        ("let limit_px_e8 = request.limit_px_e8;", "let limit_px_e8 = request.limit_px_e8;\n        let request_expected = request.expected_digest_hex.clone();"),
        ('} else if digest_hex.is_empty() || *expected != digest_hex {', '} else if digest_hex.is_empty() {'),
        ('"request": { "payload_v2": { "Ecdsa": eval.digest_hex }', '"request": { "payload_v2": { "Ecdsa": request_expected.clone().unwrap_or(eval.digest_hex.clone()) }'),
    ]),
    ("buy instead of sell", [("is_buy: false, px_e8: limit_px_e8", "is_buy: true, px_e8: limit_px_e8")]),
    ("reduce-only order", [("sz_e8: size_e8, reduce_only: false", "sz_e8: size_e8, reduce_only: true")]),
    ("size from the reference price instead of the limit", [("hl::size_lots(o.perp_short_usd_cents, p, m.sz_decimals)", "hl::size_lots(o.perp_short_usd_cents, r.max(1), m.sz_decimals)")]),
    ("no price band", [("if dev * 10_000 > (self.policy.price_band_bps as u128) * (r as u128) {", "if false {")]),
    ("no notional band", [("if drift * 10_000 > (self.policy.notional_band_bps as u128) * approved {", "if false {")]),
    ("no future-nonce check", [("if o.nonce > block_time_ms.saturating_add(self.policy.max_nonce_future_ms) {", "if false {")]),
    ("no stale-nonce check", [("if o.nonce < block_time_ms.saturating_sub(self.policy.max_nonce_age_ms) {", "if false {")]),
    ("nonce window in microseconds instead of milliseconds", [("let block_time_ms = env::block_timestamp() / 1_000_000;", "let block_time_ms = env::block_timestamp() / 1_000;")]),
    ("caller does not pay for storage (F-2)", [("let storage_cost = env::storage_byte_cost().saturating_mul(added as u128);", "let storage_cost = NearToken::from_yoctonear(0);")]),
    ("v = recovery_id + 28", [("v: sig.recovery_id + 27", "v: sig.recovery_id + 28")]),
    ("mainnet source on a testnet contract", [('hl::l1_digest(&conn, self.hl_network == "mainnet")', "hl::l1_digest(&conn, true)")]),
    ("unknown market falls back to the first market", [("let m = self.markets.iter().find(|m| m.symbol == o.asset_symbol).cloned();", "let m = self.markets.iter().find(|m| m.symbol == o.asset_symbol).cloned().or(self.markets.first().cloned());")]),
]

V3_ONLY = [
    ("digest not part of the commitment", [("o.nonce,\n        digest_hex\n    )", 'o.nonce,\n        ""\n    )')]),
]

V31_ONLY = [
    ("no per-order size cap", [("if e8 > m.max_order_size_e8 {", "if false {")]),
    ("no rolling-window size cap", [("if (window_used_size_e8 as u128) + (size_e8 as u128) > m.window_size_cap_e8 as u128 {", "if false {")]),
    ("no order-count cap", [("if window_order_count >= self.policy.max_orders_per_window {", "if false {")]),
    ("rolling window never forgets old orders", [("if a.timestamp_ns / 1_000_000 < window_start {", "if false {")]),
    ("no minimum order value", [("if (e8 as u128) * (p as u128) < MIN_ORDER_VALUE_USD * 10u128.pow(16) {", "if false {")]),
    ("minimum order value off by a factor of 100", [("MIN_ORDER_VALUE_USD * 10u128.pow(16)", "MIN_ORDER_VALUE_USD * 10u128.pow(14)")]),
    ("no EXPIRED check", [("if exp <= block_time_ms {", "if false {")]),
    ("no EXPIRY_TOO_FAR check", [("} else if exp > block_time_ms.saturating_add(self.policy.max_expiry_ms) {", "} else if false {")]),
    ("expiresAfter not hashed into the order", [("let conn = hl::connection_id(&packed, o.nonce, Some(exp));", "let conn = hl::connection_id(&packed, o.nonce, None);")]),
    ("expiry not part of the commitment", [("size_e8, exp, &digest_hex)", "size_e8, 0, &digest_hex)")]),
    ("digest not part of the commitment", [("expires_after_ms,\n        digest_hex\n    )", 'expires_after_ms,\n        ""\n    )')]),
    ("malformed MPC response leaves the attestation Pending", [("att.mpc_status = if hl_sig.is_some() { MpcStatus::Signed } else { MpcStatus::Failed };", "att.mpc_status = if hl_sig.is_some() { MpcStatus::Signed } else { MpcStatus::Pending };")]),
    ("malformed MPC response panics the callback", [(".ok()\n                .map(|r| MpcSignature", ".map(Some)\n                .unwrap()\n                .map(|r| MpcSignature")]),
]


def run(cmd, cwd, env):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "v31"
    if which not in CRATES:
        sys.exit(f"usage: mutation-test.py {'|'.join(CRATES)}")
    crate = ROOT / CRATES[which]
    mutations = COMMON + (V31_ONLY if which == "v31" else V3_ONLY)
    scratch = pathlib.Path(os.environ.get("MUTATION_SCRATCH", "/projects/sandbox/.scratch")) / f"mut-{which}"
    if scratch.exists():
        shutil.rmtree(scratch)
    shutil.copytree(crate, scratch, ignore=shutil.ignore_patterns("target", "res", "MUTATION_RESULTS.md"))
    env = dict(os.environ)
    # Override (not setdefault): some environments define their own RUSTUP_HOME without the 1.81 toolchain.
    env["CARGO_HOME"] = os.environ.get("MUTATION_CARGO_HOME", "/root/.cache/cargo") if os.path.isdir("/root/.cache/cargo") else env.get("CARGO_HOME", "")
    env["RUSTUP_HOME"] = os.environ.get("MUTATION_RUSTUP_HOME", "/root/.cache/rustup") if os.path.isdir("/root/.cache/rustup") else env.get("RUSTUP_HOME", "")
    env["CARGO_TARGET_DIR"] = os.environ.get("MUTATION_TARGET", f"/root/.cache/zd-mut-{which}")
    cargo = [os.environ.get("RUSTUP", "/root/.cargo/bin/rustup"), "run", "1.81.0", "cargo", "test", "--locked"]

    original = (crate / "src" / "lib.rs").read_text()
    baseline = run(cargo, scratch, env)
    if baseline.returncode != 0:
        sys.exit("baseline tests fail; refusing to mutate:\n" + baseline.stdout[-1500:] + baseline.stderr[-1500:])
    passed = sum(int(l.split()[3]) for l in baseline.stdout.splitlines() if l.startswith("test result: ok"))
    print(f"baseline: {passed} tests pass")

    rows = []
    for name, edits in mutations:
        src = original
        for find, repl in edits:
            if src.count(find) != 1:
                sys.exit(f"mutation '{name}': pattern matched {src.count(find)} times, expected 1:\n{find}")
            src = src.replace(find, repl)
        (scratch / "src" / "lib.rs").write_text(src)
        t0 = time.time()
        r = run(cargo, scratch, env)
        out = r.stdout + r.stderr
        failed = sorted({l.split()[1] for l in out.splitlines() if l.startswith("test ") and l.endswith("FAILED")})
        compile_error = r.returncode != 0 and not failed and "could not compile" in out
        status = "COMPILE ERROR" if compile_error else ("CAUGHT" if failed else "MISSED")
        rows.append({"bug": name, "status": status, "failing_tests": failed})
        print(f"{status:13} {name}  ({len(failed)} failing, {time.time() - t0:.0f}s)")
    (scratch / "src" / "lib.rs").write_text(original)

    caught = sum(r["status"] == "CAUGHT" for r in rows)
    lines = [
        f"# Mutation test results: {CRATES[which]}",
        "",
        f"Generated by `python3 contracts/mutation-test.py {which}` (Rust 1.81, `cargo test --locked`). Baseline: {passed} tests pass.",
        "Each row is one deliberate bug applied to a scratch copy of `src/lib.rs`; the real source is not modified.",
        "",
        f"**{caught} of {len(rows)} bugs caught** (at least one test fails).",
        "",
        "| Bug | Result | Failing tests (first 3) |",
        "|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| {r['bug']} | {r['status']} | {', '.join(f'`{t}`' for t in r['failing_tests'][:3]) or '-'} |")
    (crate / "MUTATION_RESULTS.md").write_text("\n".join(lines) + "\n")
    print(f"\n{caught}/{len(rows)} caught; wrote {crate / 'MUTATION_RESULTS.md'}")
    if caught != len(rows):
        sys.exit(1)


if __name__ == "__main__":
    main()
