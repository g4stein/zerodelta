//! Official hyperliquid-python-sdk signing vectors, reproduced by the Rust port.
//!
//! Source: https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/tests/signing_test.py
//! (the same vectors `tests/hyperliquid.test.ts` checks for the TypeScript module).
//! The key 0x0123…0123 is the SDK's public test key, not a secret.
//!
//! RFC 6979 signing is deterministic, so getting the SDK's exact (r, s, v) proves the
//! digest is byte-identical to the one the SDK signs.

use secp256k1::{Message, Secp256k1, SecretKey};
use zerodelta_risk_guard_v31::hl::{self, Mp, OrderWire, Tif, E8};

const SDK_TEST_KEY: &str = "0123456789012345678901234567890123456789012345678901234567890123";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// `0x` + hex without leading zeros, the shape the SDK and the TS module print r and s in.
fn short_hex(b: &[u8]) -> String {
    let h = hl::hex(b);
    let t = h.trim_start_matches('0');
    format!("0x{}", if t.is_empty() { "0" } else { t })
}

fn sign(digest: [u8; 32]) -> (String, String, u8) {
    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(&unhex(SDK_TEST_KEY)).unwrap();
    let sig = secp.sign_ecdsa_recoverable(&Message::from_slice(&digest).unwrap(), &sk);
    let (rid, rs) = sig.serialize_compact();
    (short_hex(&rs[..32]), short_hex(&rs[32..]), 27 + rid.to_i32() as u8)
}

fn sign_action(action: &Mp, nonce: u64, is_mainnet: bool) -> (String, String, u8) {
    let packed = hl::to_msgpack(action);
    sign(hl::l1_digest(&hl::connection_id(&packed, nonce, None), is_mainnet))
}

#[test]
fn phantom_agent_creation_matches_production_connection_id() {
    // asset 4, buy, sz 0.0147, px 1670.1, Ioc, nonce 1677777606040
    let o = OrderWire { asset: 4, is_buy: true, px_e8: 167_010_000_000, sz_e8: 1_470_000, reduce_only: false, tif: Tif::Ioc };
    let packed = hl::to_msgpack(&hl::order_action(&[o]));
    assert_eq!(
        hl::hex(&hl::connection_id(&packed, 1_677_777_606_040, None)),
        "0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908"
    );
}

#[test]
fn l1_action_signing_matches_dummy_action() {
    // {"type": "dummy", "num": float_to_int_for_hashing(1000)}
    let action = Mp::map(vec![("type", Mp::str("dummy")), ("num", Mp::UInt(100_000_000_000))]);
    assert_eq!(
        sign_action(&action, 0, true),
        (
            "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298".to_string(),
            "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8".to_string(),
            27
        )
    );
    assert_eq!(
        sign_action(&action, 0, false),
        (
            "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510".to_string(),
            "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613".to_string(),
            28
        )
    );
}

#[test]
fn l1_action_signing_matches_limit_order_mainnet_and_testnet() {
    // asset 1, buy, sz 100, px 100, Gtc, nonce 0
    let o = OrderWire { asset: 1, is_buy: true, px_e8: 100 * E8, sz_e8: 100 * E8, reduce_only: false, tif: Tif::Gtc };
    let digest_main = hl::order_digest(&[o.clone()], 0, None, true);
    let digest_test = hl::order_digest(&[o], 0, None, false);
    assert_eq!(
        sign(digest_main),
        (
            "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e".to_string(),
            "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e".to_string(),
            28
        )
    );
    assert_eq!(
        sign(digest_test),
        (
            "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54".to_string(),
            "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5".to_string(),
            27
        )
    );
}

#[test]
fn msgpack_key_order_is_part_of_the_hash() {
    let o = OrderWire { asset: 1, is_buy: true, px_e8: 100 * E8, sz_e8: 100 * E8, reduce_only: false, tif: Tif::Gtc };
    let canonical = hl::to_msgpack(&hl::order_action(&[o.clone()]));
    let reordered = hl::to_msgpack(&Mp::map(vec![
        ("orders", Mp::Arr(vec![o.to_mp()])),
        ("type", Mp::str("order")),
        ("grouping", Mp::str("na")),
    ]));
    assert_ne!(hl::connection_id(&canonical, 0, None), hl::connection_id(&reordered, 0, None));
}

#[test]
fn mainnet_and_testnet_digests_differ_only_by_source() {
    let o = OrderWire { asset: 3, is_buy: false, px_e8: 74_000 * E8, sz_e8: 20_000, reduce_only: false, tif: Tif::Ioc };
    assert_ne!(hl::order_digest(&[o.clone()], 1, None, true), hl::order_digest(&[o], 1, None, false));
}

#[test]
fn expires_after_is_part_of_the_hash_and_none_is_unchanged() {
    let o = OrderWire { asset: 3, is_buy: false, px_e8: 74_000 * E8, sz_e8: 20_000, reduce_only: false, tif: Tif::Ioc };
    let packed = hl::to_msgpack(&hl::order_action(&[o]));
    let none = hl::connection_id(&packed, 5, None);
    let some = hl::connection_id(&packed, 5, Some(1_800_000_000_000));
    let other = hl::connection_id(&packed, 5, Some(1_800_000_000_001));
    assert_ne!(none, some);
    assert_ne!(some, other);
    // layout: ... nonce || 0x00 (no vault) || 0x00 || expiresAfter_be
    let mut want = packed.clone();
    want.extend_from_slice(&5u64.to_be_bytes());
    want.extend_from_slice(&[0x00, 0x00]);
    want.extend_from_slice(&1_800_000_000_000u64.to_be_bytes());
    assert_eq!(some, near_sdk::env::keccak256_array(&want));
}
