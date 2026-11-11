"use client";

/**
 * Risk Guard v3 panel: the binding chain from approved legs to the Hyperliquid testnet exchange,
 * with every link either recomputed in the browser, read live from the contract, or linked to the
 * historical transaction. Nothing here signs, sends or posts anything.
 */
import { useMemo } from "react";
import { ArrowRight, CircleCheck, CircleX, ExternalLink, Fingerprint, KeyRound, Lock, Network, ShieldCheck } from "lucide-react";
import accJson from "../../hl-acceptance.json";
import { V3_PROOF_JSON } from "@/lib/near/proofFile";
import type { V3OnchainStatus } from "@/lib/near/riskGuardV3";
import { buildV3Hedge } from "@/lib/hyperliquid/v3Hedge";
import { recoverAddress } from "@/lib/hyperliquid/recover";
import { Badge, Card, cx, short, usd } from "@/components/ui";

const NB = "https://testnet.nearblocks.io";
const p = V3_PROOF_JSON as any;
const acc = accJson as any;

function Tag({ tone, children }: { tone: "cyan" | "violet" | "amber" | "emerald"; children: React.ReactNode }) {
  return (
    <Badge tone={tone} className="font-mono text-[10px] tracking-wide">
      {children}
    </Badge>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

const Arrow = () => <ArrowRight className="inline h-3 w-3 align-[-2px]" aria-label="recovers" />;

function Ok({ ok, children }: { ok: boolean | undefined; children: React.ReactNode }) {
  return (
    <div className={cx("flex items-start gap-1.5 text-[11px]", ok === undefined ? "text-slate-500" : ok ? "text-emerald-300" : "text-rose-300")}>
      {ok === undefined ? <span className="mt-1 h-1.5 w-1.5 rounded-full bg-slate-500" /> : ok ? <CircleCheck className="mt-0.5 h-3 w-3 shrink-0" /> : <CircleX className="mt-0.5 h-3 w-3 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

function Step({ n, title, icon, tag, children }: { n: number; title: string; icon: React.ReactNode; tag: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">{n}</span>
          {icon}
          {title}
        </div>
      </div>
      <div className="mt-1.5">{tag}</div>
      <div className="mt-2 space-y-1.5 text-xs text-slate-400">{children}</div>
    </div>
  );
}

const txUrl = (kind: string) => (p?.transactions as { kind: string; explorerUrl: string }[] | undefined)?.find((t) => t.kind === kind)?.explorerUrl ?? NB;

export function V3ExecutableProof({ onchainV3 }: { onchainV3?: V3OnchainStatus | null }) {
  // Recomputed in the browser from the recorded request: the same code path the contract mirrors.
  const check = useMemo(() => {
    if (!p) return null;
    const req = p.approvedHedge.args.request;
    const b = buildV3Hedge(p.contract.accountId, "testnet", p.approvedHedge.market, req.order, BigInt(req.limit_px_e8), BigInt(req.reference_px_e8), p.contract.policy);
    const sig = p.approvedHedge.exchangeRequest.signature;
    let recovered = "";
    let flipped = "";
    try {
      recovered = recoverAddress(p.approvedHedge.digestHex, sig);
      flipped = recoverAddress(p.approvedHedge.digestHex, { ...sig, v: sig.v === 27 ? 28 : 27 });
    } catch {
      /* shown as a mismatch */
    }
    return { b, recovered, flipped, digestOk: b.digestHex === p.approvedHedge.digestHex, actionOk: JSON.stringify(b.action) === JSON.stringify(p.approvedHedge.exchangeRequest.action) };
  }, []);
  if (!p || !check) return null;

  const req = p.approvedHedge.args.request;
  const o = req.order;
  const order0 = p.approvedHedge.exchangeRequest.action.orders[0];
  const hedge = String(p.hedgeKey.evmAddress).toLowerCase();
  const sig = p.approvedHedge.exchangeRequest.signature;
  const [real, vFlip, sFlip] = acc.results as { recoveredAddress: string; classification: string; rawResponse: string }[];
  const v = onchainV3;

  return (
    <Card className="mt-6 border-emerald-500/30 p-5" aria-label="Risk Guard v3 executable Hyperliquid signature">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="emerald">v3</Badge>
            <h2 className="text-base font-semibold text-white sm:text-lg">Hyperliquid testnet recovered the contract&apos;s hedge address from the MPC signature</h2>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            The locked v3 contract builds the Hyperliquid order itself from the approved legs, computes its EIP-712 digest, and only then asks NEAR Chain Signatures to sign it.
            Hyperliquid&apos;s <span className="font-mono">/exchange</span> recovered exactly the contract&apos;s MPC-derived address; a flipped <span className="font-mono">v</span> and a flipped bit of{" "}
            <span className="font-mono">s</span> recover different addresses. No funds, no fill: that address has no Hyperliquid account.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px]">
          <Tag tone="cyan">LIVE READ-ONLY CHECK</Tag>
          <Link href={`${NB}/address/${p.contract.accountId}`}>
            <span className="font-mono">{p.contract.accountId}</span>
          </Link>
          <Badge tone={v?.locked === false ? "rose" : "violet"}>
            <Lock className="h-3 w-3" /> {v ? (v.locked ? "locked (0 keys)" : v.live ? `${v.accessKeyCount} keys` : "state unavailable") : "verifying…"}
          </Badge>
          {v?.attestation0 ? (
            <Badge tone={v.attestation0.mpcStatus === "Signed" && v.attestation0.digestMatchesProof && v.attestation0.signatureMatchesProof ? "emerald" : "rose"}>
              attestation #0 {v.attestation0.mpcStatus}; digest + {"{r,s,v}"} match
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <Step n={1} title="Approved legs" icon={<ShieldCheck className="h-3 w-3" />} tag={<Tag tone="violet">HISTORICAL ON-CHAIN PROOF</Tag>}>
          <div>
            {o.asset_symbol}: spot long {usd(o.spot_long_usd_cents / 100, 2)} · perp short {usd(o.perp_short_usd_cents / 100, 2)} on {usd(o.treasury_usd_cents / 100, 0)}
          </div>
          <div>Contract recomputed delta, leverage and slippage against 200/300/25.</div>
          <Link href={txUrl("APPROVED_EXECUTABLE_HEDGE_SIGNED")}>approved tx</Link>
        </Step>
        <Step n={2} title="Contract-built order" icon={<Network className="h-3 w-3" />} tag={<Tag tone="violet">HISTORICAL ON-CHAIN PROOF</Tag>}>
          <div className="font-mono text-[11px] text-slate-300">
            IOC sell {order0.s} on market {order0.a} @ {order0.p}
          </div>
          <div>
            Reference {p.approvedHedge.referencePx}; limit within {p.contract.policy.price_band_bps} bps; size = perp short / limit, in whole lots. Not reduce-only, one order.
          </div>
          <div>Testnet index {order0.a} (mainnet would be 5).</div>
        </Step>
        <Step n={3} title="EIP-712 digest" icon={<Fingerprint className="h-3 w-3" />} tag={<Tag tone="cyan">RECOMPUTED IN YOUR BROWSER</Tag>}>
          <div className="break-all font-mono text-[11px] text-slate-300">{short(p.approvedHedge.digestHex, 12, 10)}</div>
          <Ok ok={check.digestOk}>contract digest == fresh TS rebuild from the recorded request</Ok>
          <Ok ok={check.actionOk}>recorded action == rebuilt action</Ok>
          <Ok ok={v?.attestation0?.digestMatchesProof}>attestation #0 on-chain holds the same digest</Ok>
        </Step>
        <Step n={4} title="MPC signature" icon={<KeyRound className="h-3 w-3" />} tag={<Tag tone="violet">HISTORICAL ON-CHAIN PROOF</Tag>}>
          <div className="font-mono text-[11px] text-slate-300">
            r {short(sig.r, 8, 6)} · s {short(sig.s, 8, 6)} · v {sig.v}
          </div>
          <div>Called by the contract itself (predecessor = contract), path {p.hedgeKey.path}.</div>
          <Ok ok={check.recovered === hedge}>
            recovers to <span className="font-mono">{short(hedge, 8, 6)}</span> (in your browser)
          </Ok>
          <Ok ok={check.flipped !== "" && check.flipped !== hedge}>
            flipped v recovers <span className="font-mono">{short(check.flipped, 8, 6)}</span> instead
          </Ok>
        </Step>
        <Step n={5} title="Hyperliquid testnet" icon={<ArrowRight className="h-3 w-3" />} tag={<Tag tone="amber">RECORDED EXCHANGE RESPONSE</Tag>}>
          <Ok ok={real?.classification === "PASS"}>
            real signature <Arrow /> <span className="font-mono">{short(real?.recoveredAddress, 8, 6)}</span> (= hedge key)
          </Ok>
          <Ok ok={vFlip?.classification === "FAIL"}>
            v flipped <Arrow /> <span className="font-mono">{short(vFlip?.recoveredAddress, 8, 6)}</span>
          </Ok>
          <Ok ok={sFlip?.classification === "FAIL"}>
            s bit flipped <Arrow /> <span className="font-mono">{short(sFlip?.recoveredAddress, 8, 6)}</span>
          </Ok>
          <div className="text-[11px] text-slate-500">
            {acc.ranAt?.slice(0, 16).replace("T", " ")} UTC · <span className="font-mono">npm run hl:acceptance</span>
          </div>
        </Step>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <Tag tone="violet">HISTORICAL ON-CHAIN PROOF</Tag>
        <Link href={txUrl("DEPLOY_INIT_AND_LOCK")}>deploy + lock</Link>
        <Link href={txUrl("PRICE_OUT_OF_BAND_REJECTED")}>price out of band rejected</Link>
        <Link href={txUrl("REPLAY_REJECTED")}>replay rejected</Link>
        <Link href={txUrl("PRIVATE_CALLBACK_REJECTED")}>private callback rejected</Link>
        <span>Rejected transactions produced no MPC receipt. The v2 attack demos below are unchanged.</span>
      </div>
    </Card>
  );
}
