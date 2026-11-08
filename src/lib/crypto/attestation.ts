/**
 * Software-simulated TEE attestation used by the Confidential Solver (Agent 2)
 * and verified by the Risk Guard (Agent 3).
 *
 * What is real: SHA-256 code measurement, Ed25519 report signatures, report-data
 * binding to the exact intent + encrypted envelope, freshness checks.
 *
 * What is simulated: there is no hardware root of trust. In production the
 * report would be an Intel TDX / AMD SEV-SNP quote from NEAR AI Cloud or Phala,
 * whose enclave key is endorsed by the CPU vendor. Here the verifier instead
 * pins the enclave key it trusts (see `trustedEnclaveKeys`).
 */
import nacl from "tweetnacl";
import { bytesToHex, canonicalJson, hashObject, hexToBytes, sha256Hex } from "./encoding";

export const SOLVER_ENCLAVE_MANIFEST = {
  name: "zerodelta-confidential-solver",
  version: "1.0.0",
  runtime: "simulated-tee",
  slicingAlgorithm: "equal-twap-v1",
  sliceEncryption: "x25519-xsalsa20-poly1305 (nacl.box)",
  intentStandard: "nep413",
  intentRecipient: "intents.near",
  quoteSource: "1click.chaindefuser.com/v0/quote (dry)",
} as const;

/** SHA-256 over the canonical manifest: the "MRENCLAVE"-style code measurement. */
export function computeMeasurement(manifest: object): string {
  return sha256Hex(canonicalJson(manifest));
}

export const EXPECTED_SOLVER_MEASUREMENT = computeMeasurement(SOLVER_ENCLAVE_MANIFEST);

export interface Enclave {
  measurement: string;
  signKeyPair: nacl.SignKeyPair;
  boxKeyPair: nacl.BoxKeyPair;
  publicKeyHex: string;
  boxPublicKeyHex: string;
}

export function createEnclave(manifest: object = SOLVER_ENCLAVE_MANIFEST): Enclave {
  const signKeyPair = nacl.sign.keyPair();
  const boxKeyPair = nacl.box.keyPair();
  return {
    measurement: computeMeasurement(manifest),
    signKeyPair,
    boxKeyPair,
    publicKeyHex: bytesToHex(signKeyPair.publicKey),
    boxPublicKeyHex: bytesToHex(boxKeyPair.publicKey),
  };
}

export interface AttestationReport {
  format: "zerodelta-sim-tee/v1";
  teeType: "SIMULATED";
  measurement: string;
  enclavePublicKey: string;
  reportData: string;
  issuedAt: string;
}

export interface SignedAttestation {
  report: AttestationReport;
  reportHash: string;
  signature: string; // hex ed25519 signature over reportHash bytes
}

export function signAttestation(enclave: Enclave, reportData: string, issuedAt = new Date()): SignedAttestation {
  const report: AttestationReport = {
    format: "zerodelta-sim-tee/v1",
    teeType: "SIMULATED",
    measurement: enclave.measurement,
    enclavePublicKey: enclave.publicKeyHex,
    reportData,
    issuedAt: issuedAt.toISOString(),
  };
  const reportHash = hashObject(report);
  const signature = bytesToHex(nacl.sign.detached(hexToBytes(reportHash), enclave.signKeyPair.secretKey));
  return { report, reportHash, signature };
}

export interface AttestationPolicy {
  trustedMeasurements: string[];
  trustedEnclaveKeys: string[];
  expectedReportData: string;
  now?: Date;
  maxAgeMs?: number;
}

export interface AttestationVerification {
  valid: boolean;
  signatureValid: boolean;
  reportHashValid: boolean;
  measurementTrusted: boolean;
  enclaveKeyTrusted: boolean;
  reportDataBound: boolean;
  fresh: boolean;
  ageMs: number;
}

export function verifyAttestation(att: SignedAttestation, policy: AttestationPolicy): AttestationVerification {
  const now = policy.now ?? new Date();
  const maxAgeMs = policy.maxAgeMs ?? 5 * 60_000;
  const reportHashValid = hashObject(att.report) === att.reportHash;
  let signatureValid = false;
  try {
    signatureValid = nacl.sign.detached.verify(
      hexToBytes(att.reportHash),
      hexToBytes(att.signature),
      hexToBytes(att.report.enclavePublicKey),
    );
  } catch {
    signatureValid = false;
  }
  const ageMs = now.getTime() - new Date(att.report.issuedAt).getTime();
  const result = {
    signatureValid,
    reportHashValid,
    measurementTrusted: policy.trustedMeasurements.includes(att.report.measurement),
    enclaveKeyTrusted: policy.trustedEnclaveKeys.includes(att.report.enclavePublicKey),
    reportDataBound: att.report.reportData === policy.expectedReportData,
    fresh: ageMs >= -5_000 && ageMs <= maxAgeMs,
    ageMs,
  };
  return {
    valid:
      result.signatureValid &&
      result.reportHashValid &&
      result.measurementTrusted &&
      result.enclaveKeyTrusted &&
      result.reportDataBound &&
      result.fresh,
    ...result,
  };
}

/** report_data = sha256(canonical({ envelopeHash, intentPayloadHash, planHash })). */
export function computeReportData(input: { envelopeHash: string; intentPayloadHash: string; planHash: string }): string {
  return hashObject(input);
}
