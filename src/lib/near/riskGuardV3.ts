/**
 * Live, read-only status of the Risk Guard v3 contract (zerodelta-guard-v3-*.testnet), compared
 * with the recorded proof. Used by GET /api/swarm and the dashboard's v3 panel. Writes nothing.
 */
import { V3_PROOF_JSON } from "./proofFile";
import { getAccessKeyCount } from "./riskGuardContract";
import { nearRpc, viewFunction } from "./rpcClient";

export interface V3OnchainStatus {
  live: boolean;
  contractId: string;
  accessKeyCount?: number;
  locked?: boolean;
  codeHashMatchesProof?: boolean;
  lastNonce?: number;
  attestationCount?: number;
  attestation0?: { mpcStatus: string; digestMatchesProof: boolean; signatureMatchesProof: boolean; actionMatchesProof: boolean };
  error?: string;
}

interface V3Attestation {
  mpc_status: string;
  digest_hex: string;
  action_json: string;
  hl_signature: { r: string; s: string; v: number } | null;
}

export async function getV3OnchainStatus(): Promise<V3OnchainStatus | null> {
  const p = V3_PROOF_JSON as any;
  if (!p) return null;
  const C: string = p.contract.accountId;
  const [cfg, acct, keys, att] = await Promise.all([
    viewFunction<{ last_nonce: number; attestation_count: number }>("testnet", C, "get_config"),
    nearRpc<{ code_hash: string }>("testnet", "query", { request_type: "view_account", finality: "final", account_id: C }),
    getAccessKeyCount(C),
    viewFunction<V3Attestation | null>("testnet", C, "get_attestation", { index: 0 }),
  ]);
  if (!cfg.ok) return { live: false, contractId: C, error: cfg.error };
  const a = att.ok ? att.value : null;
  const sig = p.approvedHedge.exchangeRequest.signature;
  return {
    live: true,
    contractId: C,
    accessKeyCount: keys,
    locked: keys === undefined ? undefined : keys === 0,
    codeHashMatchesProof: acct.ok ? acct.result?.code_hash === p.contract.codeHash : undefined,
    lastNonce: cfg.value?.last_nonce,
    attestationCount: cfg.value?.attestation_count,
    attestation0: a
      ? {
          mpcStatus: a.mpc_status,
          digestMatchesProof: a.digest_hex === p.approvedHedge.digestHex,
          signatureMatchesProof: Boolean(a.hl_signature && a.hl_signature.r === sig.r && a.hl_signature.s === sig.s && a.hl_signature.v === sig.v),
          actionMatchesProof: a.action_json === JSON.stringify(p.approvedHedge.exchangeRequest.action),
        }
      : undefined,
  };
}
