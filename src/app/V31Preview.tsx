"use client";
import { useState } from "react";
import { Badge, Card } from "@/components/ui";
import type { PreviewScenario } from "@/lib/hyperliquid/preview";

const cases: { id: PreviewScenario; label: string; description: string }[] = [
  { id: "approved", label: "Within policy", description: "The recorded ETH hedge with a fresh nonce and ten-minute expiry." },
  { id: "size-attack", label: "Attack: inflate size", description: "Set limit and reference to one tenth of the reference price. The resulting sell should exceed the coin cap." },
  { id: "expiry-attack", label: "Attack: long expiry", description: "Ask for a two-hour expiry, beyond the contract's one-hour maximum." },
  { id: "price-risk", label: "Inspect remaining price risk", description: "Halve both prices. A larger sell can still fit under the cap: this demonstrates why an independent price oracle is needed." },
  { id: "naked-short", label: "Naked short with inflated treasury", description: "No spot leg, an $80,000 short, and $800 million in reported treasury and collateral. The math can pass because the contract does not authenticate those inputs." },
];
interface Result {
  contractId: string; blockHeight: number; checkedAt: string;
  scenario: PreviewScenario;
  request: { order: { spot_long_usd_cents: number; perp_short_usd_cents: number; treasury_usd_cents: number; collateral_usd_cents: number } };
  evaluation: { approved: boolean; size_e8: number; net_delta_bps: number; leverage_x100: number; digest_hex: string; action_json: string; expires_after_ms: number; window_order_count: number; violations: string[] };
}
export function V31Preview() {
  const [scenario, setScenario] = useState<PreviewScenario>("approved");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function run() {
    setLoading(true); setResult(null); setError("");
    try {
      const r = await fetch(`/api/hedge-preview?scenario=${scenario}`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
      const data = await r.json();
      if (!r.ok || data.live !== true) throw new Error(data.error ?? "Contract preview unavailable");
      setResult(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Contract preview unavailable"); }
    finally { setLoading(false); }
  }
  return <Card className="mt-6 border-cyan-500/30 p-5" aria-label="Try the v3.1 contract">
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-white">Try the current contract</h2><Badge tone="cyan">LIVE READ-ONLY CHECK</Badge></div>
    <p className="mt-2 text-sm text-slate-400">Choose a proposal and ask the deployed v3.1 contract to evaluate it now. This reads contract state; it creates no transaction, signature or trade.</p>
    <label htmlFor="preview-scenario" className="mt-4 block text-sm text-slate-200">Proposal</label>
    <div className="mt-2 flex flex-wrap gap-3">
      <select id="preview-scenario" value={scenario} disabled={loading} onChange={e => { setScenario(e.target.value as PreviewScenario); setResult(null); setError(""); }} className="max-w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">{cases.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
      <button type="button" onClick={() => void run()} disabled={loading} className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{loading ? "Reading contract…" : "Check proposal"}</button>
    </div>
    <p className="mt-2 text-sm text-slate-400">{cases.find(c => c.id === scenario)?.description}</p>
    <div aria-live="polite" className="mt-4">
      {error && <p role="alert" className="text-sm text-amber-300">Unavailable: {error}. No verdict is inferred. Try again when the RPC is available.</p>}
      {result && <div className="space-y-3 text-sm text-slate-300">
        <Badge tone={result.evaluation.approved ? (result.scenario === "naked-short" || result.scenario === "price-risk" ? "amber" : "emerald") : "rose"}>{result.evaluation.approved ? "ACCEPTED BY CONTRACT POLICY" : "REJECTED BY CONTRACT POLICY"}</Badge>
        {result.scenario === "naked-short" && <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-200">
          <p className="font-semibold">Trust boundary: reported inputs are not verified holdings.</p>
          <p>Reported spot: ${(result.request.order.spot_long_usd_cents / 100).toLocaleString("en-US")} · short: ${(result.request.order.perp_short_usd_cents / 100).toLocaleString("en-US")} · treasury: ${(result.request.order.treasury_usd_cents / 100).toLocaleString("en-US")} · collateral: ${(result.request.order.collateral_usd_cents / 100).toLocaleString("en-US")}.</p>
          <p>The delta and leverage checks cannot establish real portfolio neutrality. The contract still enforces order shape, coin caps, expiry and nonce rules. Current window state may also reject this proposal.</p>
        </div>}
        <p>Reported delta: {result.evaluation.net_delta_bps} bps · leverage: {(result.evaluation.leverage_x100 / 100).toFixed(2)}× · sell size: {result.evaluation.size_e8 / 1e8} ETH · orders in current window: {result.evaluation.window_order_count}</p>
        {result.evaluation.violations.length > 0 && <ul className="list-inside list-disc text-rose-300">{result.evaluation.violations.map(v => <li key={v}>{v}</li>)}</ul>}
        <details><summary className="cursor-pointer text-cyan-300">Inspect contract-built order and digest</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs">{JSON.stringify({ action: result.evaluation.action_json ? JSON.parse(result.evaluation.action_json) : null, digest: result.evaluation.digest_hex, expiresAfter: result.evaluation.expires_after_ms }, null, 2)}</pre></details>
        <p className="break-all text-xs text-slate-500">{result.contractId} · block {result.blockHeight} · checked {result.checkedAt}</p>
      </div>}
    </div>
    <p className="mt-4 text-xs leading-relaxed text-amber-200/80">An accepted proposal is not proof of safety or execution. The contract checks reported hedge legs; it does not verify actual spot holdings, treasury, collateral or an independent market price. Coin caps bound order size and signing volume, not outstanding portfolio exposure. This deployment has no buy, reduce-only or withdrawal signing path.</p>
  </Card>;
}
