//! Hyperliquid L1 order encoding and EIP-712 signing digest, integer-only.
//!
//! Mirrors `src/lib/hyperliquid/exchangeSigning.ts`, which reproduces the official
//! hyperliquid-python-sdk vectors (`hyperliquid/utils/signing.py`):
//!
//! * `wire_e8`        <- `floatToWire` / SDK `float_to_wire` (8-decimal fixed point, trailing zeros stripped)
//! * `order_action_msgpack` <- `orderWire` + `orderAction` + `@msgpack/msgpack` `encode`
//! * `connection_id`  <- `actionHash` (no vault, no expiresAfter)
//! * `l1_digest`      <- `l1SigningDigest` (phantom agent, EIP-712 domain "Exchange"/"1"/1337/0x0)
//!
//! No floating point is used: prices and sizes are integers in units of 1e-8 (`*_e8`),
//! the same 8 decimals `float_to_wire` rounds to, so formatting is exact by construction.

use near_sdk::env;

/// 1e8: values are integers in units of 1e-8, the precision of the SDK's `float_to_wire`.
pub const E8: u64 = 100_000_000;
/// Hyperliquid perp prices may have at most `MAX_PERP_DECIMALS - szDecimals` decimals.
pub const MAX_PERP_DECIMALS: u8 = 6;
/// Non-integer prices may have at most 5 significant figures.
pub const MAX_PRICE_SIG_FIGS: u32 = 5;
/// `@msgpack/msgpack` encodes integers above 2^53 - 1 as float64; we never emit those.
pub const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;

const EIP712_DOMAIN_TYPE: &[u8] = b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const AGENT_TYPE: &[u8] = b"Agent(string source,bytes32 connectionId)";
const L1_CHAIN_ID: u64 = 1337;

fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/// SDK `float_to_wire` for a value given in units of 1e-8: no exponent, no trailing zeros.
pub fn wire_e8(v: u64) -> String {
    let int = v / E8;
    let frac = v % E8;
    if frac == 0 {
        return int.to_string();
    }
    let mut f = format!("{:08}", frac);
    while f.ends_with('0') {
        f.pop();
    }
    format!("{}.{}", int, f)
}

/// Number of decimals of an e8 value after trailing zeros are stripped (0..=8).
pub fn decimals_e8(v: u64) -> u32 {
    let mut frac = v % E8;
    if frac == 0 {
        return 0;
    }
    let mut d = 8;
    while frac % 10 == 0 {
        frac /= 10;
        d -= 1;
    }
    d
}

/// Significant figures of an e8 value as Hyperliquid counts them (integer digits + decimals,
/// or decimals without leading zeros when the integer part is 0).
pub fn sig_figs_e8(v: u64) -> u32 {
    let int = v / E8;
    let dec = decimals_e8(v);
    if int > 0 {
        int.to_string().len() as u32 + dec
    } else {
        // value = frac / 10^8; significant digits = digits of the stripped fraction
        let mut frac = v % E8;
        while frac != 0 && frac % 10 == 0 {
            frac /= 10;
        }
        if frac == 0 {
            0
        } else {
            frac.to_string().len() as u32
        }
    }
}

/// Hyperliquid perp price rules: integer prices are always valid; otherwise at most
/// 5 significant figures and at most `6 - szDecimals` decimals.
pub fn check_perp_price(px_e8: u64, sz_decimals: u8) -> Result<(), String> {
    if px_e8 == 0 {
        return Err("PRICE_ZERO".into());
    }
    if sz_decimals > MAX_PERP_DECIMALS {
        return Err(format!("SZ_DECIMALS_TOO_LARGE: {}", sz_decimals));
    }
    if px_e8 % E8 == 0 {
        return Ok(());
    }
    let max_dec = (MAX_PERP_DECIMALS - sz_decimals) as u32;
    let dec = decimals_e8(px_e8);
    if dec > max_dec {
        return Err(format!("PRICE_TOO_MANY_DECIMALS: {} has {} > {} decimals", wire_e8(px_e8), dec, max_dec));
    }
    let sf = sig_figs_e8(px_e8);
    if sf > MAX_PRICE_SIG_FIGS {
        return Err(format!("PRICE_TOO_MANY_SIG_FIGS: {} has {} > {} significant figures", wire_e8(px_e8), sf, MAX_PRICE_SIG_FIGS));
    }
    Ok(())
}

fn pow10(n: u32) -> u128 {
    10u128.pow(n)
}

/// Whole lots (1 lot = 10^-szDecimals) for a USD-cent notional at a price: floor(notional / px).
pub fn size_lots(notional_usd_cents: u64, px_e8: u64, sz_decimals: u8) -> Result<u64, String> {
    if px_e8 == 0 {
        return Err("PRICE_ZERO".into());
    }
    if sz_decimals > 8 {
        return Err(format!("SZ_DECIMALS_TOO_LARGE: {}", sz_decimals));
    }
    // lots = cents/100 / (px_e8/1e8) * 10^szd = cents * 10^szd * 10^6 / px_e8
    let num = (notional_usd_cents as u128) * pow10(sz_decimals as u32) * 1_000_000u128;
    let lots = num / (px_e8 as u128);
    u64::try_from(lots).map_err(|_| "SIZE_OVERFLOW".to_string())
}

/// Converts whole lots to e8 units.
pub fn lots_to_e8(lots: u64, sz_decimals: u8) -> Result<u64, String> {
    if sz_decimals > 8 {
        return Err(format!("SZ_DECIMALS_TOO_LARGE: {}", sz_decimals));
    }
    let v = (lots as u128) * pow10(8 - sz_decimals as u32);
    u64::try_from(v).map_err(|_| "SIZE_OVERFLOW".to_string())
}

// ---------------------------------------------------------------------------
// Minimal msgpack encoder matching @msgpack/msgpack 3.x defaults
// ---------------------------------------------------------------------------

/// The subset of msgpack values that Hyperliquid order actions use. Maps keep insertion order.
#[derive(Clone, Debug, PartialEq)]
pub enum Mp {
    Nil,
    Bool(bool),
    UInt(u64),
    Str(String),
    Arr(Vec<Mp>),
    Map(Vec<(String, Mp)>),
}

impl Mp {
    pub fn str(s: &str) -> Mp {
        Mp::Str(s.to_string())
    }
    pub fn map(entries: Vec<(&str, Mp)>) -> Mp {
        Mp::Map(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
}

fn write_len(out: &mut Vec<u8>, len: usize, fix_base: u8, fix_max: usize, tag16: u8, tag32: u8, tag8: Option<u8>) {
    if len < fix_max {
        out.push(fix_base + len as u8);
    } else if tag8.is_some() && len < 0x100 {
        out.push(tag8.unwrap());
        out.push(len as u8);
    } else if len < 0x1_0000 {
        out.push(tag16);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        assert!(len <= u32::MAX as usize, "MSGPACK_TOO_LARGE");
        out.push(tag32);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
}

fn encode_str(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    // fixstr < 32, str8 < 256, str16, str32
    write_len(out, b.len(), 0xa0, 32, 0xda, 0xdb, Some(0xd9));
    out.extend_from_slice(b);
}

/// Encodes `v` with the same byte layout as `@msgpack/msgpack` `encode()` with default options.
pub fn encode(v: &Mp, out: &mut Vec<u8>) {
    match v {
        Mp::Nil => out.push(0xc0),
        Mp::Bool(false) => out.push(0xc2),
        Mp::Bool(true) => out.push(0xc3),
        Mp::UInt(n) => {
            let n = *n;
            // @msgpack/msgpack switches to float64 above Number.MAX_SAFE_INTEGER; refuse instead.
            assert!(n <= MAX_SAFE_INTEGER, "MSGPACK_UINT_NOT_SAFE_INTEGER");
            if n < 0x80 {
                out.push(n as u8);
            } else if n < 0x100 {
                out.push(0xcc);
                out.push(n as u8);
            } else if n < 0x1_0000 {
                out.push(0xcd);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            } else if n < 0x1_0000_0000 {
                out.push(0xce);
                out.extend_from_slice(&(n as u32).to_be_bytes());
            } else {
                out.push(0xcf);
                out.extend_from_slice(&n.to_be_bytes());
            }
        }
        Mp::Str(s) => encode_str(out, s),
        Mp::Arr(items) => {
            write_len(out, items.len(), 0x90, 16, 0xdc, 0xdd, None);
            for i in items {
                encode(i, out);
            }
        }
        Mp::Map(entries) => {
            write_len(out, entries.len(), 0x80, 16, 0xde, 0xdf, None);
            for (k, val) in entries {
                encode_str(out, k);
                encode(val, out);
            }
        }
    }
}

pub fn to_msgpack(v: &Mp) -> Vec<u8> {
    let mut out = Vec::new();
    encode(v, &mut out);
    out
}

// ---------------------------------------------------------------------------
// Order action
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tif {
    Alo,
    Ioc,
    Gtc,
}

impl Tif {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tif::Alo => "Alo",
            Tif::Ioc => "Ioc",
            Tif::Gtc => "Gtc",
        }
    }
}

/// One order. Field order of the wire form is a, b, p, s, r, t (SDK `OrderWire`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderWire {
    pub asset: u32,
    pub is_buy: bool,
    pub px_e8: u64,
    pub sz_e8: u64,
    pub reduce_only: bool,
    pub tif: Tif,
}

impl OrderWire {
    pub fn to_mp(&self) -> Mp {
        Mp::map(vec![
            ("a", Mp::UInt(self.asset as u64)),
            ("b", Mp::Bool(self.is_buy)),
            ("p", Mp::Str(wire_e8(self.px_e8))),
            ("s", Mp::Str(wire_e8(self.sz_e8))),
            ("r", Mp::Bool(self.reduce_only)),
            ("t", Mp::map(vec![("limit", Mp::map(vec![("tif", Mp::str(self.tif.as_str()))]))])),
        ])
    }
}

/// `{"type": "order", "orders": [...], "grouping": "na"}` in that key order.
pub fn order_action(orders: &[OrderWire]) -> Mp {
    Mp::map(vec![
        ("type", Mp::str("order")),
        ("orders", Mp::Arr(orders.iter().map(|o| o.to_mp()).collect())),
        ("grouping", Mp::str("na")),
    ])
}

/// The same action as JSON, byte-for-byte what `JSON.stringify(orderAction(...))` produces.
pub fn order_action_json(orders: &[OrderWire]) -> String {
    let parts: Vec<String> = orders
        .iter()
        .map(|o| {
            format!(
                "{{\"a\":{},\"b\":{},\"p\":\"{}\",\"s\":\"{}\",\"r\":{},\"t\":{{\"limit\":{{\"tif\":\"{}\"}}}}}}",
                o.asset,
                o.is_buy,
                wire_e8(o.px_e8),
                wire_e8(o.sz_e8),
                o.reduce_only,
                o.tif.as_str()
            )
        })
        .collect();
    format!("{{\"type\":\"order\",\"orders\":[{}],\"grouping\":\"na\"}}", parts.join(","))
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// SDK `action_hash` with no vault and no expiresAfter:
/// keccak256(msgpack(action) || nonce_u64_be || 0x00).
pub fn connection_id(action_msgpack: &[u8], nonce: u64) -> [u8; 32] {
    let mut buf = Vec::with_capacity(action_msgpack.len() + 9);
    buf.extend_from_slice(action_msgpack);
    buf.extend_from_slice(&nonce.to_be_bytes());
    buf.push(0x00);
    keccak(&buf)
}

fn u256_be(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

/// EIP-712 domain separator for L1 actions: name "Exchange", version "1", chainId 1337, verifyingContract 0x0.
pub fn domain_separator() -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&keccak(EIP712_DOMAIN_TYPE));
    buf.extend_from_slice(&keccak(b"Exchange"));
    buf.extend_from_slice(&keccak(b"1"));
    buf.extend_from_slice(&u256_be(L1_CHAIN_ID));
    buf.extend_from_slice(&[0u8; 32]);
    keccak(&buf)
}

/// Phantom agent `{source: "a" | "b", connectionId}` hashed as EIP-712 typed data.
pub fn l1_digest(connection_id: &[u8; 32], is_mainnet: bool) -> [u8; 32] {
    let source: &[u8] = if is_mainnet { b"a" } else { b"b" };
    let mut s = Vec::with_capacity(96);
    s.extend_from_slice(&keccak(AGENT_TYPE));
    s.extend_from_slice(&keccak(source));
    s.extend_from_slice(connection_id);
    let struct_hash = keccak(&s);
    let mut d = Vec::with_capacity(66);
    d.extend_from_slice(&[0x19, 0x01]);
    d.extend_from_slice(&domain_separator());
    d.extend_from_slice(&struct_hash);
    keccak(&d)
}

/// The digest Hyperliquid expects a signature over for `orders` at `nonce`.
pub fn order_digest(orders: &[OrderWire], nonce: u64, is_mainnet: bool) -> [u8; 32] {
    let packed = to_msgpack(&order_action(orders));
    l1_digest(&connection_id(&packed, nonce), is_mainnet)
}

pub fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_formatting_matches_sdk_examples() {
        assert_eq!(wire_e8(100 * E8), "100");
        assert_eq!(wire_e8(167_010_000_000), "1670.1");
        assert_eq!(wire_e8(1_470_000), "0.0147");
        assert_eq!(wire_e8(0), "0");
        assert_eq!(wire_e8(1), "0.00000001");
    }

    fn px(s: &str) -> u64 {
        let (i, f) = s.split_once('.').unwrap_or((s, ""));
        let f = format!("{:0<8}", f);
        i.parse::<u64>().unwrap() * E8 + f.parse::<u64>().unwrap()
    }

    fn err(s: &str, szd: u8) -> String {
        check_perp_price(px(s), szd).unwrap_err()
    }

    #[test]
    fn price_rules() {
        // integer prices are always valid, whatever the significant figures
        assert!(check_perp_price(px("123456"), 5).is_ok());
        assert!(check_perp_price(px("74423"), 5).is_ok());
        // BTC, szDecimals 5: at most 1 decimal
        assert!(check_perp_price(px("7442.3"), 5).is_ok());
        assert!(err("7442.35", 5).starts_with("PRICE_TOO_MANY_DECIMALS"));
        assert!(err("74423.5", 5).starts_with("PRICE_TOO_MANY_SIG_FIGS"));
        // ETH, szDecimals 4: at most 2 decimals
        assert!(check_perp_price(px("1670.1"), 4).is_ok());
        assert!(err("1670.12", 4).starts_with("PRICE_TOO_MANY_SIG_FIGS"));
        assert!(err("1.123", 4).starts_with("PRICE_TOO_MANY_DECIMALS"));
        // SOL, szDecimals 2: at most 4 decimals
        assert!(check_perp_price(px("92.704"), 2).is_ok());
        assert!(check_perp_price(px("0.0001"), 2).is_ok());
        assert!(err("0.00001", 2).starts_with("PRICE_TOO_MANY_DECIMALS"));
        // NEAR, szDecimals 1: at most 5 decimals
        assert!(check_perp_price(px("3.7498"), 1).is_ok());
        assert!(err("3.74985", 1).starts_with("PRICE_TOO_MANY_SIG_FIGS"));
        assert!(err("0.000123", 1).starts_with("PRICE_TOO_MANY_DECIMALS"));
        assert!(check_perp_price(px("0.012345"), 0).is_ok());
        // zero and bad szDecimals
        assert_eq!(check_perp_price(0, 1).unwrap_err(), "PRICE_ZERO");
        assert!(check_perp_price(px("1.5"), 7).unwrap_err().starts_with("SZ_DECIMALS_TOO_LARGE"));
    }

    #[test]
    fn sig_figs_and_decimals() {
        assert_eq!((sig_figs_e8(px("0.0147")), decimals_e8(px("0.0147"))), (3, 4));
        assert_eq!((sig_figs_e8(px("1670.1")), decimals_e8(px("1670.1"))), (5, 1));
        assert_eq!((sig_figs_e8(px("100")), decimals_e8(px("100"))), (3, 0));
        assert_eq!((sig_figs_e8(px("0.00000001")), decimals_e8(px("0.00000001"))), (1, 8));
    }

    #[test]
    fn sizing_is_floor_of_notional_over_price_in_lots() {
        // $33,273.35 at 3.6 with 1 decimal: 9242.597... -> 9242.5
        let lots = size_lots(3_327_335, px("3.6"), 1).unwrap();
        assert_eq!(lots, 92_425);
        assert_eq!(wire_e8(lots_to_e8(lots, 1).unwrap()), "9242.5");
        assert_eq!(size_lots(1, px("74363"), 5).unwrap(), 0);
        assert_eq!(size_lots(1, 0, 5).unwrap_err(), "PRICE_ZERO");
        // u64 extremes do not overflow silently
        assert_eq!(size_lots(u64::MAX, 1, 8).unwrap_err(), "SIZE_OVERFLOW");
        assert_eq!(lots_to_e8(u64::MAX, 0).unwrap_err(), "SIZE_OVERFLOW");
    }

    #[test]
    fn msgpack_containers_and_ints_use_the_smallest_form() {
        assert_eq!(to_msgpack(&Mp::UInt(127)), vec![0x7f]);
        assert_eq!(to_msgpack(&Mp::UInt(128)), vec![0xcc, 0x80]);
        assert_eq!(to_msgpack(&Mp::UInt(256)), vec![0xcd, 0x01, 0x00]);
        assert_eq!(to_msgpack(&Mp::UInt(65_536)), vec![0xce, 0, 1, 0, 0]);
        assert_eq!(to_msgpack(&Mp::UInt(1 << 32)), vec![0xcf, 0, 0, 0, 1, 0, 0, 0, 0]);
        assert_eq!(to_msgpack(&Mp::str("")), vec![0xa0]);
        assert_eq!(to_msgpack(&Mp::Str("x".repeat(32)))[..2], [0xd9, 32]);
        assert_eq!(to_msgpack(&Mp::Arr(vec![Mp::Nil; 16]))[..3], [0xdc, 0, 16]);
    }

    #[test]
    #[should_panic(expected = "MSGPACK_UINT_NOT_SAFE_INTEGER")]
    fn msgpack_refuses_ints_that_js_would_encode_as_float() {
        to_msgpack(&Mp::UInt(MAX_SAFE_INTEGER + 1));
    }
}
