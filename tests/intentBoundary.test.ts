import { afterEach, describe, expect, it, vi } from "vitest";
import { createEphemeralSigner, generateNonce, signNep413 } from "../src/lib/near/nep413";
import { ONECLICK_TOKEN_SNAPSHOT, fetchOneClickQuote } from "../src/lib/near/rpcClient";
import { FUNDING_SNAPSHOT } from "../src/lib/market/fundingFeed";
import { probeEntryCosts, runScannerAgent } from "../src/lib/agents/scannerAgent";
import { getSolverEnclave, runSolverAgent } from "../src/lib/agents/solverAgent";
import { getGuardianIdentity, runGuardianAgent } from "../src/lib/agents/guardianAgent";
import { computeReportData, signAttestation } from "../src/lib/crypto/attestation";
import { hashObject } from "../src/lib/crypto/encoding";
import { PAIRS, USDC_NEAR_ASSET, USDC_ARB_ASSET } from "../src/lib/swarm/types";

const tokens = { live: false, source: "test", tokens: ONECLICK_TOKEN_SNAPSHOT, count: ONECLICK_TOKEN_SNAPSHOT.length, chains: [], fetchedAt: "" };
const funding = { live: false, source: "test", markets: FUNDING_SNAPSHOT, fetchedAt: "" };
const costs = await probeEntryCosts(false, "offline");
const plan = runScannerAgent({ pair: "ETH", treasuryUsd: 50000, tokens, funding, costs }).plan;
async function setup(live = false) {
  const signer = createEphemeralSigner();
  const solver = await runSolverAgent({ plan, sliceCount: 4, tokens, signer, guardianBoxPublicKey: getGuardianIdentity().boxPublicKeyHex, live });
  const guard = () => runGuardianAgent({ runId: "boundary", solver, expectedSignerId: signer.accountId, allowOfflineQuotes: !live, trustedEnclaveKeys: [getSolverEnclave().publicKeyHex], expected: { treasuryUsd: 50000, pair: "ETH" }, lastAcceptedNonce: 0 });
  const rewrite = (change: (msg: any) => void, reattest = true, alternateSigner = false) => {
    const msg = JSON.parse(solver.intent.signed.payload.message);
    change(msg);
    const key = alternateSigner ? createEphemeralSigner() : signer;
    if (alternateSigner) msg.signer_id = key.accountId;
    const replacement = signNep413(key.keyPair, { message: JSON.stringify(msg), nonce: generateNonce(), recipient: "intents.near" });
    solver.intent.signed = replacement.signed;
    if (reattest) {
      solver.intent.payloadHashHex = replacement.payloadHashHex;
      solver.attestation = signAttestation(getSolverEnclave(), computeReportData({ envelopeHash: solver.envelope.envelopeHash, intentPayloadHash: replacement.payloadHashHex, planHash: hashObject(solver.executablePlan), hedgeOrderPayloadHex: solver.hedgeOrderPayloadHex, quotesHash: hashObject(solver.quotes) }));
    }
  };
  return { solver, guard, rewrite };
}
afterEach(() => vi.unstubAllGlobals());

describe("Solver-to-guard intent boundary", () => {
  it("approves the unchanged complete intent", async () => expect((await setup()).guard().decision).toBe("APPROVED"));
  it("rejects a replacement payload bound to the old hash and attestation", async () => {
    const { guard, rewrite } = await setup();
    rewrite(m => { m.deadline = new Date(Date.now() + 60000).toISOString(); }, false);
    const d = guard();
    expect(d.violations).toContain("NEP413_SIGNATURE");
    expect(d.attestation.reportDataBound).toBe(false);
    expect(d.mpcSignRequest).toBeNull();
  });
  const attacks: [string, (msg: any) => void][] = [
    ["missing receive tokens", m => { m.intents[0].diff = { [USDC_NEAR_ASSET]: m.intents[0].diff[USDC_NEAR_ASSET] }; }],
    ["reduced minimum receipt", m => { m.intents[0].diff[PAIRS.ETH.spotAssetId] = "1"; }],
    ["extra debit", m => { m.intents[0].diff[PAIRS.SOL.spotAssetId] = "-1"; }],
    ["extra transfer", m => { m.intents.push({ intent: "transfer", receiver_id: "attacker.near", tokens: { [USDC_NEAR_ASSET]: "1" } }); }],
    ["duplicate token_diff", m => { m.intents.push(m.intents[0]); }],
    ["missing operation list", m => { delete m.intents; }],
    ["null operation", m => { m.intents = [null]; }],
    ["invalid deadline", m => { m.deadline = "not-a-date"; }],
    ["expired deadline", m => { m.deadline = new Date(Date.now() - 1000).toISOString(); }],
    ["unbounded deadline", m => { m.deadline = new Date(Date.now() + 86400000).toISOString(); }],
  ];
  it.each(attacks)("rejects %s even with a fresh signature and attestation", async (_label, change) => {
    const { guard, rewrite } = await setup(); rewrite(change);
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.violations).toContain("NEP413_SIGNATURE");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("rejects another signer even when the signature and attestation are valid", async () => {
    const { guard, rewrite } = await setup(); rewrite(() => {}, true, true);
    const d = guard();
    expect(d.attestation.valid).toBe(true);
    expect(d.checks.find(c => c.id === "NEP413_SIGNATURE")?.detail).toContain("SIGNER_MISMATCH");
    expect(d.mpcSignRequest).toBeNull();
  });
});

function quoteResponse(request: any) {
  const input = BigInt(request.amount);
  const output = request.destinationAsset === USDC_ARB_ASSET ? input : input * 1000000000000n;
  return { quote: { amountIn: input.toString(), amountOut: output.toString(), minAmountOut: (output * 9975n / 10000n).toString(), amountInUsd: String(Number(input) / 1e6), amountOutUsd: String(Number(input) / 1e6 * .998), amountOutFormatted: "test" }, timestamp: new Date().toISOString() };
}
describe("Live quote failure must not authorize", () => {
  it.each(["reference missing", "slice missing", "zero output", "non-finite USD", "stale quote"])("withholds authorization when %s", async mode => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => {
      const request = JSON.parse(String(opts.body));
      const ref = request.amount === "100000000";
      if ((mode === "reference missing" && ref) || (mode === "slice missing" && !ref)) return new Response("{}", { status: 503 });
      const body = quoteResponse(request);
      if (mode === "zero output") body.quote.amountOut = "0";
      if (mode === "non-finite USD") body.quote.amountOutUsd = "Infinity";
      if (mode === "stale quote") body.timestamp = new Date(Date.now() - 120000).toISOString();
      return Response.json(body);
    }));
    const { solver, guard } = await setup(true);
    expect(solver.quotes.every(q => q.validForAuthorization === false)).toBe(true);
    const d = guard();
    expect(d.violations).toContain("SLIPPAGE_CEILING");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("does not treat a missing quote-validity marker as approval", async () => {
    const { solver, guard } = await setup();
    delete (solver.quotes[0] as Partial<typeof solver.quotes[0]>).validForAuthorization;
    const d = guard();
    expect(d.violations).toContain("SLIPPAGE_CEILING");
    expect(d.mpcSignRequest).toBeNull();
  });
  it("accepts valid fresh quotes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => Response.json(quoteResponse(JSON.parse(String(opts.body))))));
    const { solver, guard } = await setup(true);
    expect(solver.quotes.every(q => q.validForAuthorization)).toBe(true);
    expect(guard().decision).toBe("APPROVED");
  });
  it("does not recommend from an unavailable liquidity probe", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => {
      const request = JSON.parse(String(opts.body));
      return request.amount === "100000000" ? Response.json(quoteResponse(request)) : new Response("{}", { status: 503 });
    }));
    const probes = await probeEntryCosts(true, "audit");
    expect(Object.values(probes).every(p => p.source === "local-model")).toBe(true);
  });
});
