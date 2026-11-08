/**
 * NEP-413 ("signMessage") implementation used to sign NEAR Intents.
 *
 * Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 *
 *   payload  = borsh({ tag: u32 = 2^31 + 413, message: string, nonce: [u8; 32],
 *                      recipient: string, callbackUrl: Option<string> })
 *   digest   = sha256(payload)
 *   sig      = ed25519_sign(secretKey, digest)
 *
 * The signed object is emitted in the exact `MultiPayload` shape the
 * `intents.near` Verifier contract accepts (`standard: "nep413"`).
 */
import { KeyPair, KeyPairEd25519, PublicKey, keyToImplicitAddress } from "near-api-js";
import nacl from "tweetnacl";
import {
  bytesToHex,
  concatBytes,
  fromBase58,
  fromBase64,
  randomBytes,
  sha256Bytes,
  toBase58,
  toBase64,
  utf8ToBytes,
} from "../crypto/encoding";

/** 2^31 + 413, the NEP-413 discriminant prefix that prevents tx-signature confusion. */
export const NEP413_TAG = 2_147_484_061;
export const INTENTS_CONTRACT = "intents.near";

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}

/** Wire format accepted by `intents.near` (`execute_intents` / `simulate_intents`). */
export interface SignedNep413Intent {
  standard: "nep413";
  payload: {
    message: string;
    nonce: string; // base64 of the 32-byte nonce
    recipient: string;
    callbackUrl?: string;
  };
  public_key: string; // "ed25519:<base58>"
  signature: string; // "ed25519:<base58>"
}

export interface Nep413SignResult {
  signed: SignedNep413Intent;
  signerId: string;
  borshPayloadHex: string;
  payloadHashHex: string;
  nonceHex: string;
  signatureHex: string;
  signatureBase64: string;
}

export interface Nep413VerifyResult {
  valid: boolean;
  tweetnaclValid: boolean;
  nearApiJsValid: boolean;
  payloadHashHex: string;
  reason?: string;
}

export interface EphemeralSigner {
  keyPair: KeyPairEd25519;
  publicKey: string;
  /** NEAR implicit account id = lowercase hex of the 32-byte ed25519 public key. */
  accountId: string;
}

/** Generates a fresh ed25519 key and derives its 64-char hex implicit account id. */
export function createEphemeralSigner(): EphemeralSigner {
  const keyPair = KeyPair.fromRandom("ed25519") as KeyPairEd25519;
  const publicKey = keyPair.getPublicKey().toString();
  return { keyPair, publicKey, accountId: keyToImplicitAddress(publicKey) };
}

/** Cryptographically random 32-byte nonce (NEP-413 requires exactly 32 bytes). */
export function generateNonce(): Uint8Array {
  return randomBytes(32);
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function borshString(s: string): Uint8Array {
  const bytes = utf8ToBytes(s);
  return concatBytes(u32le(bytes.length), bytes);
}

/** Borsh-serialises the NEP-413 payload, including the 2^31+413 tag prefix. */
export function serializeNep413Payload(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== 32) {
    throw new Error(`NEP-413 nonce must be exactly 32 bytes, got ${payload.nonce.length}`);
  }
  const callback =
    payload.callbackUrl === undefined
      ? new Uint8Array([0])
      : concatBytes(new Uint8Array([1]), borshString(payload.callbackUrl));
  return concatBytes(
    u32le(NEP413_TAG),
    borshString(payload.message),
    payload.nonce,
    borshString(payload.recipient),
    callback,
  );
}

export function hashNep413Payload(payload: Nep413Payload): Uint8Array {
  return sha256Bytes(serializeNep413Payload(payload));
}

/** Signs a NEP-413 payload with a near-api-js ed25519 key pair. */
export function signNep413(keyPair: KeyPairEd25519, payload: Nep413Payload): Nep413SignResult {
  const borsh = serializeNep413Payload(payload);
  const digest = sha256Bytes(borsh);
  const { signature } = keyPair.sign(digest);
  const publicKey = keyPair.getPublicKey().toString();
  const signed: SignedNep413Intent = {
    standard: "nep413",
    payload: {
      message: payload.message,
      nonce: toBase64(payload.nonce),
      recipient: payload.recipient,
      ...(payload.callbackUrl !== undefined ? { callbackUrl: payload.callbackUrl } : {}),
    },
    public_key: publicKey,
    signature: `ed25519:${toBase58(signature)}`,
  };
  return {
    signed,
    signerId: keyToImplicitAddress(publicKey),
    borshPayloadHex: bytesToHex(borsh),
    payloadHashHex: bytesToHex(digest),
    nonceHex: bytesToHex(payload.nonce),
    signatureHex: bytesToHex(signature),
    signatureBase64: toBase64(signature),
  };
}

function stripCurve(value: string, curve = "ed25519"): Uint8Array {
  const prefix = `${curve}:`;
  if (!value.startsWith(prefix)) throw new Error(`expected "${prefix}" prefix`);
  return fromBase58(value.slice(prefix.length));
}

/**
 * Verifies a signed NEP-413 intent twice, independently:
 * with tweetnacl (raw ed25519) and with near-api-js `PublicKey.verify`.
 */
export function verifyNep413(signed: SignedNep413Intent): Nep413VerifyResult {
  try {
    if (signed.standard !== "nep413") throw new Error("standard must be nep413");
    const nonce = fromBase64(signed.payload.nonce);
    const digest = hashNep413Payload({
      message: signed.payload.message,
      nonce,
      recipient: signed.payload.recipient,
      callbackUrl: signed.payload.callbackUrl,
    });
    const sig = stripCurve(signed.signature);
    const pub = stripCurve(signed.public_key);
    if (sig.length !== 64) throw new Error("signature must be 64 bytes");
    if (pub.length !== 32) throw new Error("public key must be 32 bytes");
    const tweetnaclValid = nacl.sign.detached.verify(digest, sig, pub);
    const nearApiJsValid = PublicKey.fromString(signed.public_key).verify(digest, sig);
    return {
      valid: tweetnaclValid && nearApiJsValid,
      tweetnaclValid,
      nearApiJsValid,
      payloadHashHex: bytesToHex(digest),
    };
  } catch (err) {
    return {
      valid: false,
      tweetnaclValid: false,
      nearApiJsValid: false,
      payloadHashHex: "",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Intents understood by the `intents.near` Verifier (subset used by ZeroDelta). */
export type DefuseIntent =
  | { intent: "token_diff"; diff: Record<string, string> }
  | { intent: "transfer"; receiver_id: string; tokens: Record<string, string> };

export interface IntentMessage {
  signer_id: string;
  deadline: string; // ISO-8601
  intents: DefuseIntent[];
}

/** Builds the JSON `message` string that goes inside the NEP-413 payload. */
export function buildIntentMessage(message: IntentMessage): string {
  return JSON.stringify(message);
}

/** Returns a copy of the signed intent with one signature bit flipped (for negative tests). */
export function tamperSignature(signed: SignedNep413Intent): SignedNep413Intent {
  const sig = stripCurve(signed.signature);
  const flipped = new Uint8Array(sig);
  flipped[0] ^= 0x01;
  return { ...signed, signature: `ed25519:${toBase58(flipped)}` };
}
