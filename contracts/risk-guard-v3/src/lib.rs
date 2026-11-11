//! ZeroDelta Risk Guard v3 — NEAR smart contract.
//!
//! v2 (`contracts/risk-guard`, deployed and locked) signs a ZeroDelta *order commitment*.
//! v3 makes the MPC signature an *executable Hyperliquid order signature*:
//!
//! 1. **No trusted metrics.** As in v2, the solver submits raw legs in USD cents and the
//!    contract recomputes net delta, leverage and the slippage ceiling against an immutable policy.
//! 2. **The contract builds the order.** From the approved legs it builds the only order it will
//!    ever sign: one IOC **sell** (the perp short), not reduce-only, on the market index stored for
//!    the asset in the per-network table set at deploy time. Size = approved perp short notional /
//!    limit price, in whole lots (exact integer math). The solver chooses the limit price and a
//!    reference price; the limit must be within `price_band_bps` of the reference and obey
//!    Hyperliquid's price rules, and size × limit must stay within `notional_band_bps` of the approved notional.
//! 3. **The contract computes the digest.** It msgpack-encodes that action, computes
//!    `connectionId = keccak256(msgpack(action) || nonce || 0x00)` and the EIP-712 phantom-agent
//!    digest itself. **It never accepts a digest or payload from the solver.** A solver may pass
//!    `expected_digest_hex` only as an assertion; if it differs from the contract's digest the
//!    request is rejected (`PAYLOAD_COMMITMENT_MISMATCH`). The value sent to the MPC signer is always
//!    the contract's own digest.
//! 4. **Commitment.** The attestation stores `keccak256` of the contract's own binding
//!    `order legs -> built action -> nonce -> digest` (see [`commitment_preimage`]).
//! 5. **Nonce = Hyperliquid nonce (milliseconds).** `last_nonce < nonce`,
//!    `nonce >= block_ms - max_nonce_age_ms` and `nonce <= block_ms + max_nonce_future_ms`, with
//!    `block_ms = block_timestamp_ns / 1_000_000`. This also fixes v2 finding F-1 (a `u64::MAX`
//!    nonce can no longer freeze the contract). v2 nonces were microseconds (`Date.now() * 1000`).
//! 6. **Storage is paid by the caller.** Each accepted request must attach the storage cost of its
//!    attestation (plus room for the signature) and the MPC deposit; any excess is refunded. This
//!    fixes v2 finding F-2 (the contract's own balance can no longer be drained by valid orders).
//! 7. **Guard-gated MPC.** Only after every check passes does the contract call
//!    `v1.signer-prod.testnet.sign` with the digest. The callback stores `{big_r, s, recovery_id}`
//!    and the Hyperliquid-shaped `{r, s, v = recovery_id + 27}`.
//!
//! Trusted input disclosed: `reference_px_e8` comes from the solver. A compromised solver can move
//! both prices together, so the band limits how far the limit can sit from the solver's own
//! reference, not from the true market. Size always follows the approved notional, so a bad price
//! cannot inflate the position; at worst an IOC sell fills at a worse price or not at all.
//!
//! Any violation panics with `ZERODELTA_REJECTED: ...`; the receipt reverts and no MPC receipt is created.

pub mod hl;

use hl::{OrderWire, Tif};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::Vector;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

pub const EVENT_STANDARD: &str = "zerodelta";
pub const EVENT_VERSION: &str = "3.0.0";
/// Domain-separation tag of the v3 commitment preimage.
pub const COMMITMENT_DOMAIN: &str = "zerodelta-hl-hedge-v3";
pub const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
pub const DEFAULT_MPC_PATH: &str = "zerodelta/hedge/hyperliquid";
/// Bytes reserved per attestation for the signature the callback writes later.
pub const SIGNATURE_STORAGE_ALLOWANCE: u64 = 384;
const ONE_DAY_MS: u64 = 86_400_000;

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
    /// Maximum |limit − reference| / reference, in basis points.
    pub price_band_bps: u32,
    /// Maximum (approved perp short − size × limit) / approved perp short, in basis points.
    pub notional_band_bps: u32,
    /// Oldest accepted nonce relative to block time, in ms.
    pub max_nonce_age_ms: u64,
    /// Furthest-future accepted nonce relative to block time, in ms.
    pub max_nonce_future_ms: u64,
}

/// One perp market of the target Hyperliquid network (from `info {"type":"meta"}`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Market {
    pub symbol: String,
    pub asset: u32,
    pub sz_decimals: u8,
}

/// Raw order legs, as in v2. USD amounts are integer cents. `nonce` is the Hyperliquid nonce (ms).
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
pub struct HedgeRequest {
    pub run_id: String,
    pub order: OrderParams,
    /// Limit price of the IOC sell, in units of 1e-8 USD.
    pub limit_px_e8: u64,
    /// Trusted (solver-supplied) reference price that anchors the band, in units of 1e-8 USD.
    pub reference_px_e8: u64,
    /// Optional assertion only: if present it must equal the digest the contract computes.
    /// The contract never signs a supplied digest.
    pub expected_digest_hex: Option<String>,
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

/// The `{r, s, v}` shape Hyperliquid's `/exchange` expects.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HlSignature {
    pub r: String,
    pub s: String,
    pub v: u8,
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
    pub market: Market,
    pub hl_network: String,
    pub limit_px_e8: u64,
    pub reference_px_e8: u64,
    pub size_e8: u64,
    pub net_delta_bps: u64,
    pub leverage_x100: u64,
    /// The exact action JSON to POST to `/exchange` with `nonce` and the signature.
    pub action_json: String,
    pub connection_id_hex: String,
    pub digest_hex: String,
    pub commitment_hex: String,
    pub plan_hash: String,
    pub intent_payload_hash: String,
    pub attestation_report_hash: String,
    pub decision_hash: String,
    pub recorded_by: AccountId,
    pub block_height: u64,
    pub timestamp_ns: u64,
    pub mpc_status: MpcStatus,
    pub mpc_signature: Option<MpcSignature>,
    pub hl_signature: Option<HlSignature>,
}

/// Result of evaluating a request (also returned by the free view `preview_executable_hedge`).
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct HedgeEvaluation {
    pub approved: bool,
    pub net_delta_bps: u64,
    pub leverage_x100: u64,
    pub slippage_bps: u32,
    pub market: Option<Market>,
    pub hl_network: String,
    pub size_e8: u64,
    pub price_deviation_bps: u64,
    pub notional_drift_bps: u64,
    pub action_json: String,
    pub connection_id_hex: String,
    pub digest_hex: String,
    pub commitment_hex: String,
    pub block_time_ms: u64,
    pub violations: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub solver: AccountId,
    pub policy: Policy,
    pub hl_network: String,
    pub markets: Vec<Market>,
    pub markets_fetched_at: String,
    pub mpc_signer_contract: AccountId,
    pub mpc_path: String,
    pub mpc_deposit: U128,
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
pub struct RiskGuardV3 {
    solver: AccountId,
    policy: Policy,
    hl_network: String,
    markets: Vec<Market>,
    markets_fetched_at: String,
    mpc_signer_contract: AccountId,
    mpc_path: String,
    mpc_deposit: u128,
    last_nonce: u64,
    attestations: Vector<Attestation>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

pub fn to_hex(bytes: &[u8]) -> String {
    hl::hex(bytes)
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_valid_symbol(s: &str) -> bool {
    (2..=10).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn ceil_div(num: u128, den: u128) -> u64 {
    let q = (num + den - 1) / den;
    q.min(u64::MAX as u128) as u64
}

/// `ceil(|spot + perp_long − perp_short| × 10 000 / treasury)` (same as v2).
pub fn compute_net_delta_bps(o: &OrderParams) -> u64 {
    let long = o.spot_long_usd_cents as u128 + o.perp_long_usd_cents as u128;
    let short = o.perp_short_usd_cents as u128;
    let diff = if long > short { long - short } else { short - long };
    ceil_div(diff * 10_000, o.treasury_usd_cents.max(1) as u128)
}

/// `ceil((spot + perp_short + perp_long) × 100 / collateral)` (same as v2).
pub fn compute_leverage_x100(o: &OrderParams) -> u64 {
    let gross = o.spot_long_usd_cents as u128 + o.perp_short_usd_cents as u128 + o.perp_long_usd_cents as u128;
    ceil_div(gross * 100, o.collateral_usd_cents.max(1) as u128)
}

/// Builds the one order v3 will sign: an IOC sell of the approved perp short, not reduce-only.
pub fn hedge_order(market: &Market, limit_px_e8: u64, size_e8: u64) -> OrderWire {
    OrderWire { asset: market.asset, is_buy: false, px_e8: limit_px_e8, sz_e8: size_e8, reduce_only: false, tif: Tif::Ioc }
}

/// Canonical, pipe-delimited binding of the approved legs to the action and digest the contract built.
#[allow(clippy::too_many_arguments)]
pub fn commitment_preimage(contract_id: &str, hl_network: &str, o: &OrderParams, market: &Market, limit_px_e8: u64, reference_px_e8: u64, size_e8: u64, digest_hex: &str) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        COMMITMENT_DOMAIN,
        contract_id,
        hl_network,
        o.asset_symbol,
        market.asset,
        o.treasury_usd_cents,
        o.spot_long_usd_cents,
        o.perp_short_usd_cents,
        o.perp_long_usd_cents,
        o.collateral_usd_cents,
        o.quoted_slippage_bps,
        limit_px_e8,
        reference_px_e8,
        size_e8,
        o.nonce,
        digest_hex
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

fn bad_config(msg: &str) -> ! {
    env::panic_str(&format!("INVALID_CONFIG: {}", msg))
}

/// `r` for Hyperliquid is the x-coordinate of the compressed `big_r` (`02|03` + 32 bytes).
pub fn hl_signature_from_mpc(sig: &MpcSignature) -> Option<HlSignature> {
    let ok_hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    if sig.big_r.len() != 66 || !(sig.big_r.starts_with("02") || sig.big_r.starts_with("03")) || !ok_hex(&sig.big_r) {
        return None;
    }
    if sig.s.len() != 64 || !ok_hex(&sig.s) || sig.recovery_id > 1 {
        return None;
    }
    Some(HlSignature { r: format!("0x{}", sig.big_r[2..].to_lowercase()), s: format!("0x{}", sig.s.to_lowercase()), v: sig.recovery_id + 27 })
}

#[near]
impl RiskGuardV3 {
    /// Deploy-time initialisation. Policy, solver, market table, network and MPC target are immutable afterwards.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        solver: AccountId,
        policy: Policy,
        hl_network: String,
        markets: Vec<Market>,
        markets_fetched_at: String,
        mpc_signer_contract: Option<AccountId>,
        mpc_path: Option<String>,
        mpc_deposit: Option<U128>,
    ) -> Self {
        if policy.max_delta_bps > 10_000 {
            bad_config("max_delta_bps must be <= 10000");
        }
        if policy.max_leverage_x100 < 100 {
            bad_config("max_leverage_x100 must be >= 100");
        }
        if policy.max_slippage_bps > 10_000 || policy.price_band_bps > 10_000 || policy.notional_band_bps > 10_000 {
            bad_config("bps limits must be <= 10000");
        }
        if policy.price_band_bps == 0 {
            bad_config("price_band_bps must be > 0");
        }
        if policy.max_nonce_age_ms == 0 || policy.max_nonce_age_ms > ONE_DAY_MS || policy.max_nonce_future_ms > ONE_DAY_MS {
            bad_config("nonce windows must be within 1 day (age > 0)");
        }
        if hl_network != "testnet" && hl_network != "mainnet" {
            bad_config("hl_network must be \"testnet\" or \"mainnet\"");
        }
        if markets.is_empty() || markets.len() > 32 {
            bad_config("markets must have 1-32 entries");
        }
        for (i, m) in markets.iter().enumerate() {
            if !is_valid_symbol(&m.symbol) {
                bad_config("market symbol must be 2-10 chars A-Z0-9");
            }
            if m.sz_decimals > hl::MAX_PERP_DECIMALS {
                bad_config("sz_decimals must be <= 6 for perps");
            }
            if markets[..i].iter().any(|p| p.symbol == m.symbol || p.asset == m.asset) {
                bad_config("duplicate market symbol or asset index");
            }
        }
        if markets_fetched_at.is_empty() || markets_fetched_at.len() > 64 {
            bad_config("markets_fetched_at must be 1-64 chars");
        }
        let mpc_signer_contract = mpc_signer_contract.unwrap_or_else(|| DEFAULT_MPC_SIGNER.parse().unwrap());
        let mpc_path = mpc_path.unwrap_or_else(|| DEFAULT_MPC_PATH.to_string());
        let mpc_deposit = mpc_deposit.map(|d| d.0).unwrap_or(1);
        if mpc_deposit == 0 {
            bad_config("mpc_deposit must be >= 1 yoctoNEAR");
        }
        let market_list: Vec<String> = markets.iter().map(|m| format!("{{\"symbol\":\"{}\",\"asset\":{},\"sz_decimals\":{}}}", m.symbol, m.asset, m.sz_decimals)).collect();
        emit(
            "policy_registered",
            format!(
                "{{\"contract\":\"{}\",\"solver\":\"{}\",\"max_delta_bps\":{},\"max_leverage_x100\":{},\"max_slippage_bps\":{},\"price_band_bps\":{},\"notional_band_bps\":{},\"max_nonce_age_ms\":{},\"max_nonce_future_ms\":{},\"hl_network\":\"{}\",\"markets\":[{}],\"markets_fetched_at\":\"{}\",\"mpc_signer_contract\":\"{}\",\"mpc_path\":\"{}\"}}",
                env::current_account_id(),
                solver,
                policy.max_delta_bps,
                policy.max_leverage_x100,
                policy.max_slippage_bps,
                policy.price_band_bps,
                policy.notional_band_bps,
                policy.max_nonce_age_ms,
                policy.max_nonce_future_ms,
                hl_network,
                market_list.join(","),
                markets_fetched_at,
                mpc_signer_contract,
                mpc_path
            ),
        );
        Self {
            solver,
            policy,
            hl_network,
            markets,
            markets_fetched_at,
            mpc_signer_contract,
            mpc_path,
            mpc_deposit,
            last_nonce: 0,
            attestations: Vector::new(b"a"),
        }
    }

    fn evaluate(&self, req: &HedgeRequest) -> HedgeEvaluation {
        let o = &req.order;
        let mut v: Vec<String> = Vec::new();
        let block_time_ms = env::block_timestamp() / 1_000_000;

        // --- order shape and market --------------------------------------------------
        let market = if is_valid_symbol(&o.asset_symbol) {
            let m = self.markets.iter().find(|m| m.symbol == o.asset_symbol).cloned();
            if m.is_none() {
                v.push(format!("UNKNOWN_MARKET: {} is not in the {} market table", o.asset_symbol, self.hl_network));
            }
            m
        } else {
            v.push("INVALID_ORDER: asset_symbol must be 2-10 chars A-Z0-9".to_string());
            None
        };
        if o.treasury_usd_cents == 0 {
            v.push("INVALID_ORDER: treasury_usd_cents must be > 0".to_string());
        }
        if o.collateral_usd_cents == 0 {
            v.push("INVALID_ORDER: collateral_usd_cents must be > 0".to_string());
        }
        if o.collateral_usd_cents > o.treasury_usd_cents {
            v.push("INVALID_ORDER: collateral exceeds treasury".to_string());
        }
        if o.perp_short_usd_cents == 0 {
            v.push("INVALID_ORDER: perp_short_usd_cents must be > 0 (nothing to hedge)".to_string());
        }
        if o.perp_long_usd_cents != 0 {
            v.push("INVALID_ORDER: a perp long leg cannot be executed by the hedge order".to_string());
        }

        // --- risk (same math as v2) --------------------------------------------------
        let net_delta_bps = compute_net_delta_bps(o);
        let leverage_x100 = compute_leverage_x100(o);
        if net_delta_bps > self.policy.max_delta_bps {
            v.push(format!("DELTA_NEUTRALITY: {} bps > {} bps", net_delta_bps, self.policy.max_delta_bps));
        }
        if leverage_x100 > self.policy.max_leverage_x100 {
            v.push(format!("LEVERAGE_CEILING: {} > {} (x100)", leverage_x100, self.policy.max_leverage_x100));
        }
        if o.quoted_slippage_bps > self.policy.max_slippage_bps {
            v.push(format!("SLIPPAGE_CEILING: {} bps > {} bps", o.quoted_slippage_bps, self.policy.max_slippage_bps));
        }

        // --- prices ------------------------------------------------------------------
        let p = req.limit_px_e8;
        let r = req.reference_px_e8;
        let mut price_deviation_bps = 0;
        if r == 0 {
            v.push("NO_REFERENCE_PRICE: reference_px_e8 must be > 0".to_string());
        } else if p > 0 {
            let dev = (p as i128 - r as i128).unsigned_abs();
            price_deviation_bps = ceil_div(dev * 10_000, r as u128);
            if dev * 10_000 > (self.policy.price_band_bps as u128) * (r as u128) {
                v.push(format!("PRICE_OUT_OF_BAND: limit {} is {} bps from reference {} (> {} bps)", hl::wire_e8(p), price_deviation_bps, hl::wire_e8(r), self.policy.price_band_bps));
            }
        }
        let mut price_ok = false;
        if let Some(m) = &market {
            match hl::check_perp_price(p, m.sz_decimals) {
                Ok(()) => price_ok = true,
                Err(e) => v.push(e),
            }
        } else if p == 0 {
            v.push("PRICE_ZERO".to_string());
        }

        // --- size from the LIMIT price, and the notional it really commits to -------
        let mut size_e8 = 0;
        let mut notional_drift_bps = 0;
        let mut size_ok = false;
        if let (Some(m), true, true) = (&market, price_ok, o.perp_short_usd_cents > 0) {
            match hl::size_lots(o.perp_short_usd_cents, p, m.sz_decimals).and_then(|lots| hl::lots_to_e8(lots, m.sz_decimals).map(|e8| (lots, e8))) {
                Err(e) => v.push(e),
                Ok((0, _)) => v.push(format!("SIZE_ZERO: {} cents buys less than one lot at {}", o.perp_short_usd_cents, hl::wire_e8(p))),
                Ok((lots, e8)) => {
                    size_e8 = e8;
                    size_ok = true;
                    // approved and executable notional in the same units: cents × 10^szd × 1e6 == lots × px_e8
                    let approved = (o.perp_short_usd_cents as u128) * 10u128.pow(m.sz_decimals as u32) * 1_000_000;
                    let executable = (lots as u128) * (p as u128);
                    let drift = approved.abs_diff(executable);
                    notional_drift_bps = ceil_div(drift * 10_000, approved);
                    if drift * 10_000 > (self.policy.notional_band_bps as u128) * approved {
                        v.push(format!("NOTIONAL_DRIFT: size x limit is {} bps from the approved perp short (> {} bps)", notional_drift_bps, self.policy.notional_band_bps));
                    }
                }
            }
        }

        // --- nonce: Hyperliquid ms timestamp ------------------------------------------
        if o.nonce <= self.last_nonce {
            v.push(format!("NONCE_ALREADY_USED: nonce {} <= last accepted {}", o.nonce, self.last_nonce));
        }
        if o.nonce > block_time_ms.saturating_add(self.policy.max_nonce_future_ms) {
            v.push(format!("FUTURE_NONCE: nonce {} ms > block time {} ms + {} ms", o.nonce, block_time_ms, self.policy.max_nonce_future_ms));
        }
        if o.nonce < block_time_ms.saturating_sub(self.policy.max_nonce_age_ms) {
            v.push(format!("STALE_ORDER: nonce {} ms < block time {} ms - {} ms", o.nonce, block_time_ms, self.policy.max_nonce_age_ms));
        }

        // --- build the action and digest ON-CHAIN --------------------------------------
        let (mut action_json, mut connection_id_hex, mut digest_hex, mut commitment_hex) = (String::new(), String::new(), String::new(), String::new());
        if let (Some(m), true) = (&market, size_ok) {
            let orders = [hedge_order(m, p, size_e8)];
            let packed = hl::to_msgpack(&hl::order_action(&orders));
            let conn = hl::connection_id(&packed, o.nonce);
            let digest = hl::l1_digest(&conn, self.hl_network == "mainnet");
            action_json = hl::order_action_json(&orders);
            connection_id_hex = to_hex(&conn);
            digest_hex = to_hex(&digest);
            let pre = commitment_preimage(env::current_account_id().as_str(), &self.hl_network, o, m, p, r, size_e8, &digest_hex);
            commitment_hex = to_hex(&env::keccak256(pre.as_bytes()));
        }
        if let Some(expected) = &req.expected_digest_hex {
            if !is_sha256_hex(expected) {
                v.push("MALFORMED_HASH: expected_digest_hex must be 64 lowercase hex chars".to_string());
            } else if digest_hex.is_empty() || *expected != digest_hex {
                v.push(format!("PAYLOAD_COMMITMENT_MISMATCH: contract digest {} != expected {}", if digest_hex.is_empty() { "(not built)" } else { &digest_hex }, expected));
            }
        }

        HedgeEvaluation {
            approved: v.is_empty(),
            net_delta_bps,
            leverage_x100,
            slippage_bps: o.quoted_slippage_bps,
            market,
            hl_network: self.hl_network.clone(),
            size_e8,
            price_deviation_bps,
            notional_drift_bps,
            action_json,
            connection_id_hex,
            digest_hex,
            commitment_hex,
            block_time_ms,
            violations: v,
        }
    }

    /// Verifies the request, builds the executable Hyperliquid order and its EIP-712 digest
    /// on-chain, records the attestation, and (if requested) has this contract ask the MPC
    /// network to sign that digest. Panics with `ZERODELTA_REJECTED: ...` otherwise.
    ///
    /// Attach the attestation's storage cost (plus `SIGNATURE_STORAGE_ALLOWANCE` bytes) and, when
    /// `request_mpc_sign`, the MPC deposit; ~0.05 NEAR is plenty. The excess is refunded.
    #[payable]
    pub fn sign_executable_hedge(&mut self, request: HedgeRequest, request_mpc_sign: Option<bool>) -> PromiseOrValue<u32> {
        let caller = env::predecessor_account_id();
        if caller != self.solver {
            reject(&format!("UNAUTHORIZED_SOLVER: {} is not the registered solver", caller));
        }
        for (name, value) in [
            ("plan_hash", &request.plan_hash),
            ("intent_payload_hash", &request.intent_payload_hash),
            ("attestation_report_hash", &request.attestation_report_hash),
            ("decision_hash", &request.decision_hash),
        ] {
            if !is_sha256_hex(value) {
                reject(&format!("MALFORMED_HASH: {} must be 64 lowercase hex chars", name));
            }
        }
        if request.run_id.len() > 64 {
            reject("INVALID_ORDER: run_id must be <= 64 chars");
        }
        let eval = self.evaluate(&request);
        if !eval.approved {
            reject(&eval.violations.join("; "));
        }
        let market = eval.market.clone().expect("approved implies market");
        let sign = request_mpc_sign.unwrap_or(false);
        let limit_px_e8 = request.limit_px_e8;

        self.last_nonce = request.order.nonce;
        let index = self.attestations.len();
        let record = Attestation {
            index,
            run_id: request.run_id,
            order: request.order,
            market,
            hl_network: self.hl_network.clone(),
            limit_px_e8: request.limit_px_e8,
            reference_px_e8: request.reference_px_e8,
            size_e8: eval.size_e8,
            net_delta_bps: eval.net_delta_bps,
            leverage_x100: eval.leverage_x100,
            action_json: eval.action_json.clone(),
            connection_id_hex: eval.connection_id_hex.clone(),
            digest_hex: eval.digest_hex.clone(),
            commitment_hex: eval.commitment_hex.clone(),
            plan_hash: request.plan_hash,
            intent_payload_hash: request.intent_payload_hash,
            attestation_report_hash: request.attestation_report_hash,
            decision_hash: request.decision_hash,
            recorded_by: caller.clone(),
            block_height: env::block_height(),
            timestamp_ns: env::block_timestamp(),
            mpc_status: if sign { MpcStatus::Pending } else { MpcStatus::NotRequested },
            mpc_signature: None,
            hl_signature: None,
        };

        // F-2: the caller pays for the storage it adds (plus room for the signature).
        let before = env::storage_usage();
        self.attestations.push(record);
        self.attestations.flush();
        let added = env::storage_usage().saturating_sub(before) + if sign { SIGNATURE_STORAGE_ALLOWANCE } else { 0 };
        let storage_cost = env::storage_byte_cost().saturating_mul(added as u128);
        let mpc_deposit = if sign { NearToken::from_yoctonear(self.mpc_deposit) } else { NearToken::from_yoctonear(0) };
        let required = storage_cost.saturating_add(mpc_deposit);
        let attached = env::attached_deposit();
        if attached < required {
            reject(&format!("INSUFFICIENT_DEPOSIT: attach at least {} yoctoNEAR (storage {} bytes{})", required.as_yoctonear(), added, if sign { " + MPC deposit" } else { "" }));
        }

        emit(
            "hedge_attested",
            format!(
                "{{\"index\":{},\"nonce\":{},\"asset\":{},\"net_delta_bps\":{},\"leverage_x100\":{},\"size\":\"{}\",\"limit_px\":\"{}\",\"digest\":\"{}\",\"commitment\":\"{}\",\"storage_bytes\":{},\"mpc_requested\":{}}}",
                index,
                self.last_nonce,
                eval.market.as_ref().map(|m| m.asset).unwrap_or(0),
                eval.net_delta_bps,
                eval.leverage_x100,
                hl::wire_e8(eval.size_e8),
                hl::wire_e8(limit_px_e8),
                eval.digest_hex,
                eval.commitment_hex,
                added,
                sign
            ),
        );

        let refund = attached.saturating_sub(required);
        if !sign {
            if !refund.is_zero() {
                Promise::new(caller).transfer(refund);
            }
            return PromiseOrValue::Value(index);
        }
        let used = env::used_gas().as_gas() + CALLBACK_GAS.as_gas() + GAS_RESERVE.as_gas();
        let sign_gas = Gas::from_gas(env::prepaid_gas().as_gas().saturating_sub(used));
        if sign_gas < MIN_SIGN_GAS {
            reject("INSUFFICIENT_GAS: attach ~300 Tgas when request_mpc_sign is true");
        }
        if !refund.is_zero() {
            Promise::new(caller).transfer(refund);
        }
        // The payload is the digest computed above from the contract-built action. Never solver input.
        let args = near_sdk::serde_json::json!({
            "request": { "payload_v2": { "Ecdsa": eval.digest_hex }, "path": self.mpc_path, "domain_id": 0 }
        });
        emit("mpc_sign_requested", format!("{{\"index\":{},\"mpc\":\"{}\",\"digest\":\"{}\"}}", index, self.mpc_signer_contract, eval.digest_hex));
        let promise = Promise::new(self.mpc_signer_contract.clone())
            .function_call("sign".to_string(), args.to_string().into_bytes(), mpc_deposit, sign_gas)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_mpc_signed(index));
        PromiseOrValue::Promise(promise)
    }

    /// Callback from the MPC contract: stores the raw signature and the Hyperliquid `{r, s, v}`.
    #[private]
    pub fn on_mpc_signed(&mut self, index: u32, #[callback_result] result: Result<RawMpcSignature, PromiseError>) -> Option<HlSignature> {
        let raw = result.ok().map(|r| MpcSignature { big_r: r.big_r.affine_point, s: r.s.scalar, recovery_id: r.recovery_id });
        let hl_sig = raw.as_ref().and_then(hl_signature_from_mpc);
        if let Some(att) = self.attestations.get_mut(index) {
            att.mpc_status = if hl_sig.is_some() { MpcStatus::Signed } else { MpcStatus::Failed };
            att.mpc_signature = raw;
            att.hl_signature = hl_sig.clone();
        }
        emit(
            "mpc_signed",
            match &hl_sig {
                Some(s) => format!("{{\"index\":{},\"ok\":true,\"r\":\"{}\",\"s\":\"{}\",\"v\":{}}}", index, s.r, s.s, s.v),
                None => format!("{{\"index\":{},\"ok\":false}}", index),
            },
        );
        hl_sig
    }

    // ---- views ---------------------------------------------------------------

    /// Free, read-only run of every check, returning the action, digest and commitment the
    /// contract would sign. Uses the current block time for the nonce window.
    pub fn preview_executable_hedge(&self, request: HedgeRequest) -> HedgeEvaluation {
        self.evaluate(&request)
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_markets(&self) -> Vec<Market> {
        self.markets.clone()
    }

    pub fn get_config(&self) -> Config {
        Config {
            solver: self.solver.clone(),
            policy: self.policy.clone(),
            hl_network: self.hl_network.clone(),
            markets: self.markets.clone(),
            markets_fetched_at: self.markets_fetched_at.clone(),
            mpc_signer_contract: self.mpc_signer_contract.clone(),
            mpc_path: self.mpc_path.clone(),
            mpc_deposit: U128(self.mpc_deposit),
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
