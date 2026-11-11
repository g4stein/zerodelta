/**
 * testnet-proof.json holds the current deployment at the top level and older ones under
 * `previousDeployment` (v3 -> v2 -> v1). The v2 proof is kept unchanged there; a byte-identical copy
 * of the original v2 file is in proofs/testnet-proof.v2.json.
 *
 * The v2 demo (dashboard, swarm, verify §9) reads V2_PROOF; v3 code reads V3_PROOF.
 */
import proofJson from "../../../testnet-proof.json";

type AnyProof = { version?: number; previousDeployment?: AnyProof } & Record<string, unknown>;
const file = proofJson as unknown as AnyProof;

function findVersion(p: AnyProof | undefined, v: number): AnyProof | undefined {
  for (let cur = p; cur; cur = cur.previousDeployment) if ((cur.version ?? 1) === v) return cur;
  return undefined;
}

/** The Risk Guard v2 proof (locked contract zerodelta-guard-fb604f.testnet and its 5 transactions). */
export const V2_PROOF_JSON: AnyProof = findVersion(file, 2) ?? file;
/** The Risk Guard v3 proof, or null before v3 is deployed. */
export const V3_PROOF_JSON: AnyProof | null = findVersion(file, 3) ?? null;
