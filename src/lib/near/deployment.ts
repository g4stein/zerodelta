/**
 * Which deployed NEAR testnet accounts this build talks to.
 *
 * Values come from testnet-proof.json. `scripts/testnet-setup.ts` overrides them
 * through environment variables while it deploys a fresh contract, so the swarm
 * can build commitments for the new contract before the proof file is written.
 */
import proofJson from "../../../testnet-proof.json";

const env = typeof process !== "undefined" && process.env ? process.env : ({} as Record<string, string | undefined>);
const proof = proofJson as { contract?: { accountId?: string }; accounts?: { guard?: string; solver?: string } };

/** The Risk Guard contract account. It is also the MPC predecessor for the hedge key. */
export const RISK_GUARD_CONTRACT_ID: string =
  env.ZERODELTA_RISK_GUARD_CONTRACT || proof.contract?.accountId || "zerodelta-guard.testnet";

/** The only account the contract accepts `record_rebalance` from. */
export const SOLVER_ACCOUNT_ID: string = env.ZERODELTA_SOLVER_ACCOUNT || proof.accounts?.solver || "zerodelta-solver.testnet";

export const MPC_SIGNER_CONTRACT = "v1.signer-prod.testnet";
export const HEDGE_DERIVATION_PATH = "zerodelta/hedge/arbitrum";
