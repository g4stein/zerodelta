//! ZeroDelta Risk Guard — NEAR smart contract.
//!
//! The off-chain Risk Guard (Agent 3) approves a rebalance only if it is
//! delta-neutral, within the leverage ceiling and within the slippage ceiling.
//! This contract enforces the same invariants again, on-chain:
//!
//! * `policy` holds the limits (basis points / leverage × 100).
//! * `record_rebalance` may only be called by the registered solver account and
//!   panics (the transaction fails, nothing is stored) if any limit is broken.
//! * Approved rebalances are stored with their plan, NEP-413 intent, TEE
//!   attestation and guardian decision hashes, and emitted as NEP-297 events.
//! * `check_rebalance` is a free view method that runs the same checks.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

pub const EVENT_STANDARD: &str = "zerodelta";
pub const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// |net delta| / treasury, in basis points (200 = 2.00%).
    pub max_delta_bps: u32,
    /// Total notional / collateral × 100 (300 = 3.00x).
    pub max_leverage_x100: u32,
    /// Maximum slice slippage, in basis points.
    pub max_slippage_bps: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RebalanceInput {
    pub run_id: String,
    pub pair: String,
    pub treasury_usd: u64,
    pub net_delta_bps: u32,
    pub leverage_x100: u32,
    pub slippage_bps: u32,
    pub plan_hash: String,
    pub intent_payload_hash: String,
    pub attestation_report_hash: String,
    pub decision_hash: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub index: u32,
    pub run_id: String,
    pub pair: String,
    pub treasury_usd: u64,
    pub net_delta_bps: u32,
    pub leverage_x100: u32,
    pub slippage_bps: u32,
    pub plan_hash: String,
    pub intent_payload_hash: String,
    pub attestation_report_hash: String,
    pub decision_hash: String,
    pub recorded_by: AccountId,
    pub block_height: u64,
    pub timestamp_ns: u64,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct CheckResult {
    pub approved: bool,
    pub violations: Vec<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RiskGuard {
    owner: AccountId,
    solver: AccountId,
    policy: Policy,
    attestations: Vector<Attestation>,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn evaluate(policy: &Policy, net_delta_bps: u32, leverage_x100: u32, slippage_bps: u32) -> Vec<String> {
    let mut violations = Vec::new();
    if net_delta_bps > policy.max_delta_bps {
        violations.push(format!("DELTA_NEUTRALITY: {} bps > {} bps", net_delta_bps, policy.max_delta_bps));
    }
    if leverage_x100 > policy.max_leverage_x100 {
        violations.push(format!("LEVERAGE_CEILING: {} > {} (x100)", leverage_x100, policy.max_leverage_x100));
    }
    if slippage_bps > policy.max_slippage_bps {
        violations.push(format!("SLIPPAGE_CEILING: {} bps > {} bps", slippage_bps, policy.max_slippage_bps));
    }
    violations
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{}\",\"data\":[{}]}}",
        EVENT_STANDARD, EVENT_VERSION, event, data
    ));
}

#[near]
impl RiskGuard {
    /// Deploy-time initialisation. The caller (the guard account) becomes the owner.
    #[init]
    pub fn new(solver: AccountId, policy: Policy) -> Self {
        require!(policy.max_delta_bps <= 10_000, "max_delta_bps must be <= 10000");
        require!(policy.max_leverage_x100 >= 100, "max_leverage_x100 must be >= 100");
        let owner = env::predecessor_account_id();
        emit(
            "policy_registered",
            format!(
                "{{\"owner\":\"{}\",\"solver\":\"{}\",\"max_delta_bps\":{},\"max_leverage_x100\":{},\"max_slippage_bps\":{}}}",
                owner, solver, policy.max_delta_bps, policy.max_leverage_x100, policy.max_slippage_bps
            ),
        );
        Self { owner, solver, policy, attestations: Vector::new(b"a") }
    }

    /// Owner-only policy update.
    pub fn set_policy(&mut self, policy: Policy) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can change the policy");
        require!(policy.max_delta_bps <= 10_000, "max_delta_bps must be <= 10000");
        require!(policy.max_leverage_x100 >= 100, "max_leverage_x100 must be >= 100");
        emit(
            "policy_registered",
            format!(
                "{{\"owner\":\"{}\",\"solver\":\"{}\",\"max_delta_bps\":{},\"max_leverage_x100\":{},\"max_slippage_bps\":{}}}",
                self.owner, self.solver, policy.max_delta_bps, policy.max_leverage_x100, policy.max_slippage_bps
            ),
        );
        self.policy = policy;
    }

    /// Records an approved rebalance. Fails the whole transaction if the caller is not the
    /// solver, a hash is malformed, or any risk invariant is violated.
    pub fn record_rebalance(&mut self, rebalance: RebalanceInput) -> u32 {
        require!(env::predecessor_account_id() == self.solver, "only the registered solver can record rebalances");
        for (name, value) in [
            ("plan_hash", &rebalance.plan_hash),
            ("intent_payload_hash", &rebalance.intent_payload_hash),
            ("attestation_report_hash", &rebalance.attestation_report_hash),
            ("decision_hash", &rebalance.decision_hash),
        ] {
            require!(is_sha256_hex(value), format!("{} must be 64 lowercase hex chars", name));
        }
        let violations = evaluate(&self.policy, rebalance.net_delta_bps, rebalance.leverage_x100, rebalance.slippage_bps);
        if !violations.is_empty() {
            env::panic_str(&format!("ZERODELTA_REJECTED: {}", violations.join("; ")));
        }
        let index = self.attestations.len();
        let record = Attestation {
            index,
            run_id: rebalance.run_id,
            pair: rebalance.pair,
            treasury_usd: rebalance.treasury_usd,
            net_delta_bps: rebalance.net_delta_bps,
            leverage_x100: rebalance.leverage_x100,
            slippage_bps: rebalance.slippage_bps,
            plan_hash: rebalance.plan_hash,
            intent_payload_hash: rebalance.intent_payload_hash,
            attestation_report_hash: rebalance.attestation_report_hash,
            decision_hash: rebalance.decision_hash,
            recorded_by: env::predecessor_account_id(),
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
        };
        emit(
            "rebalance_recorded",
            format!(
                "{{\"index\":{},\"decision_hash\":\"{}\",\"net_delta_bps\":{},\"leverage_x100\":{},\"slippage_bps\":{}}}",
                index, record.decision_hash, record.net_delta_bps, record.leverage_x100, record.slippage_bps
            ),
        );
        self.attestations.push(record);
        index
    }

    // ---- views ---------------------------------------------------------------

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_config(&self) -> (AccountId, AccountId, Policy) {
        (self.owner.clone(), self.solver.clone(), self.policy.clone())
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

    /// Free, read-only version of the on-chain policy check.
    pub fn check_rebalance(&self, net_delta_bps: u32, leverage_x100: u32, slippage_bps: u32) -> CheckResult {
        let violations = evaluate(&self.policy, net_delta_bps, leverage_x100, slippage_bps);
        CheckResult { approved: violations.is_empty(), violations }
    }
}
