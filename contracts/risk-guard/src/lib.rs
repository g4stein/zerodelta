//! ZeroDelta Risk Guard v2 — NEAR smart contract.
//!
//! The contract is the only way the treasury's hedge key can be used:
//!
//! 1. **No trusted metrics.** The solver submits raw order legs in USD cents.
//!    The contract computes net delta and leverage itself and checks them
//!    against the stored policy.
//! 2. **Payload commitment.** The 32-byte payload that NEAR Chain Signatures
//!    will sign must equal `keccak256(canonical order preimage)` computed here.
//!    Safe-looking numbers with a payload for a different order are rejected
//!    with `PAYLOAD_COMMITMENT_MISMATCH`.
//! 3. **Replay protection.** Each order carries a nonce that must be strictly
//!    greater than the last accepted nonce (`NONCE_ALREADY_USED`).
//! 4. **Guard-gated MPC.** Only after every check passes does the contract
//!    itself call `v1.signer-prod.testnet.sign`. The MPC network derives the
//!    key from the *calling account*, i.e. this contract. The deploy
//!    transaction deletes the account's full-access key, so no human or agent
//!    can call the MPC contract as this account directly, change the policy,
//!    or redeploy the code.
//!
//! Any violation panics with `ZERODELTA_REJECTED: ...`, so the transaction
//! fails and nothing is stored.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::Vector;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

pub const EVENT_STANDARD: &str = "zerodelta";
pub const EVENT_VERSION: &str = "2.0.0";
/// Domain-separation tag of the order commitment preimage.
pub const COMMITMENT_DOMAIN: &str = "zerodelta-hedge-v1";
pub const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
pub const DEFAULT_MPC_PATH: &str = "zerodelta/hedge/arbitrum";

const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const GAS_RESERVE: Gas = Gas::from_tgas(40);
const MIN_SIGN_GAS: Gas = Gas::from_tgas(50);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// |net delta| / treasury, in basis points (200 = 2.00%).
    pub max_delta_bps: u64,
    /// Gross notional / collateral × 100 (300 = 3.00x).
    pub max_leverage_x100: u64,
    /// Maximum quoted slice slippage, in basis points.
    pub max_slippage_bps: u32,
}

/// Raw order legs. All USD amounts are integer cents.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderParams {
    pub asset_symbol: String,
    pub treasury_usd_cents: u64,
    pub spot_long_usd_cents: u64,
    pub perp_short_usd_cents: u64,
    pub perp_long_usd_cents: u64,
    pub collateral_usd_cents: u64,
    pub quoted_slippage_bps: u32,
    pub nonce: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RebalanceInput {
    pub run_id: String,
    pub order: OrderParams,
    /// 64 lowercase hex chars: the exact 32-byte payload to be MPC-signed.
    pub hedge_order_payload_hex: String,
    pub plan_hash: String,
    pub intent_payload_hash: String,
    pub attestation_report_hash: String,
    pub decision_hash: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MpcSignature {
    pub big_r: String,
    pub s: String,
    pub recovery_id: u8,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MpcStatus {
    NotRequested,
    Pending,
    Signed,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub index: u32,
    pub run_id: String,
    pub order: OrderParams,
    pub net_delta_bps: u64,
    pub leverage_x100: u64,
    pub hedge_order_payload_hex: String,
    pub plan_hash: String,
    pub intent_payload_hash: String,
    pub attestation_report_hash: String,
    pub decision_hash: String,
    pub recorded_by: AccountId,
    pub block_height: u64,
    pub timestamp_ns: u64,
    pub mpc_status: MpcStatus,
    pub mpc_signature: Option<MpcSignature>,
}

/// Result of evaluating an order against the policy (also returned by the free view).
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct OrderEvaluation {
    pub approved: bool,
    pub net_delta_bps: u64,
    pub leverage_x100: u64,
    pub slippage_bps: u32,
    pub expected_payload_hex: String,
    pub payload_matches: bool,
    pub nonce_fresh: bool,
    pub violations: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct CheckResult {
    pub approved: bool,
    pub violations: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub solver: AccountId,
    pub policy: Policy,
    pub mpc_signer_contract: AccountId,
    pub mpc_path: String,
    pub last_nonce: u64,
    pub attestation_count: u32,
    pub version: String,
}

/// Shape of the MPC contract's `sign` response.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RawAffinePoint {
    pub affine_point: String,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RawScalar {
    pub scalar: String,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RawMpcSignature {
    pub big_r: RawAffinePoint,
    pub s: RawScalar,
    pub recovery_id: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RiskGuard {
    solver: AccountId,
    policy: Policy,
    mpc_signer_contract: AccountId,
    mpc_path: String,
    last_nonce: u64,
    attestations: Vector<Attestation>,
}

// ---------------------------------------------------------------------------
// Pure helpers (shared with the TypeScript mirror in src/lib/near/riskGuardContract.ts)
// ---------------------------------------------------------------------------

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_valid_symbol(s: &str) -> bool {
    (2..=10).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn ceil_div(num: u128, den: u128) -> u64 {
    let q = (num + den - 1) / den;
    q.min(u64::MAX as u128) as u64
}

/// `ceil(|spot + perp_long − perp_short| × 10 000 / treasury)`.
pub fn compute_net_delta_bps(o: &OrderParams) -> u64 {
    let long = o.spot_long_usd_cents as u128 + o.perp_long_usd_cents as u128;
    let short = o.perp_short_usd_cents as u128;
    let diff = if long > short { long - short } else { short - long };
    ceil_div(diff * 10_000, o.treasury_usd_cents.max(1) as u128)
}

/// `ceil((spot + perp_short + perp_long) × 100 / collateral)`.
pub fn compute_leverage_x100(o: &OrderParams) -> u64 {
    let gross = o.spot_long_usd_cents as u128 + o.perp_short_usd_cents as u128 + o.perp_long_usd_cents as u128;
    ceil_div(gross * 100, o.collateral_usd_cents.max(1) as u128)
}

/// Canonical, pipe-delimited preimage. The symbol charset excludes `|`, so it is unambiguous.
pub fn commitment_preimage(contract_id: &str, o: &OrderParams) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        COMMITMENT_DOMAIN,
        contract_id,
        o.asset_symbol,
        o.treasury_usd_cents,
        o.spot_long_usd_cents,
        o.perp_short_usd_cents,
        o.perp_long_usd_cents,
        o.collateral_usd_cents,
        o.quoted_slippage_bps,
        o.nonce
    )
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{}\",\"data\":[{}]}}",
        EVENT_STANDARD, EVENT_VERSION, event, data
    ));
}

fn reject(reason: &str) -> ! {
    env::panic_str(&format!("ZERODELTA_REJECTED: {}", reason))
}

#[near]
impl RiskGuard {
    /// Deploy-time initialisation. Policy, solver and MPC target are immutable afterwards.
    #[init]
    pub fn new(solver: AccountId, policy: Policy, mpc_signer_contract: Option<AccountId>, mpc_path: Option<String>) -> Self {
        if policy.max_delta_bps > 10_000 {
            env::panic_str("max_delta_bps must be <= 10000");
        }
        if policy.max_leverage_x100 < 100 {
            env::panic_str("max_leverage_x100 must be >= 100");
        }
        let mpc_signer_contract = mpc_signer_contract.unwrap_or_else(|| DEFAULT_MPC_SIGNER.parse().unwrap());
        let mpc_path = mpc_path.unwrap_or_else(|| DEFAULT_MPC_PATH.to_string());
        emit(
            "policy_registered",
            format!(
                "{{\"contract\":\"{}\",\"solver\":\"{}\",\"max_delta_bps\":{},\"max_leverage_x100\":{},\"max_slippage_bps\":{},\"mpc_signer_contract\":\"{}\",\"mpc_path\":\"{}\"}}",
                env::current_account_id(),
                solver,
                policy.max_delta_bps,
                policy.max_leverage_x100,
                policy.max_slippage_bps,
                mpc_signer_contract,
                mpc_path
            ),
        );
        Self { solver, policy, mpc_signer_contract, mpc_path, last_nonce: 0, attestations: Vector::new(b"a") }
    }

    fn evaluate(&self, o: &OrderParams, payload_hex: &str) -> OrderEvaluation {
        let mut violations = Vec::new();
        if !is_valid_symbol(&o.asset_symbol) {
            violations.push("INVALID_ORDER: asset_symbol must be 2-10 chars A-Z0-9".to_string());
        }
        if o.treasury_usd_cents == 0 {
            violations.push("INVALID_ORDER: treasury_usd_cents must be > 0".to_string());
        }
        if o.collateral_usd_cents == 0 {
            violations.push("INVALID_ORDER: collateral_usd_cents must be > 0".to_string());
        }
        if o.collateral_usd_cents > o.treasury_usd_cents {
            violations.push("INVALID_ORDER: collateral exceeds treasury".to_string());
        }
        let net_delta_bps = compute_net_delta_bps(o);
        let leverage_x100 = compute_leverage_x100(o);
        if net_delta_bps > self.policy.max_delta_bps {
            violations.push(format!("DELTA_NEUTRALITY: {} bps > {} bps", net_delta_bps, self.policy.max_delta_bps));
        }
        if leverage_x100 > self.policy.max_leverage_x100 {
            violations.push(format!("LEVERAGE_CEILING: {} > {} (x100)", leverage_x100, self.policy.max_leverage_x100));
        }
        if o.quoted_slippage_bps > self.policy.max_slippage_bps {
            violations.push(format!("SLIPPAGE_CEILING: {} bps > {} bps", o.quoted_slippage_bps, self.policy.max_slippage_bps));
        }
        let expected_payload_hex = to_hex(&env::keccak256(commitment_preimage(env::current_account_id().as_str(), o).as_bytes()));
        let payload_matches = payload_hex == expected_payload_hex;
        if !payload_matches {
            violations.push(format!("PAYLOAD_COMMITMENT_MISMATCH: expected {} got {}", expected_payload_hex, payload_hex));
        }
        let nonce_fresh = o.nonce > self.last_nonce;
        if !nonce_fresh {
            violations.push(format!("NONCE_ALREADY_USED: nonce {} <= last accepted {}", o.nonce, self.last_nonce));
        }
        OrderEvaluation {
            approved: violations.is_empty(),
            net_delta_bps,
            leverage_x100,
            slippage_bps: o.quoted_slippage_bps,
            expected_payload_hex,
            payload_matches,
            nonce_fresh,
            violations,
        }
    }

    /// Verifies the order on-chain, records it, and (if requested) has this contract ask the
    /// MPC network to sign the committed payload. Panics with `ZERODELTA_REJECTED: ...` otherwise.
    #[payable]
    pub fn record_rebalance(&mut self, rebalance: RebalanceInput, request_mpc_sign: Option<bool>) -> PromiseOrValue<u32> {
        let caller = env::predecessor_account_id();
        if caller != self.solver {
            reject(&format!("UNAUTHORIZED_SOLVER: {} is not the registered solver", caller));
        }
        for (name, value) in [
            ("hedge_order_payload_hex", &rebalance.hedge_order_payload_hex),
            ("plan_hash", &rebalance.plan_hash),
            ("intent_payload_hash", &rebalance.intent_payload_hash),
            ("attestation_report_hash", &rebalance.attestation_report_hash),
            ("decision_hash", &rebalance.decision_hash),
        ] {
            if !is_sha256_hex(value) {
                reject(&format!("MALFORMED_HASH: {} must be 64 lowercase hex chars", name));
            }
        }
        let eval = self.evaluate(&rebalance.order, &rebalance.hedge_order_payload_hex);
        if !eval.approved {
            reject(&eval.violations.join("; "));
        }
        let sign = request_mpc_sign.unwrap_or(false);
        let deposit = env::attached_deposit();
        if sign && deposit.is_zero() {
            reject("MPC_DEPOSIT_REQUIRED: attach at least 1 yoctoNEAR");
        }
        if !sign && !deposit.is_zero() {
            reject("UNEXPECTED_DEPOSIT: deposit is only accepted with request_mpc_sign");
        }

        self.last_nonce = rebalance.order.nonce;
        let index = self.attestations.len();
        let record = Attestation {
            index,
            run_id: rebalance.run_id,
            order: rebalance.order,
            net_delta_bps: eval.net_delta_bps,
            leverage_x100: eval.leverage_x100,
            hedge_order_payload_hex: rebalance.hedge_order_payload_hex,
            plan_hash: rebalance.plan_hash,
            intent_payload_hash: rebalance.intent_payload_hash,
            attestation_report_hash: rebalance.attestation_report_hash,
            decision_hash: rebalance.decision_hash,
            recorded_by: caller,
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
            mpc_status: if sign { MpcStatus::Pending } else { MpcStatus::NotRequested },
            mpc_signature: None,
        };
        emit(
            "rebalance_recorded",
            format!(
                "{{\"index\":{},\"nonce\":{},\"net_delta_bps\":{},\"leverage_x100\":{},\"slippage_bps\":{},\"payload\":\"{}\",\"decision_hash\":\"{}\",\"mpc_requested\":{}}}",
                index,
                record.order.nonce,
                record.net_delta_bps,
                record.leverage_x100,
                record.order.quoted_slippage_bps,
                record.hedge_order_payload_hex,
                record.decision_hash,
                sign
            ),
        );
        let payload = record.hedge_order_payload_hex.clone();
        self.attestations.push(record);

        if !sign {
            return PromiseOrValue::Value(index);
        }
        let used = env::used_gas().as_gas() + CALLBACK_GAS.as_gas() + GAS_RESERVE.as_gas();
        let sign_gas = Gas::from_gas(env::prepaid_gas().as_gas().saturating_sub(used));
        if sign_gas < MIN_SIGN_GAS {
            reject("INSUFFICIENT_GAS: attach ~300 Tgas when request_mpc_sign is true");
        }
        let args = near_sdk::serde_json::json!({
            "request": { "payload_v2": { "Ecdsa": payload }, "path": self.mpc_path, "domain_id": 0 }
        });
        emit("mpc_sign_requested", format!("{{\"index\":{},\"mpc\":\"{}\",\"payload\":\"{}\"}}", index, self.mpc_signer_contract, payload));
        let promise = Promise::new(self.mpc_signer_contract.clone())
            .function_call("sign".to_string(), args.to_string().into_bytes(), deposit, sign_gas)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_mpc_signed(index));
        PromiseOrValue::Promise(promise)
    }

    /// Callback from the MPC contract. Stores the signature next to the attestation.
    #[private]
    pub fn on_mpc_signed(&mut self, index: u32, #[callback_result] result: Result<RawMpcSignature, PromiseError>) -> Option<MpcSignature> {
        let outcome = match result {
            Ok(raw) => Some(MpcSignature { big_r: raw.big_r.affine_point, s: raw.s.scalar, recovery_id: raw.recovery_id }),
            Err(_) => None,
        };
        if let Some(att) = self.attestations.get_mut(index) {
            att.mpc_status = if outcome.is_some() { MpcStatus::Signed } else { MpcStatus::Failed };
            att.mpc_signature = outcome.clone();
        }
        emit("mpc_signed", format!("{{\"index\":{},\"ok\":{}}}", index, outcome.is_some()));
        outcome
    }

    // ---- views ---------------------------------------------------------------

    /// Free, read-only run of every on-chain check, including the contract-computed metrics.
    pub fn check_order_params(&self, order: OrderParams, hedge_order_payload_hex: String) -> OrderEvaluation {
        self.evaluate(&order, &hedge_order_payload_hex)
    }

    /// Payload the contract would accept for `order` (keccak256 of the canonical preimage).
    pub fn compute_payload(&self, order: OrderParams) -> String {
        to_hex(&env::keccak256(commitment_preimage(env::current_account_id().as_str(), &order).as_bytes()))
    }

    /// Legacy view kept for dashboards: checks pre-computed metrics only (not used for authorization).
    pub fn check_rebalance(&self, net_delta_bps: u64, leverage_x100: u64, slippage_bps: u32) -> CheckResult {
        let mut violations = Vec::new();
        if net_delta_bps > self.policy.max_delta_bps {
            violations.push(format!("DELTA_NEUTRALITY: {} bps > {} bps", net_delta_bps, self.policy.max_delta_bps));
        }
        if leverage_x100 > self.policy.max_leverage_x100 {
            violations.push(format!("LEVERAGE_CEILING: {} > {} (x100)", leverage_x100, self.policy.max_leverage_x100));
        }
        if slippage_bps > self.policy.max_slippage_bps {
            violations.push(format!("SLIPPAGE_CEILING: {} bps > {} bps", slippage_bps, self.policy.max_slippage_bps));
        }
        CheckResult { approved: violations.is_empty(), violations }
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_config(&self) -> Config {
        Config {
            solver: self.solver.clone(),
            policy: self.policy.clone(),
            mpc_signer_contract: self.mpc_signer_contract.clone(),
            mpc_path: self.mpc_path.clone(),
            last_nonce: self.last_nonce,
            attestation_count: self.attestations.len(),
            version: EVENT_VERSION.to_string(),
        }
    }

    pub fn get_last_nonce(&self) -> u64 {
        self.last_nonce
    }

    pub fn get_attestation_count(&self) -> u32 {
        self.attestations.len()
    }

    pub fn get_attestation(&self, index: u32) -> Option<Attestation> {
        self.attestations.get(index).cloned()
    }

    pub fn get_attestations(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Attestation> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(20).min(50);
        (from..self.attestations.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.attestations.get(i).cloned())
            .collect()
    }
}

// Keep NearToken in scope for the unit tests and doc references.
#[allow(dead_code)]
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn guard() -> AccountId {
        "zerodelta-guard.testnet".parse().unwrap()
    }
    fn solver() -> AccountId {
        "zerodelta-solver.testnet".parse().unwrap()
    }
    fn attacker() -> AccountId {
        "attacker.testnet".parse().unwrap()
    }

    fn ctx(predecessor: AccountId, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(guard())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(deposit)
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(b.build());
    }

    fn policy() -> Policy {
        Policy { max_delta_bps: 200, max_leverage_x100: 300, max_slippage_bps: 25 }
    }

    fn contract() -> RiskGuard {
        ctx(guard(), NearToken::from_yoctonear(0));
        RiskGuard::new(solver(), policy(), None, None)
    }

    /// $50,000 treasury, $24,950 spot long, $24,950 perp short: delta-neutral, ~1x.
    fn hedged(nonce: u64) -> OrderParams {
        OrderParams {
            asset_symbol: "NEAR".into(),
            treasury_usd_cents: 5_000_000,
            spot_long_usd_cents: 2_495_000,
            perp_short_usd_cents: 2_495_000,
            perp_long_usd_cents: 0,
            collateral_usd_cents: 5_000_000,
            quoted_slippage_bps: 2,
            nonce,
        }
    }

    /// 100% spot + 9x perp long, no hedge.
    fn rogue(nonce: u64) -> OrderParams {
        OrderParams {
            asset_symbol: "NEAR".into(),
            treasury_usd_cents: 5_000_000,
            spot_long_usd_cents: 4_970_000,
            perp_short_usd_cents: 0,
            perp_long_usd_cents: 45_000_000,
            collateral_usd_cents: 5_000_000,
            quoted_slippage_bps: 13,
            nonce,
        }
    }

    fn payload(o: &OrderParams) -> String {
        to_hex(&env::keccak256(commitment_preimage(guard().as_str(), o).as_bytes()))
    }

    fn input(o: OrderParams, payload_hex: String) -> RebalanceInput {
        RebalanceInput {
            run_id: "run".into(),
            order: o,
            hedge_order_payload_hex: payload_hex,
            plan_hash: "a".repeat(64),
            intent_payload_hash: "b".repeat(64),
            attestation_report_hash: "c".repeat(64),
            decision_hash: "d".repeat(64),
        }
    }

    #[test]
    fn computes_metrics_from_raw_legs() {
        let h = hedged(1);
        assert_eq!(compute_net_delta_bps(&h), 0);
        assert_eq!(compute_leverage_x100(&h), 100); // 99.8 rounded up
        let r = rogue(1);
        assert_eq!(compute_net_delta_bps(&r), 99_940);
        assert_eq!(compute_leverage_x100(&r), 1000); // 999.4 rounded up
        // 52/48 mis-hedge on $100k = 4% net delta, rounded up never down.
        let mut m = hedged(1);
        m.treasury_usd_cents = 10_000_000;
        m.collateral_usd_cents = 10_000_000;
        m.spot_long_usd_cents = 5_200_000;
        m.perp_short_usd_cents = 4_800_000;
        assert_eq!(compute_net_delta_bps(&m), 400);
        m.perp_short_usd_cents = 4_799_999;
        assert_eq!(compute_net_delta_bps(&m), 401);
    }

    #[test]
    fn valid_delta_neutral_order_passes_and_records() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let h = hedged(10);
        let p = payload(&h);
        let eval = c.check_order_params(h.clone(), p.clone());
        assert!(eval.approved, "{:?}", eval.violations);
        assert_eq!(eval.expected_payload_hex, p);
        match c.record_rebalance(input(h, p.clone()), None) {
            PromiseOrValue::Value(i) => assert_eq!(i, 0),
            _ => panic!("expected value without MPC sign"),
        }
        assert_eq!(c.get_last_nonce(), 10);
        let att = c.get_attestation(0).unwrap();
        assert_eq!(att.net_delta_bps, 0);
        assert_eq!(att.leverage_x100, 100);
        assert_eq!(att.hedge_order_payload_hex, p);
        assert_eq!(att.mpc_status, MpcStatus::NotRequested);
        assert!(get_logs().iter().any(|l| l.contains("rebalance_recorded")));
    }

    #[test]
    fn approved_order_with_mpc_flag_issues_sign_promise_and_stores_signature() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(1));
        let h = hedged(11);
        let p = payload(&h);
        match c.record_rebalance(input(h, p), Some(true)) {
            PromiseOrValue::Promise(_) => {}
            _ => panic!("expected a cross-contract promise to the MPC signer"),
        }
        assert_eq!(c.get_attestation(0).unwrap().mpc_status, MpcStatus::Pending);
        assert!(get_logs().iter().any(|l| l.contains("mpc_sign_requested") && l.contains(DEFAULT_MPC_SIGNER)));
        // MPC network responds: the private callback stores the signature.
        ctx(guard(), NearToken::from_yoctonear(0));
        let raw = RawMpcSignature {
            big_r: RawAffinePoint { affine_point: "03aa".into() },
            s: RawScalar { scalar: "bb".into() },
            recovery_id: 1,
        };
        let sig = c.on_mpc_signed(0, Ok(raw)).unwrap();
        assert_eq!(sig.recovery_id, 1);
        let att = c.get_attestation(0).unwrap();
        assert_eq!(att.mpc_status, MpcStatus::Signed);
        assert_eq!(att.mpc_signature.unwrap().big_r, "03aa");
    }

    #[test]
    fn failed_mpc_callback_marks_attestation_failed() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(1));
        let h = hedged(12);
        let p = payload(&h);
        let _ = c.record_rebalance(input(h, p), Some(true));
        ctx(guard(), NearToken::from_yoctonear(0));
        assert!(c.on_mpc_signed(0, Err(PromiseError::Failed)).is_none());
        assert_eq!(c.get_attestation(0).unwrap().mpc_status, MpcStatus::Failed);
    }

    #[test]
    #[should_panic(expected = "ZERODELTA_REJECTED: DELTA_NEUTRALITY: 99940 bps > 200 bps; LEVERAGE_CEILING: 1000 > 300 (x100)")]
    fn rogue_10x_order_fails_on_math() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let r = rogue(20);
        let p = payload(&r); // honest commitment, so only the math fails
        let _ = c.record_rebalance(input(r, p), None);
    }

    #[test]
    #[should_panic(expected = "ZERODELTA_REJECTED: PAYLOAD_COMMITMENT_MISMATCH")]
    fn safe_numbers_with_rogue_payload_are_rejected() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(1));
        let h = hedged(30);
        let rogue_payload = payload(&rogue(30));
        let _ = c.record_rebalance(input(h, rogue_payload), Some(true));
    }

    #[test]
    fn view_reports_payload_mismatch_without_panicking() {
        let c = contract();
        let eval = c.check_order_params(hedged(31), payload(&rogue(31)));
        assert!(!eval.approved);
        assert!(!eval.payload_matches);
        assert_eq!(eval.net_delta_bps, 0);
        assert!(eval.violations[0].starts_with("PAYLOAD_COMMITMENT_MISMATCH"));
    }

    #[test]
    #[should_panic(expected = "ZERODELTA_REJECTED: NONCE_ALREADY_USED: nonce 40 <= last accepted 40")]
    fn replayed_nonce_is_rejected() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let h = hedged(40);
        let p = payload(&h);
        let _ = c.record_rebalance(input(h.clone(), p.clone()), None);
        let _ = c.record_rebalance(input(h, p), None);
    }

    #[test]
    #[should_panic(expected = "NONCE_ALREADY_USED")]
    fn older_nonce_is_rejected() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let h = hedged(50);
        let _ = c.record_rebalance(input(h.clone(), payload(&h)), None);
        let older = hedged(49);
        let _ = c.record_rebalance(input(older.clone(), payload(&older)), None);
    }

    #[test]
    #[should_panic(expected = "ZERODELTA_REJECTED: UNAUTHORIZED_SOLVER")]
    fn unauthorized_caller_is_rejected() {
        let mut c = contract();
        ctx(attacker(), NearToken::from_yoctonear(1));
        let h = hedged(60);
        let p = payload(&h);
        let _ = c.record_rebalance(input(h, p), Some(true));
    }

    #[test]
    #[should_panic(expected = "ZERODELTA_REJECTED: UNAUTHORIZED_SOLVER")]
    fn guard_account_itself_cannot_record() {
        let mut c = contract();
        ctx(guard(), NearToken::from_yoctonear(0));
        let h = hedged(61);
        let p = payload(&h);
        let _ = c.record_rebalance(input(h, p), None);
    }

    #[test]
    #[should_panic(expected = "INVALID_ORDER: collateral exceeds treasury")]
    fn inflated_collateral_is_rejected() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let mut r = rogue(70);
        r.collateral_usd_cents = 200_000_000; // pretend 40x collateral to dilute leverage
        let p = payload(&r);
        let _ = c.record_rebalance(input(r, p), None);
    }

    #[test]
    #[should_panic(expected = "MALFORMED_HASH")]
    fn malformed_hash_is_rejected() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let h = hedged(80);
        let _ = c.record_rebalance(input(h, "XYZ".into()), None);
    }

    #[test]
    #[should_panic(expected = "MPC_DEPOSIT_REQUIRED")]
    fn mpc_sign_requires_deposit() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let h = hedged(90);
        let p = payload(&h);
        let _ = c.record_rebalance(input(h, p), Some(true));
    }

    #[test]
    #[should_panic(expected = "SLIPPAGE_CEILING: 26 bps > 25 bps")]
    fn slippage_ceiling_is_enforced() {
        let mut c = contract();
        ctx(solver(), NearToken::from_yoctonear(0));
        let mut h = hedged(100);
        h.quoted_slippage_bps = 26;
        let p = payload(&h);
        let _ = c.record_rebalance(input(h, p), None);
    }

    #[test]
    fn commitment_preimage_is_canonical() {
        assert_eq!(
            commitment_preimage("zerodelta-guard.testnet", &hedged(7)),
            "zerodelta-hedge-v1|zerodelta-guard.testnet|NEAR|5000000|2495000|2495000|0|5000000|2|7"
        );
    }

    #[test]
    fn legacy_check_rebalance_still_works() {
        let c = contract();
        assert!(c.check_rebalance(0, 100, 2).approved);
        assert_eq!(c.check_rebalance(99_940, 1000, 13).violations.len(), 2);
    }

    #[test]
    fn config_exposes_immutable_policy_and_mpc_target() {
        let c = contract();
        let cfg = c.get_config();
        assert_eq!(cfg.policy, policy());
        assert_eq!(cfg.mpc_signer_contract.as_str(), DEFAULT_MPC_SIGNER);
        assert_eq!(cfg.mpc_path, DEFAULT_MPC_PATH);
        assert_eq!(cfg.last_nonce, 0);
    }
}
