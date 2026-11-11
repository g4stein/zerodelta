//! Adversarial and behavioural tests for Risk Guard v3.1.
//!
//! Every rejection is checked three ways: the panic reason, that no receipt to the MPC signer
//! was created, and that the nonce was not consumed. The approved path checks that the payload
//! sent to the MPC signer is the digest of the order the contract built, never solver input.

use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseOrValue, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};
use zerodelta_risk_guard_v31::hl::{self, OrderWire, Tif, E8};
use zerodelta_risk_guard_v31::{
    commitment_preimage, hl_signature_from_mpc, HedgeRequest, HlSignature, Market, MpcSignature, MpcStatus, OrderParams, Policy, RiskGuardV31,
    DEFAULT_MPC_SIGNER,
};

const NOW_MS: u64 = 1_794_405_483_425;
const MAX_AGE: u64 = 300_000;
const MAX_FUTURE: u64 = 60_000;
const MAX_EXPIRY: u64 = 3_600_000;
const WINDOW: u64 = 86_400_000;
/// A valid `expires_after_ms` for requests made at `NOW_MS`: 10 minutes ahead.
const EXP: u64 = NOW_MS + 600_000;

fn guard() -> AccountId {
    "zerodelta-guard-v3.testnet".parse().unwrap()
}
fn solver() -> AccountId {
    "zerodelta-solver-v3.testnet".parse().unwrap()
}
fn attacker() -> AccountId {
    "attacker.testnet".parse().unwrap()
}
fn mpc() -> AccountId {
    DEFAULT_MPC_SIGNER.parse().unwrap()
}

fn ctx_full(predecessor: AccountId, deposit: NearToken, gas_tgas: u64, block_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .block_timestamp(block_ms * 1_000_000)
        .account_balance(NearToken::from_near(10));
    testing_env!(b.build());
}
fn ctx(predecessor: AccountId, deposit: NearToken) {
    ctx_full(predecessor, deposit, 300, NOW_MS);
}
fn dep() -> NearToken {
    NearToken::from_millinear(50)
}

fn policy() -> Policy {
    Policy { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25, price_band_bps: 100, notional_band_bps: 50, max_nonce_age_ms: MAX_AGE, max_nonce_future_ms: MAX_FUTURE, max_expiry_ms: MAX_EXPIRY, window_ms: WINDOW, max_orders_per_window: 6 }
}

/// Hyperliquid TESTNET indices (fetched 2026-11-11). Mainnet would be BTC 0, ETH 1, SOL 5, NEAR 74.
fn testnet_markets() -> Vec<Market> {
    vec![
        Market { symbol: "BTC".into(), asset: 3, sz_decimals: 5, max_order_size_e8: 100000000, window_size_cap_e8: 200000000 },
        Market { symbol: "ETH".into(), asset: 4, sz_decimals: 4, max_order_size_e8: 4000000000, window_size_cap_e8: 8000000000 },
        Market { symbol: "SOL".into(), asset: 0, sz_decimals: 2, max_order_size_e8: 80000000000, window_size_cap_e8: 160000000000 },
        Market { symbol: "NEAR".into(), asset: 54, sz_decimals: 1, max_order_size_e8: 2000000000000, window_size_cap_e8: 4000000000000 },
    ]
}
fn mainnet_markets() -> Vec<Market> {
    vec![
        Market { symbol: "BTC".into(), asset: 0, sz_decimals: 5, max_order_size_e8: 100000000, window_size_cap_e8: 200000000 },
        Market { symbol: "ETH".into(), asset: 1, sz_decimals: 4, max_order_size_e8: 4000000000, window_size_cap_e8: 8000000000 },
        Market { symbol: "SOL".into(), asset: 5, sz_decimals: 2, max_order_size_e8: 80000000000, window_size_cap_e8: 160000000000 },
        Market { symbol: "NEAR".into(), asset: 74, sz_decimals: 1, max_order_size_e8: 2000000000000, window_size_cap_e8: 4000000000000 },
    ]
}

/// testing_env! carries storage over between calls; each contract starts from empty storage so
/// storage-usage measurements (F-2) see a fresh account.
fn fresh_chain() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard()).predecessor_account_id(guard()).block_timestamp(NOW_MS * 1_000_000).account_balance(NearToken::from_near(10));
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        std::collections::HashMap::new(),
        std::collections::HashMap::new(),
        None,
    ));
}

fn new_contract(network: &str, markets: Vec<Market>) -> RiskGuardV31 {
    fresh_chain();
    RiskGuardV31::new(solver(), policy(), network.into(), markets, "2026-11-11T13:58:03Z".into(), None, None, None)
}
fn contract() -> RiskGuardV31 {
    new_contract("testnet", testnet_markets())
}

/// $10,000 treasury, $6,655.51 spot long + $6,655.51 BTC perp short: 0% delta, 1.34x.
fn order(nonce: u64) -> OrderParams {
    OrderParams {
        asset_symbol: "BTC".into(),
        treasury_usd_cents: 1_000_000,
        spot_long_usd_cents: 665_551,
        perp_short_usd_cents: 665_551,
        perp_long_usd_cents: 0,
        collateral_usd_cents: 1_000_000,
        quoted_slippage_bps: 2,
        nonce,
    }
}
const LIMIT: u64 = 74_000 * E8;
const REF: u64 = 74_363 * E8;

fn req_px(o: OrderParams, limit: u64, reference: u64) -> HedgeRequest {
    HedgeRequest {
        run_id: "run".into(),
        order: o,
        limit_px_e8: limit,
        reference_px_e8: reference,
        expires_after_ms: EXP,
        expected_digest_hex: None,
        plan_hash: "a".repeat(64),
        intent_payload_hash: "b".repeat(64),
        attestation_report_hash: "c".repeat(64),
        decision_hash: "d".repeat(64),
    }
}
fn req(o: OrderParams) -> HedgeRequest {
    req_px(o, LIMIT, REF)
}

/// Size the contract should derive: floor($6,655.51 / 74,000) in 1e-5 BTC lots = 0.08993 BTC.
const SIZE_E8: u64 = 8_993_000;

fn honest_order(asset: u32) -> OrderWire {
    OrderWire { asset, is_buy: false, px_e8: LIMIT, sz_e8: SIZE_E8, reduce_only: false, tif: Tif::Ioc }
}
fn honest_digest(nonce: u64) -> String {
    hl::hex(&hl::order_digest(&[honest_order(3)], nonce, Some(EXP), false))
}

fn mpc_receipts() -> Vec<(String, Value, NearToken)> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id == mpc())
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                Some((String::from_utf8(method_name).unwrap(), serde_json::from_slice(&args).unwrap(), attached_deposit))
            }
            _ => None,
        })
        .collect()
}
fn transfers_to(who: &AccountId) -> Vec<NearToken> {
    get_created_receipts()
        .into_iter()
        .filter(|r| &r.receiver_id == who)
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit),
            _ => None,
        })
        .collect()
}

/// The mocked VM wraps contract panics as `... HostError(GuestPanic { panic_msg: "<msg>" })`.
fn panic_msg(e: Box<dyn std::any::Any + Send>) -> String {
    let raw = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    match raw.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.rsplit_once("\" })").map(|(m, _)| m).unwrap_or(rest).replace("\\\"", "\""),
        None => raw,
    }
}

/// Runs a sign request that must be rejected; returns the reason and checks nothing was signed or consumed.
fn rejected(c: &mut RiskGuardV31, r: HedgeRequest, sign: bool) -> String {
    let last = c.get_last_nonce();
    let count = c.get_attestation_count();
    let res = catch_unwind(AssertUnwindSafe(|| {
        let _ = c.sign_executable_hedge(r, Some(sign));
    }));
    let msg = panic_msg(res.expect_err("request must be rejected"));
    assert!(msg.starts_with("ZERODELTA_REJECTED: "), "{}", msg);
    assert!(mpc_receipts().is_empty(), "a rejected request created an MPC receipt: {}", msg);
    // In a real receipt the panic reverts all state; nothing can have been committed before the panic either.
    if !msg.contains("INSUFFICIENT_DEPOSIT") && !msg.contains("INSUFFICIENT_GAS") {
        assert_eq!(c.get_last_nonce(), last, "nonce consumed by a rejected request");
        assert_eq!(c.get_attestation_count(), count);
    }
    msg
}
fn reject_sign(r: HedgeRequest) -> String {
    let mut c = contract();
    ctx(solver(), dep());
    rejected(&mut c, r, true)
}

// ===========================================================================
// Approved path
// ===========================================================================

#[test]
fn approved_request_has_the_mpc_sign_the_digest_of_the_order_the_contract_built() {
    let mut c = contract();
    ctx(solver(), dep());
    let nonce = NOW_MS - 1_000;
    match c.sign_executable_hedge(req(order(nonce)), Some(true)) {
        PromiseOrValue::Promise(_) => {}
        _ => panic!("expected the MPC promise"),
    }
    let calls = mpc_receipts();
    assert_eq!(calls.len(), 1);
    let (method, args, deposit) = &calls[0];
    assert_eq!(method, "sign");
    assert_eq!(args["request"]["payload_v2"]["Ecdsa"], Value::String(honest_digest(nonce)));
    assert_eq!(args["request"]["path"], "zerodelta/hedge/hyperliquid");
    assert_eq!(args["request"]["domain_id"], 0);
    assert_eq!(*deposit, NearToken::from_yoctonear(1));

    let att = c.get_attestation(0).unwrap();
    assert_eq!(att.mpc_status, MpcStatus::Pending);
    assert_eq!(att.digest_hex, honest_digest(nonce));
    assert_eq!(att.action_json, hl::order_action_json(&[honest_order(3)]));
    assert_eq!(att.action_json, r#"{"type":"order","orders":[{"a":3,"b":false,"p":"74000","s":"0.08993","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"}"#);
    assert_eq!(att.size_e8, SIZE_E8);
    assert_eq!(att.connection_id_hex, hl::hex(&hl::connection_id(&hl::to_msgpack(&hl::order_action(&[honest_order(3)])), nonce, Some(EXP))));
    let pre = commitment_preimage(guard().as_str(), "testnet", &att.order, &att.market, LIMIT, REF, SIZE_E8, EXP, &att.digest_hex);
    assert!(pre.ends_with(&format!("|{}|{}|{}", nonce, EXP, att.digest_hex)), "commitment binds nonce, expiry and digest: {}", pre);
    assert_eq!(att.commitment_hex, hl::hex(&near_sdk::env::keccak256(pre.as_bytes())));
    assert_eq!(c.get_last_nonce(), nonce);
    assert!(get_logs().iter().any(|l| l.contains("mpc_sign_requested") && l.contains(&honest_digest(nonce))));
    // excess deposit refunded to the solver
    let refunds = transfers_to(&solver());
    assert_eq!(refunds.len(), 1);
    assert!(refunds[0] < dep() && refunds[0] > NearToken::from_millinear(30));
}

#[test]
fn preview_matches_the_signing_path_and_never_mutates() {
    let mut c = contract();
    ctx(solver(), dep());
    let nonce = NOW_MS - 1;
    let e = c.preview_executable_hedge(req(order(nonce)));
    assert!(e.approved, "{:?}", e.violations);
    assert_eq!(c.get_last_nonce(), 0);
    let _ = c.sign_executable_hedge(req(order(nonce)), Some(true));
    let att = c.get_attestation(0).unwrap();
    assert_eq!((e.digest_hex, e.commitment_hex, e.action_json), (att.digest_hex, att.commitment_hex, att.action_json));
}

#[test]
fn the_built_action_is_always_one_ioc_sell_on_the_table_market_for_many_inputs() {
    let c = contract();
    let markets = testnet_markets();
    let mut checked = 0;
    for (k, m) in markets.iter().enumerate() {
        for (i, (short, px)) in [(100_000u64, 1u64), (665_551, 7), (3_327_335, 13), (6_000_000, 29), (7_000_000, 31)].iter().enumerate() {
            let reference = match m.symbol.as_str() {
                "BTC" => 74_363 * E8,
                "ETH" => 197_560_000_000,
                "SOL" => 9_270_400_000,
                _ => 374_980_000,
            };
            // a price a few bps under the reference, rounded to a valid tick (5 sig figs)
            let raw = reference - reference / 10_000 * px;
            let step = 10u64.pow(hl::sig_figs_e8(raw).saturating_sub(5) + (8 - hl::decimals_e8(raw).min(8)));
            let limit = raw / step * step;
            let mut o = order(NOW_MS - 10 - (k * 10 + i) as u64);
            o.asset_symbol = m.symbol.clone();
            o.spot_long_usd_cents = *short;
            o.perp_short_usd_cents = *short;
            o.treasury_usd_cents = short * 5 / 3 + 1;
            o.collateral_usd_cents = o.treasury_usd_cents;
            let e = c.preview_executable_hedge(req_px(o, limit, reference));
            assert!(e.approved, "{} {} {:?}", m.symbol, hl::wire_e8(limit), e.violations);
            let a: Value = serde_json::from_str(&e.action_json).unwrap();
            assert_eq!(a["type"], "order");
            assert_eq!(a["grouping"], "na");
            let orders = a["orders"].as_array().unwrap();
            assert_eq!(orders.len(), 1);
            assert_eq!(orders[0]["a"], m.asset);
            assert_eq!(orders[0]["b"], false);
            assert_eq!(orders[0]["r"], false);
            assert_eq!(orders[0]["t"]["limit"]["tif"], "Ioc");
            assert_eq!(orders[0]["p"], hl::wire_e8(limit));
            checked += 1;
        }
    }
    assert_eq!(checked, 20);
}

#[test]
fn testnet_contract_uses_testnet_indices_and_mainnet_contract_uses_mainnet_ones() {
    let t = contract();
    let e = t.preview_executable_hedge(req(order(NOW_MS)));
    assert!(e.action_json.contains("\"a\":3,"), "{}", e.action_json);
    let m = new_contract("mainnet", mainnet_markets());
    let e2 = m.preview_executable_hedge(req(order(NOW_MS)));
    assert!(e2.action_json.contains("\"a\":0,"), "{}", e2.action_json);
    assert_ne!(e.digest_hex, e2.digest_hex);
    assert_eq!(e2.digest_hex, hl::hex(&hl::order_digest(&[honest_order(0)], NOW_MS, Some(EXP), true)));
}

#[test]
fn record_without_mpc_keeps_v2_record_semantics_and_refunds_excess() {
    let mut c = contract();
    ctx(solver(), dep());
    match c.sign_executable_hedge(req(order(NOW_MS - 5)), None) {
        PromiseOrValue::Value(0) => {}
        _ => panic!("expected index 0 without MPC"),
    }
    assert!(mpc_receipts().is_empty());
    assert_eq!(c.get_attestation(0).unwrap().mpc_status, MpcStatus::NotRequested);
    assert_eq!(transfers_to(&solver()).len(), 1);
}

// ===========================================================================
// The contract never signs a supplied digest
// ===========================================================================

#[test]
fn honest_expected_digest_is_accepted() {
    let mut c = contract();
    ctx(solver(), dep());
    let nonce = NOW_MS - 3;
    let mut r = req(order(nonce));
    r.expected_digest_hex = Some(honest_digest(nonce));
    let _ = c.sign_executable_hedge(r, Some(true));
    assert_eq!(mpc_receipts()[0].1["request"]["payload_v2"]["Ecdsa"], Value::String(honest_digest(nonce)));
}

fn tampered(nonce: u64, f: impl Fn(&mut Vec<OrderWire>), mainnet: bool) -> String {
    let mut orders = vec![honest_order(3)];
    f(&mut orders);
    hl::hex(&hl::order_digest(&orders, nonce, Some(EXP), mainnet))
}

#[test]
fn every_tampered_action_digest_is_rejected() {
    let n = NOW_MS - 2;
    let cases: Vec<(&str, String)> = vec![
        ("wrong market (mainnet BTC index on testnet)", tampered(n, |o| o[0].asset = 0, false)),
        ("wrong market (ETH)", tampered(n, |o| o[0].asset = 4, false)),
        ("wrong side (buy)", tampered(n, |o| o[0].is_buy = true, false)),
        ("reduce-only", tampered(n, |o| o[0].reduce_only = true, false)),
        ("extra order", tampered(n, |o| o.push(o[0].clone()), false)),
        ("wrong TIF Gtc", tampered(n, |o| o[0].tif = Tif::Gtc, false)),
        ("wrong TIF Alo", tampered(n, |o| o[0].tif = Tif::Alo, false)),
        ("10x size", tampered(n, |o| o[0].sz_e8 *= 10, false)),
        ("different limit price", tampered(n, |o| o[0].px_e8 = 60_000 * E8, false)),
        ("mainnet source", tampered(n, |_| {}, true)),
        ("different nonce", tampered(n + 1, |_| {}, false)),
        ("random digest", "ab".repeat(32)),
    ];
    for (why, digest) in cases {
        assert_ne!(digest, honest_digest(n), "{}", why);
        let mut r = req(order(n));
        r.expected_digest_hex = Some(digest.clone());
        let msg = reject_sign(r);
        assert!(msg.contains("PAYLOAD_COMMITMENT_MISMATCH"), "{}: {}", why, msg);
        assert!(msg.contains(&honest_digest(n)) && msg.contains(&digest), "{}: {}", why, msg);
    }
}

#[test]
fn malformed_expected_digest_is_rejected() {
    for bad in ["ABCD".repeat(16), "ab".repeat(31), format!("0x{}", "ab".repeat(31)), String::new()] {
        let mut r = req(order(NOW_MS));
        r.expected_digest_hex = Some(bad.clone());
        assert!(reject_sign(r).contains("MALFORMED_HASH: expected_digest_hex"), "{}", bad);
    }
}

#[test]
fn malformed_attestation_hashes_are_rejected() {
    let mut r = req(order(NOW_MS));
    r.plan_hash = "A".repeat(64);
    assert!(reject_sign(r).contains("MALFORMED_HASH: plan_hash"));
    let mut r = req(order(NOW_MS));
    r.decision_hash = "d".repeat(63);
    assert!(reject_sign(r).contains("MALFORMED_HASH: decision_hash"));
}

// ===========================================================================
// Market, price, size
// ===========================================================================

#[test]
fn unknown_and_invalid_symbols_are_rejected() {
    let mut o = order(NOW_MS);
    o.asset_symbol = "DOGE".into();
    assert!(reject_sign(req(o)).contains("UNKNOWN_MARKET: DOGE is not in the testnet market table"));
    let mut o = order(NOW_MS);
    o.asset_symbol = "btc".into();
    assert!(reject_sign(req(o)).contains("INVALID_ORDER: asset_symbol"));
}

#[test]
fn price_out_of_band_is_rejected_and_the_band_edge_is_inclusive() {
    // 72,000 vs 74,363 is 318 bps
    assert!(reject_sign(req_px(order(NOW_MS), 72_000 * E8, REF)).contains("PRICE_OUT_OF_BAND: limit 72000 is 318 bps"));
    // above the reference too
    assert!(reject_sign(req_px(order(NOW_MS), 76_000 * E8, REF)).contains("PRICE_OUT_OF_BAND"));
    let c = contract();
    // exactly 100 bps: 73,260 vs 74,000
    assert!(c.preview_executable_hedge(req_px(order(NOW_MS), 73_260 * E8, 74_000 * E8)).approved);
    assert!(!c.preview_executable_hedge(req_px(order(NOW_MS), 73_259 * E8, 74_000 * E8)).approved);
}

#[test]
fn hyperliquid_price_rules_are_enforced() {
    // BTC szDecimals 5: 6 significant figures
    assert!(reject_sign(req_px(order(NOW_MS), 7_442_350_000_000, 74_423 * E8)).contains("PRICE_TOO_MANY_SIG_FIGS: 74423.5"));
    // BTC: 2 decimals > 1
    assert!(reject_sign(req_px(order(NOW_MS), 736_193_700_000, 74_000 * E8)).contains("PRICE_TOO_MANY_DECIMALS"));
    assert!(reject_sign(req_px(order(NOW_MS), 0, REF)).contains("PRICE_ZERO"));
    assert!(reject_sign(req_px(order(NOW_MS), LIMIT, 0)).contains("NO_REFERENCE_PRICE"));
}

#[test]
fn notional_drift_and_zero_size_are_rejected() {
    // $1.00 at 74,000 = 1.35 lots -> 1 lot = $0.74: 26% drift
    let mut o = order(NOW_MS);
    o.perp_short_usd_cents = 100;
    o.spot_long_usd_cents = 100;
    assert!(reject_sign(req(o)).contains("NOTIONAL_DRIFT: size x limit is 2600 bps"));
    let mut o = order(NOW_MS);
    o.perp_short_usd_cents = 1;
    o.spot_long_usd_cents = 1;
    assert!(reject_sign(req(o)).contains("SIZE_ZERO"));
}

#[test]
fn size_follows_the_limit_price_not_the_reference() {
    let c = contract();
    let a = c.preview_executable_hedge(req_px(order(NOW_MS), 74_000 * E8, 74_363 * E8));
    let b = c.preview_executable_hedge(req_px(order(NOW_MS), 74_000 * E8, 74_500 * E8));
    assert_eq!(a.size_e8, b.size_e8, "the reference only anchors the band");
    let lower = c.preview_executable_hedge(req_px(order(NOW_MS), 73_700 * E8, 74_363 * E8));
    assert!(lower.size_e8 > a.size_e8, "a lower limit buys more lots for the same notional");
    // one BTC lot (1e-5) at ~74,000 is ~$0.74, i.e. ~1.04 bps of $6,655.51, rounded up
    assert!(a.notional_drift_bps <= 2 && lower.notional_drift_bps <= 2, "{} {}", a.notional_drift_bps, lower.notional_drift_bps);
}

// ===========================================================================
// Nonce (Hyperliquid ms timestamps)
// ===========================================================================

#[test]
fn replayed_and_older_nonces_are_rejected() {
    let mut c = contract();
    ctx(solver(), dep());
    let n = NOW_MS - 100;
    let _ = c.sign_executable_hedge(req(order(n)), Some(true));
    ctx(solver(), dep());
    assert!(rejected(&mut c, req(order(n)), true).contains(&format!("NONCE_ALREADY_USED: nonce {} <= last accepted {}", n, n)));
    assert!(rejected(&mut c, req(order(n - 1)), true).contains("NONCE_ALREADY_USED"));
    assert_eq!(c.get_attestation_count(), 1);
}

#[test]
fn stale_and_future_nonces_are_rejected_with_inclusive_window_edges() {
    assert!(reject_sign(req(order(NOW_MS - MAX_AGE - 1))).contains("STALE_ORDER"));
    assert!(reject_sign(req(order(NOW_MS + MAX_FUTURE + 1))).contains("FUTURE_NONCE"));
    // v2-style microsecond nonce is far in the future in ms terms
    assert!(reject_sign(req(order(NOW_MS * 1_000))).contains("FUTURE_NONCE"));
    let c = contract();
    assert!(c.preview_executable_hedge(req(order(NOW_MS - MAX_AGE))).approved);
    assert!(c.preview_executable_hedge(req(order(NOW_MS + MAX_FUTURE))).approved);
}

#[test]
fn u64_max_nonce_cannot_freeze_the_contract_f1() {
    let mut c = contract();
    ctx(solver(), dep());
    assert!(rejected(&mut c, req(order(u64::MAX)), true).contains("FUTURE_NONCE"));
    ctx(solver(), dep());
    let _ = c.sign_executable_hedge(req(order(NOW_MS)), Some(true));
    assert_eq!(c.get_last_nonce(), NOW_MS);
}

#[test]
fn nonce_freshness_uses_block_time_in_ms() {
    let c = contract();
    // a block 10 minutes later makes the same nonce stale
    ctx_full(solver(), dep(), 300, NOW_MS + 600_000);
    let e = c.preview_executable_hedge(req(order(NOW_MS)));
    assert_eq!(e.block_time_ms, NOW_MS + 600_000);
    assert!(e.violations.iter().any(|v| v.starts_with("STALE_ORDER")));
}

// ===========================================================================
// Caller, risk math, extremes
// ===========================================================================

#[test]
fn unauthorized_callers_are_rejected() {
    let mut c = contract();
    ctx(attacker(), dep());
    assert!(rejected(&mut c, req(order(NOW_MS)), true).contains("UNAUTHORIZED_SOLVER: attacker.testnet"));
    ctx(guard(), dep());
    assert!(rejected(&mut c, req(order(NOW_MS)), true).contains("UNAUTHORIZED_SOLVER"));
}

#[test]
fn risk_math_is_recomputed_like_v2() {
    // rogue: 100% spot + 9x perp long, no hedge
    let mut o = order(NOW_MS);
    o.spot_long_usd_cents = 1_000_000;
    o.perp_short_usd_cents = 0;
    o.perp_long_usd_cents = 9_000_000;
    let m = reject_sign(req(o));
    for want in ["DELTA_NEUTRALITY: 100000 bps > 200 bps", "LEVERAGE_CEILING: 1000 > 300 (x100)", "INVALID_ORDER: perp_short_usd_cents must be > 0", "INVALID_ORDER: a perp long leg"] {
        assert!(m.contains(want), "{} in {}", want, m);
    }
    // mis-hedged: 52/48
    let mut o = order(NOW_MS);
    o.spot_long_usd_cents = 520_000;
    o.perp_short_usd_cents = 480_000;
    assert!(reject_sign(req(o)).contains("DELTA_NEUTRALITY: 400 bps > 200 bps"));
    let mut o = order(NOW_MS);
    o.quoted_slippage_bps = 26;
    assert!(reject_sign(req(o)).contains("SLIPPAGE_CEILING: 26 bps > 25 bps"));
    let mut o = order(NOW_MS);
    o.collateral_usd_cents = 2_000_000;
    assert!(reject_sign(req(o)).contains("INVALID_ORDER: collateral exceeds treasury"));
    let mut o = order(NOW_MS);
    o.treasury_usd_cents = 0;
    o.collateral_usd_cents = 0;
    assert!(reject_sign(req(o)).contains("INVALID_ORDER: treasury_usd_cents must be > 0"));
}

#[test]
fn u64_extremes_are_rejected_without_overflow() {
    let mut o = order(NOW_MS);
    o.treasury_usd_cents = u64::MAX;
    o.collateral_usd_cents = u64::MAX;
    o.spot_long_usd_cents = u64::MAX;
    o.perp_short_usd_cents = u64::MAX;
    // huge but balanced legs at a price of 1: size overflows u64 and is refused
    let m = reject_sign(req_px(o.clone(), E8, E8));
    assert!(m.contains("SIZE_OVERFLOW"), "{}", m);
    // extreme prices
    assert!(reject_sign(req_px(order(NOW_MS), u64::MAX, REF)).contains("PRICE_OUT_OF_BAND"));
    assert!(reject_sign(req_px(order(NOW_MS), LIMIT, u64::MAX)).contains("PRICE_OUT_OF_BAND"));
    let mut o = order(NOW_MS);
    o.spot_long_usd_cents = u64::MAX;
    let m = reject_sign(req(o));
    assert!(m.contains("DELTA_NEUTRALITY") && m.contains("LEVERAGE_CEILING"), "{}", m);
    let mut o = order(NOW_MS);
    o.quoted_slippage_bps = u32::MAX;
    assert!(reject_sign(req(o)).contains("SLIPPAGE_CEILING"));
}

// ===========================================================================
// Deposits (F-2) and gas
// ===========================================================================

#[test]
fn the_caller_pays_storage_and_the_exact_required_deposit_is_accepted_f2() {
    // find the required deposit from the refund of an over-funded request
    let mut c = contract();
    ctx(solver(), dep());
    let _ = c.sign_executable_hedge(req(order(NOW_MS)), Some(true));
    let refund = transfers_to(&solver())[0];
    let required = dep().saturating_sub(refund);
    // required = (attestation bytes + 384-byte signature allowance) x storage byte cost + 1 yocto MPC deposit
    let log = get_logs().into_iter().find(|l| l.contains("hedge_attested")).unwrap();
    let bytes: u128 = log.split("\"storage_bytes\":").nth(1).unwrap().split(',').next().unwrap().parse().unwrap();
    assert!(bytes > 384 + 500, "attestation + allowance is {} bytes", bytes);
    assert_eq!(required.as_yoctonear(), bytes * near_sdk::env::storage_byte_cost().as_yoctonear() + 1);

    let mut c = contract();
    ctx(solver(), required);
    let _ = c.sign_executable_hedge(req(order(NOW_MS)), Some(true));
    assert!(transfers_to(&solver()).is_empty(), "no refund when the exact amount is attached");
    assert_eq!(mpc_receipts().len(), 1);

    let mut c = contract();
    ctx(solver(), required.saturating_sub(NearToken::from_yoctonear(1)));
    assert!(rejected(&mut c, req(order(NOW_MS)), true).contains("INSUFFICIENT_DEPOSIT"));
    // storage is charged even without an MPC request
    let mut c = contract();
    ctx(solver(), NearToken::from_yoctonear(0));
    assert!(rejected(&mut c, req(order(NOW_MS)), false).contains("INSUFFICIENT_DEPOSIT"));
}

#[test]
fn insufficient_gas_is_rejected() {
    let mut c = contract();
    ctx_full(solver(), dep(), 100, NOW_MS);
    assert!(rejected(&mut c, req(order(NOW_MS)), true).contains("INSUFFICIENT_GAS"));
}

// ===========================================================================
// MPC callback
// ===========================================================================

/// What the MPC contract's `sign` returns on success, as JSON bytes.
fn raw_json(big_r: &str, s: &str, rid: u8) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "big_r": { "affine_point": big_r }, "s": { "scalar": s }, "recovery_id": rid })).unwrap()
}

/// Delivers a promise result to `on_mpc_signed(0)` the way the runtime does for a callback.
fn deliver(c: &mut RiskGuardV31, result: PromiseResult) -> Option<HlSignature> {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard()).predecessor_account_id(guard()).block_timestamp(NOW_MS * 1_000_000).account_balance(NearToken::from_near(10));
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), std::collections::HashMap::default(), vec![result]);
    c.on_mpc_signed(0)
}

fn pending_contract() -> RiskGuardV31 {
    let mut c = contract();
    ctx(solver(), dep());
    let _ = c.sign_executable_hedge(req(order(NOW_MS)), Some(true));
    assert_eq!(c.get_attestation(0).unwrap().mpc_status, MpcStatus::Pending);
    c
}

#[test]
fn callback_stores_the_hyperliquid_signature_with_v_equal_recovery_id_plus_27() {
    for rid in [0u8, 1] {
        let mut c = pending_contract();
        let big_r = format!("03{}", "1f".repeat(32));
        let s = "2e".repeat(32);
        let sig = deliver(&mut c, PromiseResult::Successful(raw_json(&big_r, &s, rid))).unwrap();
        assert_eq!(sig.r, format!("0x{}", "1f".repeat(32)));
        assert_eq!(sig.s, format!("0x{}", s));
        assert_eq!(sig.v, 27 + rid);
        let att = c.get_attestation(0).unwrap();
        assert_eq!(att.mpc_status, MpcStatus::Signed);
        assert_eq!(att.hl_signature, Some(sig));
        assert_eq!(att.mpc_signature.unwrap().big_r, big_r);
    }
}

#[test]
fn every_failed_or_malformed_mpc_response_marks_the_attestation_failed_never_pending() {
    let good_r = format!("03{}", "1f".repeat(32));
    let good_s = "2e".repeat(32);
    let cases: Vec<(&str, PromiseResult)> = vec![
        ("promise failed", PromiseResult::Failed),
        ("empty bytes", PromiseResult::Successful(vec![])),
        ("not json", PromiseResult::Successful(b"not json".to_vec())),
        ("json of the wrong shape", PromiseResult::Successful(br#"{"hello":"world"}"#.to_vec())),
        ("signature as a plain string", PromiseResult::Successful(br#""0xabcdef""#.to_vec())),
        ("null", PromiseResult::Successful(b"null".to_vec())),
        ("recovery_id as a string", PromiseResult::Successful(br#"{"big_r":{"affine_point":"03aa"},"s":{"scalar":"bb"},"recovery_id":"1"}"#.to_vec())),
        ("big_r missing", PromiseResult::Successful(br#"{"s":{"scalar":"bb"},"recovery_id":1}"#.to_vec())),
        ("uncompressed point prefix 04", PromiseResult::Successful(raw_json("04aa", &good_s, 0))),
        ("s not hex", PromiseResult::Successful(raw_json(&good_r, "zz", 0))),
        ("recovery_id 2", PromiseResult::Successful(raw_json(&good_r, &good_s, 2))),
        ("recovery_id 255", PromiseResult::Successful(raw_json(&good_r, &good_s, 255))),
        ("big_r too short", PromiseResult::Successful(raw_json("03aa", &good_s, 0))),
        ("huge garbage", PromiseResult::Successful(vec![0xff; 4096])),
    ];
    for (why, result) in cases {
        let mut c = pending_contract();
        assert!(deliver(&mut c, result).is_none(), "{}", why);
        let att = c.get_attestation(0).unwrap();
        assert_eq!(att.mpc_status, MpcStatus::Failed, "{}", why);
        assert!(att.hl_signature.is_none() && att.mpc_signature.is_none(), "{}", why);
        assert!(get_logs().iter().any(|l| l.contains("mpc_signed") && l.contains("\"ok\":false")), "{}", why);
    }
}

#[test]
fn hl_signature_conversion_rejects_bad_shapes() {
    let ok = MpcSignature { big_r: format!("02{}", "0a".repeat(32)), s: "0b".repeat(32), recovery_id: 0 };
    assert_eq!(hl_signature_from_mpc(&ok).unwrap().v, 27);
    let mut bad = ok.clone();
    bad.big_r = format!("05{}", "0a".repeat(32));
    assert!(hl_signature_from_mpc(&bad).is_none());
}

// `on_mpc_signed` is `#[private]`. near-sdk enforces that in the generated wasm entry point, which
// unit tests bypass, so it is checked against the deployed contract instead (CP3).

// ===========================================================================
// Deploy-time configuration
// ===========================================================================

fn init_err(f: impl FnOnce() -> RiskGuardV31) -> String {
    ctx(guard(), NearToken::from_yoctonear(0));
    panic_msg(catch_unwind(AssertUnwindSafe(f)).err().expect("init must fail"))
}

#[test]
fn bad_configuration_is_refused_at_deploy() {
    let mk = |net: &str, markets: Vec<Market>, p: Policy, dep: Option<U128>| {
        let net = net.to_string();
        move || RiskGuardV31::new(solver(), p, net, markets, "2026-11-11".into(), None, None, dep)
    };
    let mut dup = testnet_markets();
    dup.push(Market { symbol: "BTC".into(), asset: 99, sz_decimals: 5, max_order_size_e8: 1, window_size_cap_e8: 1 });
    assert!(init_err(mk("testnet", dup, policy(), None)).contains("duplicate market"));
    let mut dup_asset = testnet_markets();
    dup_asset.push(Market { symbol: "DOGE".into(), asset: 3, sz_decimals: 0, max_order_size_e8: 1, window_size_cap_e8: 1 });
    assert!(init_err(mk("testnet", dup_asset, policy(), None)).contains("duplicate market"));
    assert!(init_err(mk("testnet", vec![Market { symbol: "BTC".into(), asset: 3, sz_decimals: 7, max_order_size_e8: 1, window_size_cap_e8: 1 }], policy(), None)).contains("sz_decimals"));
    assert!(init_err(mk("devnet", testnet_markets(), policy(), None)).contains("hl_network"));
    assert!(init_err(mk("testnet", vec![], policy(), None)).contains("markets must have"));
    assert!(init_err(mk("testnet", testnet_markets(), policy(), Some(U128(0)))).contains("mpc_deposit"));
    let mut p = policy();
    p.price_band_bps = 0;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("price_band_bps"));
    let mut p = policy();
    p.max_nonce_age_ms = 0;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("nonce windows"));
    for bad in [
        Market { symbol: "BTC".into(), asset: 3, sz_decimals: 5, max_order_size_e8: 0, window_size_cap_e8: 1 },
        Market { symbol: "BTC".into(), asset: 3, sz_decimals: 5, max_order_size_e8: 5, window_size_cap_e8: 4 },
    ] {
        assert!(init_err(mk("testnet", vec![bad], policy(), None)).contains("size caps"));
    }
    let mut p = policy();
    p.max_expiry_ms = 0;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("max_expiry_ms"));
    let mut p = policy();
    p.max_expiry_ms = 2 * 86_400_000;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("max_expiry_ms"));
    let mut p = policy();
    p.window_ms = 1_000;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("window_ms"));
    let mut p = policy();
    p.max_orders_per_window = 0;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("max_orders_per_window"));
    let mut p = policy();
    p.max_orders_per_window = 51;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("max_orders_per_window"));
    let mut p = policy();
    p.max_leverage_x100 = 99;
    assert!(init_err(mk("testnet", testnet_markets(), p, None)).contains("max_leverage_x100"));
}

#[test]
fn config_exposes_the_immutable_policy_markets_and_mpc_target() {
    let c = contract();
    let cfg = c.get_config();
    assert_eq!(cfg.policy, policy());
    assert_eq!(cfg.hl_network, "testnet");
    assert_eq!(cfg.markets, testnet_markets());
    assert_eq!(cfg.markets_fetched_at, "2026-11-11T13:58:03Z");
    assert_eq!(cfg.mpc_signer_contract, mpc());
    assert_eq!(cfg.mpc_deposit, U128(1));
    assert_eq!(cfg.version, "3.1.0");
}

// ===========================================================================
// v3.1: price-independent size caps, rolling window, expiry, minimum order value
// ===========================================================================

fn sol_order(nonce: u64, short_cents: u64) -> OrderParams {
    OrderParams {
        asset_symbol: "SOL".into(),
        treasury_usd_cents: short_cents * 2,
        spot_long_usd_cents: short_cents,
        perp_short_usd_cents: short_cents,
        perp_long_usd_cents: 0,
        collateral_usd_cents: short_cents * 2,
        quoted_slippage_bps: 2,
        nonce,
    }
}
const SOL_REF: u64 = 9_242_400_000; // 92.424
const SOL_LIMIT: u64 = 9_196_100_000; // 91.961

#[test]
fn the_audit_attack_is_bounded_by_the_coin_caps_whatever_prices_the_solver_claims() {
    // v3 let limit = reference = a tiny price turn a $33k hedge into a multi-million-dollar sell.
    // Here every such request is either refused (ORDER_SIZE_CAP) or at most the per-order cap.
    let c = contract();
    let cap = 80_000_000_000u64; // 800 SOL
    let mut refused = 0;
    let mut accepted_max = 0u64;
    let mut px = 100.0f64;
    while px > 0.0001 {
        // a valid tick: 4 decimals for SOL (szDecimals 2)
        let e8 = ((px * 1e4).round() as u64) * 10_000;
        if e8 > 0 {
            let e = c.preview_executable_hedge(req_px(sol_order(NOW_MS, 3_327_581), e8, e8));
            if e.violations.iter().any(|v| v.starts_with("ORDER_SIZE_CAP")) {
                refused += 1;
                assert!(!e.approved);
            } else if e.approved {
                assert!(e.size_e8 <= cap, "approved size {} above the cap at price {}", e.size_e8, px);
                accepted_max = accepted_max.max(e.size_e8);
            }
        }
        px *= 0.8;
    }
    assert!(refused > 10, "tiny prices must be refused, got {}", refused);
    assert!(accepted_max > 36_000_000_000 && accepted_max <= cap, "the legit ~362 SOL order must remain possible: {}", accepted_max);
}

#[test]
fn legitimate_hedge_passes_and_the_exact_cap_edge_is_inclusive() {
    let c = contract();
    // ~362 SOL at 91.961 for $33,275.81: well under the 800 SOL cap
    let ok = c.preview_executable_hedge(req_px(sol_order(NOW_MS, 3_327_581), SOL_LIMIT, SOL_REF));
    assert!(ok.approved, "{:?}", ok.violations);
    assert!(ok.size_e8 < 40_000_000_000);
    // exactly 800.00 SOL: 800 * 91.961 = 73,568.8 USD
    let edge = c.preview_executable_hedge(req_px(sol_order(NOW_MS, 7_356_880), SOL_LIMIT, SOL_REF));
    assert_eq!(edge.size_e8, 80_000_000_000, "{:?}", edge.violations);
    assert!(edge.approved, "{:?}", edge.violations);
    // one lot (0.01 SOL) more is refused
    let over = c.preview_executable_hedge(req_px(sol_order(NOW_MS, 7_356_881 + 92), SOL_LIMIT, SOL_REF));
    assert!(over.violations.iter().any(|v| v.starts_with("ORDER_SIZE_CAP")), "{:?}", over.violations);
}

#[test]
fn per_order_cap_is_enforced_when_signing_with_no_mpc_receipt() {
    let mut c = contract();
    ctx(solver(), NearToken::from_near(1));
    // $80,000 of SOL at 46.2 is 1,731 SOL
    let msg = rejected(&mut c, req_px(sol_order(NOW_MS, 8_000_000), 4_620_000_000, 4_620_000_000), true);
    assert!(msg.contains("ORDER_SIZE_CAP: 1731"), "{}", msg);
}

#[test]
fn cumulative_window_cap_stops_stacked_orders_and_resets_after_the_window() {
    let mut c = contract();
    // two 700 SOL orders fit under the 1,600 SOL window cap; a third (700 more) does not
    let short = 6_437_270; // 700 SOL at 91.961
    for (i, expect_ok) in [(0u64, true), (1, true), (2, false)] {
        ctx(solver(), NearToken::from_near(1));
        let r = req_px(sol_order(NOW_MS - 100 + i, short), SOL_LIMIT, SOL_REF);
        if expect_ok {
            let _ = c.sign_executable_hedge(r, Some(false));
        } else {
            let msg = rejected(&mut c, r, false);
            assert!(msg.contains("WINDOW_SIZE_CAP: 1400"), "{}", msg);
        }
    }
    assert_eq!(c.get_attestation_count(), 2);
    // a different market has its own window budget
    ctx(solver(), NearToken::from_near(1));
    let _ = c.sign_executable_hedge(req(order(NOW_MS - 50)), Some(false));
    assert_eq!(c.get_attestation_count(), 3);
    // the preview reports what is already used
    let e = c.preview_executable_hedge(req_px(sol_order(NOW_MS, short), SOL_LIMIT, SOL_REF));
    assert_eq!(e.window_used_size_e8, 140_000_000_000 / 1); // 1,400 SOL in e8
    // after the window has passed the budget is back
    ctx_full(solver(), NearToken::from_near(1), 300, NOW_MS + WINDOW + 1_000);
    let later = NOW_MS + WINDOW + 500;
    let mut r = req_px(sol_order(later, short), SOL_LIMIT, SOL_REF);
    r.expires_after_ms = later + 600_000;
    let _ = c.sign_executable_hedge(r, Some(false));
    assert_eq!(c.get_attestation_count(), 4);
}

#[test]
fn order_count_cap_limits_how_fast_signatures_can_be_collected() {
    let mut c = contract();
    for i in 0..6u64 {
        ctx(solver(), NearToken::from_near(1));
        let _ = c.sign_executable_hedge(req(order(NOW_MS - 100 + i)), Some(false));
    }
    ctx(solver(), NearToken::from_near(1));
    let msg = rejected(&mut c, req(order(NOW_MS)), false);
    assert!(msg.contains("WINDOW_ORDER_COUNT: 6 orders already signed"), "{}", msg);
}

#[test]
fn failed_mpc_attestations_still_count_toward_the_window() {
    let mut c = pending_contract();
    let _ = deliver(&mut c, PromiseResult::Failed);
    assert_eq!(c.get_attestation(0).unwrap().mpc_status, MpcStatus::Failed);
    let e = c.preview_executable_hedge(req(order(NOW_MS + 5)));
    assert_eq!(e.window_order_count, 1);
    assert_eq!(e.window_used_size_e8, SIZE_E8);
}

#[test]
fn expiry_is_required_bounded_and_hashed_into_the_digest() {
    let c = contract();
    let mut base = req(order(NOW_MS));
    // the digest depends on the expiry
    let d0 = c.preview_executable_hedge(base.clone()).digest_hex;
    base.expires_after_ms = EXP + 1;
    let d1 = c.preview_executable_hedge(base.clone()).digest_hex;
    assert_ne!(d0, d1);
    assert_eq!(d0, hl::hex(&hl::order_digest(&[honest_order(3)], NOW_MS, Some(EXP), false)));
    // bounds: block_ms < expiry <= block_ms + max_expiry_ms (inclusive upper edge)
    for (exp, want) in [
        (NOW_MS, Some("EXPIRED")),
        (NOW_MS - 1, Some("EXPIRED")),
        (0, Some("EXPIRED")),
        (NOW_MS + 1, None),
        (NOW_MS + MAX_EXPIRY, None),
        (NOW_MS + MAX_EXPIRY + 1, Some("EXPIRY_TOO_FAR")),
        (u64::MAX, Some("EXPIRY_TOO_FAR")),
    ] {
        let mut r = req(order(NOW_MS));
        r.expires_after_ms = exp;
        let e = c.preview_executable_hedge(r);
        match want {
            Some(code) => assert!(e.violations.iter().any(|v| v.starts_with(code)), "{} -> {:?}", exp, e.violations),
            None => assert!(e.approved, "{} -> {:?}", exp, e.violations),
        }
    }
    // signing with a bad expiry is rejected and creates no MPC receipt
    let mut c2 = contract();
    ctx(solver(), dep());
    let mut r = req(order(NOW_MS));
    r.expires_after_ms = NOW_MS + MAX_EXPIRY + 1;
    assert!(rejected(&mut c2, r, true).contains("EXPIRY_TOO_FAR"));
}

#[test]
fn a_digest_assertion_for_a_different_expiry_is_rejected() {
    let other = hl::hex(&hl::order_digest(&[honest_order(3)], NOW_MS, Some(EXP + 1000), false));
    let none = hl::hex(&hl::order_digest(&[honest_order(3)], NOW_MS, None, false));
    for d in [other, none] {
        let mut r = req(order(NOW_MS));
        r.expected_digest_hex = Some(d);
        assert!(reject_sign(r).contains("PAYLOAD_COMMITMENT_MISMATCH"));
    }
}

#[test]
fn the_mpc_signs_the_digest_that_includes_the_expiry() {
    let mut c = contract();
    ctx(solver(), dep());
    let _ = c.sign_executable_hedge(req(order(NOW_MS)), Some(true));
    let sent = mpc_receipts()[0].1["request"]["payload_v2"]["Ecdsa"].as_str().unwrap().to_string();
    assert_eq!(sent, hl::hex(&hl::order_digest(&[honest_order(3)], NOW_MS, Some(EXP), false)));
    assert_eq!(c.get_attestation(0).unwrap().expires_after_ms, EXP);
}

#[test]
fn hyperliquid_minimum_order_value_is_enforced_with_an_inclusive_edge() {
    // ETH (szDecimals 4): at $2,000 one lot is $0.20, so $10.00 is exactly 50 lots
    let eth = |cents: u64| OrderParams {
        asset_symbol: "ETH".into(),
        treasury_usd_cents: cents * 2,
        spot_long_usd_cents: cents,
        perp_short_usd_cents: cents,
        perp_long_usd_cents: 0,
        collateral_usd_cents: cents * 2,
        quoted_slippage_bps: 2,
        nonce: NOW_MS,
    };
    let px = 2_000 * E8;
    let c = contract();
    let at_min = c.preview_executable_hedge(req_px(eth(1_000), px, px));
    assert!(at_min.approved, "{:?}", at_min.violations);
    assert_eq!(at_min.size_e8, 500_000); // 50 lots x 0.0001 ETH = 0.005 ETH
    let below = c.preview_executable_hedge(req_px(eth(980), px, px));
    assert!(below.violations.iter().any(|v| v.starts_with("ORDER_VALUE_BELOW_MIN")), "{:?}", below.violations);
    let tiny = c.preview_executable_hedge(req_px(eth(100), px, px));
    assert!(tiny.violations.iter().any(|v| v.starts_with("ORDER_VALUE_BELOW_MIN")));
    // and it cannot be signed (no nonce is burned)
    let mut c2 = contract();
    ctx(solver(), dep());
    assert!(rejected(&mut c2, req_px(eth(980), px, px), true).contains("ORDER_VALUE_BELOW_MIN"));
}
