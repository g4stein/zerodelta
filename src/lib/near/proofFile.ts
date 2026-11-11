/**
 * testnet-proof.json holds the current deployment at the top level and older ones under
 * `previousDeployment` (v3.1 -> v3 -> v2 -> v1). The v2 proof is kept unchanged there; a byte-identical copy
 * of the original v2 file is in proofs/testnet-proof.v2.json.
 *
 * The v2 demo (dashboard, swarm, verify §9) reads V2_PROOF; v3 history reads V3_PROOF, v3.1 code reads V31_PROOF.
 */
import proofJson from "../../../testnet-proof.json";

type AnyProof = { version?: number; previousDeployment?: AnyProof } & Record<string, unknown>;
const file = proofJson as unknown as AnyProof;

function findVersion(p: AnyProof | undefined, v: number): AnyProof | undefined {
  for (let cur = p; cur; cur = cur.previousDeployment) if ((cur.version ?? 1) === v) return cur;
  return undefined;
}

function require_(v: number): AnyProof {
  const found = findVersion(file, v);
  if (!found) throw new Error(`testnet-proof.json has no version ${v} deployment (no silent fallback)`);
  return found;
}

/** The Risk Guard v2 proof (locked contract zerodelta-guard-fb604f.testnet and its 5 transactions). Throws if missing. */
export const V2_PROOF_JSON: AnyProof = require_(2);
/** The Risk Guard v3 proof (superseded by v3.1; kept as history). Throws if missing. */
export const V3_PROOF_JSON: AnyProof = require_(3);
/** The Risk Guard v3.1 proof: the current signing path. Throws if missing. */
export const V31_PROOF_JSON: AnyProof = require_(3.1);
