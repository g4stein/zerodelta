//! Adversarial integration tests for the deployed Risk Guard v2 contract.
//!
//! These live outside `src/lib.rs` so the deployed source and WASM stay byte-identical.
//! Each test names the invariant it attacks.

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId, Gas, NearToken, PromiseOrValue};
use zerodelta_risk_guard::{commitment_preimage, compute_leverage_x100, compute_net_delta_bps, to_hex, OrderParams, Policy, RebalanceInput, RiskGuard};

fn guard() -> AccountId {
    "zerodelta-guard.testnet".parse().unwrap()
}
fn solver() -> AccountId {
    "zerodelta-solver.testnet".parse().unwrap()
}

fn ctx(predecessor: AccountId, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn contract() -> RiskGuard {
    ctx(guard(), 0);
    RiskGuard::new(solver(), Policy { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25 }, None, None)
}

fn order(nonce: u64) -> OrderParams {
    OrderParams {
        asset_symbol: "ETH".into(),
        treasury_usd_cents: 10_000_000,
        spot_long_usd_cents: 5_000_000,
        perp_short_usd_cents: 5_000_000,
        perp_long_usd_cents: 0,
        collateral_usd_cents: 10_000_000,
        quoted_slippage_bps: 5,
        nonce,
    }
}

fn payload_for(contract_id: &str, o: &OrderParams) -> String {
    to_hex(&env::keccak256(commitment_preimage(contract_id, o).as_bytes()))
}
fn payload(o: &OrderParams) -> String {
    payload_for(guard().as_str(), o)
}

fn input(o: OrderParams, p: String) -> RebalanceInput {
    RebalanceInput {
        run_id: "adv".into(),
        order: o,
        hedge_order_payload_hex: p,
        plan_hash: "a".repeat(64),
        intent_payload_hash: "b".repeat(64),
        attestation_report_hash: "c".repeat(64),
        decision_hash: "d".repeat(64),
    }
}

fn violations(c: &RiskGuard, o: &OrderParams, p: &str) -> Vec<String> {
    c.check_order_params(o.clone(), p.to_string()).violations
}

// ---- Invariant: delta neutrality (rounding boundary) --------------------------------------------

#[test]
fn delta_exactly_at_limit_passes_one_cent_over_fails() {
    let c = contract();
    let mut o = order(1);
    o.perp_short_usd_cents = 4_800_000; // |5.0M - 4.8M| / 10M = 200 bps exactly
    assert_eq!(compute_net_delta_bps(&o), 200);
    assert!(violations(&c, &o, &payload(&o)).is_empty());
    o.perp_short_usd_cents = 4_799_999; // 200.001 bps rounds UP to 201
    assert_eq!(compute_net_delta_bps(&o), 201);
    let v = violations(&c, &o, &payload(&o));
    assert_eq!(v.len(), 1);
    assert!(v[0].starts_with("DELTA_NEUTRALITY: 201 bps"));
}

#[test]
fn short_side_overhedge_is_also_directional() {
    let c = contract();
    let mut o = order(1);
    o.perp_short_usd_cents = 8_000_000; // net short 30%
    assert!(violations(&c, &o, &payload(&o))[0].starts_with("DELTA_NEUTRALITY: 3000 bps"));
}

// ---- Invariant: leverage ceiling (rounding boundary) ---------------------------------------------

#[test]
fn leverage_exactly_3x_passes_one_cent_over_fails() {
    let c = contract();
    let mut o = order(1);
    o.spot_long_usd_cents = 15_000_000;
    o.perp_short_usd_cents = 15_000_000; // 30M / 10M = 300 exactly
    assert_eq!(compute_leverage_x100(&o), 300);
    assert!(violations(&c, &o, &payload(&o)).is_empty());
    o.perp_short_usd_cents = 15_000_001;
    assert_eq!(compute_leverage_x100(&o), 301);
    assert!(violations(&c, &o, &payload(&o)).iter().any(|v| v.starts_with("LEVERAGE_CEILING: 301")));
}

// ---- Invariant: slippage ceiling -----------------------------------------------------------------

#[test]
fn slippage_25_passes_26_fails() {
    let c = contract();
    let mut o = order(1);
    o.quoted_slippage_bps = 25;
    assert!(violations(&c, &o, &payload(&o)).is_empty());
    o.quoted_slippage_bps = 26;
    assert_eq!(violations(&c, &o, &payload(&o)), vec!["SLIPPAGE_CEILING: 26 bps > 25 bps".to_string()]);
}

// ---- Invariant: order validity -------------------------------------------------------------------

#[test]
fn zero_treasury_and_zero_collateral_are_invalid() {
    let c = contract();
    let mut o = order(1);
    o.treasury_usd_cents = 0;
    o.collateral_usd_cents = 0;
    let v = violations(&c, &o, &payload(&o));
    assert!(v.iter().any(|x| x == "INVALID_ORDER: treasury_usd_cents must be > 0"));
    assert!(v.iter().any(|x| x == "INVALID_ORDER: collateral_usd_cents must be > 0"));
}

#[test]
fn collateral_above_treasury_is_invalid() {
    let c = contract();
    let mut o = order(1);
    o.collateral_usd_cents = o.treasury_usd_cents + 1;
    assert!(violations(&c, &o, &payload(&o)).iter().any(|x| x == "INVALID_ORDER: collateral exceeds treasury"));
}

#[test]
fn invalid_asset_symbols_are_rejected() {
    let c = contract();
    for sym in ["eth", "E", "ETH|X", "TOOLONGSYMB", "ET H", ""] {
        let mut o = order(1);
        o.asset_symbol = sym.into();
        let v = violations(&c, &o, &payload(&o));
        assert!(v.iter().any(|x| x.starts_with("INVALID_ORDER: asset_symbol")), "{sym:?} not rejected: {v:?}");
    }
}

#[test]
fn extreme_u64_legs_do_not_overflow_and_are_rejected() {
    let c = contract();
    let mut o = order(1);
    o.spot_long_usd_cents = u64::MAX;
    o.perp_long_usd_cents = u64::MAX;
    o.perp_short_usd_cents = 0;
    o.treasury_usd_cents = 1;
    o.collateral_usd_cents = 1;
    // u128 arithmetic, result saturates at u64::MAX instead of wrapping to a small "safe" number
    assert_eq!(compute_net_delta_bps(&o), u64::MAX);
    assert_eq!(compute_leverage_x100(&o), u64::MAX);
    let v = violations(&c, &o, &payload(&o));
    assert!(v.iter().any(|x| x.starts_with("DELTA_NEUTRALITY")));
    assert!(v.iter().any(|x| x.starts_with("LEVERAGE_CEILING")));
}

// ---- Invariant: payload commitment binds every field --------------------------------------------

#[test]
fn changing_any_field_after_commitment_breaks_the_payload() {
    let c = contract();
    let base = order(5);
    let committed = payload(&base);
    let mut variants: Vec<OrderParams> = Vec::new();
    let mut o = base.clone();
    o.asset_symbol = "BTC".into();
    variants.push(o);
    let mut o = base.clone();
    o.perp_short_usd_cents += 1;
    variants.push(o);
    let mut o = base.clone();
    o.spot_long_usd_cents -= 1;
    variants.push(o);
    let mut o = base.clone();
    o.collateral_usd_cents -= 1;
    variants.push(o);
    let mut o = base.clone();
    o.treasury_usd_cents += 1;
    variants.push(o);
    let mut o = base.clone();
    o.quoted_slippage_bps += 1;
    variants.push(o);
    let mut o = base.clone();
    o.nonce += 1;
    variants.push(o);
    for v in variants {
        let res = c.check_order_params(v.clone(), committed.clone());
        assert!(!res.payload_matches, "{v:?}");
        assert!(res.violations.iter().any(|x| x.starts_with("PAYLOAD_COMMITMENT_MISMATCH")));
    }
}

#[test]
fn payload_for_another_contract_is_rejected() {
    let c = contract();
    let o = order(5);
    let foreign = payload_for("someone-else.testnet", &o);
    assert!(violations(&c, &o, &foreign)[0].starts_with("PAYLOAD_COMMITMENT_MISMATCH"));
}

#[test]
#[should_panic(expected = "MALFORMED_HASH: hedge_order_payload_hex")]
fn uppercase_payload_hex_is_malformed() {
    let mut c = contract();
    ctx(solver(), 0);
    let o = order(5);
    let p = payload(&o).to_uppercase();
    let _ = c.record_rebalance(input(o, p), None);
}

// ---- Invariant: replay / nonce -------------------------------------------------------------------

#[test]
fn nonce_zero_is_never_fresh() {
    let c = contract();
    let o = order(0);
    assert!(violations(&c, &o, &payload(&o)).iter().any(|x| x.starts_with("NONCE_ALREADY_USED: nonce 0")));
}

#[test]
fn accepted_nonce_becomes_the_floor_for_the_view_too() {
    let mut c = contract();
    ctx(solver(), 0);
    let o = order(100);
    match c.record_rebalance(input(o.clone(), payload(&o)), None) {
        PromiseOrValue::Value(0) => {}
        _ => panic!("expected attestation index 0"),
    }
    let replay = c.check_order_params(o.clone(), payload(&o));
    assert!(!replay.nonce_fresh);
    let next = order(101);
    assert!(c.check_order_params(next.clone(), payload(&next)).approved);
}

// ---- Invariant: deposit rules --------------------------------------------------------------------

#[test]
#[should_panic(expected = "UNEXPECTED_DEPOSIT")]
fn deposit_without_mpc_request_is_refused() {
    let mut c = contract();
    ctx(solver(), 1);
    let o = order(7);
    let p = payload(&o);
    let _ = c.record_rebalance(input(o, p), Some(false));
}

#[test]
fn view_never_panics_on_garbage_payload() {
    let c = contract();
    let o = order(9);
    let res = c.check_order_params(o, "not-hex".into());
    assert!(!res.approved);
    assert!(!res.payload_matches);
}
