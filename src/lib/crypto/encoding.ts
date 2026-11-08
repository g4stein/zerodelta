/**
 * Small, dependency-light encoding + hashing helpers shared by every agent.
 * Everything here is deterministic so audit hashes are reproducible.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import bs58 from "bs58";

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes };

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8ToBytes(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data));
}

export function keccak256Hex(data: Uint8Array | string): string {
  return bytesToHex(keccak_256(typeof data === "string" ? utf8ToBytes(data) : data));
}

export function keccak256Bytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function toBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

export function fromBase58(b58: string): Uint8Array {
  return bs58.decode(b58);
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace.
 * Used for every hash/commitment so two parties hashing the "same" object agree.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
