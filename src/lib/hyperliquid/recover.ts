/**
 * Recovers the EVM address that signed a 32-byte digest with a Hyperliquid-style {r, s, v}
 * (v = 27 + recovery id). Pure, offline; used by the setup script, the verify harness, the
 * acceptance test and the dashboard (which re-runs it in the browser).
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface RsvSignature {
  r: string;
  s: string;
  v: number;
}

export const evmAddressFromUncompressed = (uncompressed: Uint8Array) => `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;

export function recoverAddress(digestHex: string, sig: RsvSignature): string {
  const r = hexToBytes(sig.r.replace(/^0x/, "").padStart(64, "0"));
  const s = hexToBytes(sig.s.replace(/^0x/, "").padStart(64, "0"));
  const pub = secp256k1.recoverPublicKey(new Uint8Array([sig.v - 27, ...r, ...s]), hexToBytes(digestHex.replace(/^0x/, "")), { prehash: false });
  return evmAddressFromUncompressed(secp256k1.Point.fromBytes(pub).toBytes(false));
}
