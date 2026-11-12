"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Blocks,
  Bot,
  CircleCheck,
  CircleX,
  Clock,
  Coins,
  Cpu,
  Fingerprint,
  Gauge,
  Hash,
  Info,
  KeyRound,
  Layers,
  LoaderCircle,
  Lock,
  Network,
  Play,
  Radar,
  RefreshCw,
  Scale,
  Server,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Wallet,
  ExternalLink,
} from "lucide-react";
import type { LiveTelemetry as BaseTelemetry } from "@/lib/near/rpcClient";
import type { OnchainProofStatus, TestnetProof } from "@/lib/near/riskGuardContract";
import type { V3OnchainStatus } from "@/lib/near/riskGuardV3";
import { V3ExecutableProof } from "./V3ExecutableProof";
import { V31Preview } from "./V31Preview";
import { V2_PROOF_JSON, V31_PROOF_JSON } from "@/lib/near/proofFile";
import { computeOrderMetrics, type OrderParams } from "@/lib/near/orderCommitment";

/** Public v2 proof data, bundled statically so the links are in the very first HTML response. */
const PROOF = V2_PROOF_JSON as unknown as TestnetProof;
const NEARBLOCKS = "https://testnet.nearblocks.io";
const nbAccount = (id: string) => `${NEARBLOCKS}/address/${id}`;
const proofTx = (kind: string) => PROOF.transactions.find((t) => t.kind === kind);
const V3_TX = (kind: string) => ((V31_PROOF_JSON as any)?.transactions as { kind: string; explorerUrl: string }[] | undefined)?.find((t) => t.kind === kind)?.explorerUrl;
import type { SwarmRun } from "@/lib/swarm/orchestrator";
import type { PairSelection, SwarmMode } from "@/lib/swarm/types";
import { Badge, Card, CodeBlock, KV, cx, short, usd } from "@/components/ui";

const PAIR_OPTIONS: { id: PairSelection; label: string }[] = [
  { id: "AUTO", label: "Auto (best net carry)" },
  { id: "NEAR", label: "NEAR-PERP / wNEAR" },
  { id: "SOL", label: "SOL-PERP / SOL" },
  { id: "ETH", label: "ETH-PERP / ETH" },
  { id: "BTC", label: "BTC-PERP / nBTC" },
];

const TRACKS = ["06 / SEC", "01 / DFI", "05 / SWM"];

type ProofTab = "intent" | "mpc" | "attestation" | "onchain" | "audit";
type LiveTelemetry = BaseTelemetry & { onchain?: OnchainProofStatus; onchainV3?: V3OnchainStatus | null };

export default function Dashboard() {
  const [telemetry, setTelemetry] = useState<LiveTelemetry | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(true);
  const [treasury, setTreasury] = useState(50_000);
  const [pair, setPair] = useState<PairSelection>("AUTO");
  const [slices, setSlices] = useState(8);
  const [autoSlices, setAutoSlices] = useState(true);
  const [simulateUnprofitable, setSimulateUnprofitable] = useState(false);
  const [run, setRun] = useState<SwarmRun | null>(null);
  const [running, setRunning] = useState<SwarmMode | null>(null);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProofTab>("intent");
  const phaseTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadTelemetry = useCallback(async () => {
    setTelemetryLoading(true);
    try {
      const res = await fetch("/api/swarm", { cache: "no-store" });
      if (res.ok) setTelemetry((await res.json()) as LiveTelemetry);
    } finally {
      setTelemetryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTelemetry();
    const id = setInterval(() => void loadTelemetry(), 15_000);
    return () => clearInterval(id);
  }, [loadTelemetry]);

  const execute = useCallback(
    async (mode: SwarmMode) => {
      setRunning(mode);
      setError(null);
      setRun(null);
      setPhase(1);
      if (phaseTimer.current) clearInterval(phaseTimer.current);
      phaseTimer.current = setInterval(() => setPhase((p) => Math.min(p + 1, 3)), 900);
      try {
        const res = await fetch("/api/swarm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode, treasuryUsd: treasury, pair, sliceCount: autoSlices ? "auto" : slices, simulateUnprofitable }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setRun(body as SwarmRun);
        setPhase(4);
        setTab("intent");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase(0);
      } finally {
        if (phaseTimer.current) clearInterval(phaseTimer.current);
        setRunning(null);
      }
    },
    [treasury, pair, slices, autoSlices, simulateUnprofitable],
  );

  return (
    <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-6 sm:px-6" aria-label="ZeroDelta dashboard">
      <Header />
      <V31Preview />
      <V3ExecutableProof onchainV3={telemetry?.onchainV3} />
      <details className="mt-6 rounded-xl border border-slate-800 p-4"><summary className="cursor-pointer text-sm text-slate-300">Network telemetry and historical v2 guard</summary>
        <TelemetryBar telemetry={telemetry} loading={telemetryLoading} onRefresh={() => void loadTelemetry()} />
      </details>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <ControlPanel
            treasury={treasury}
            setTreasury={setTreasury}
            pair={pair}
            setPair={setPair}
            slices={slices}
            setSlices={setSlices}
            autoSlices={autoSlices}
            setAutoSlices={setAutoSlices}
            simulateUnprofitable={simulateUnprofitable}
            setSimulateUnprofitable={setSimulateUnprofitable}
            running={running}
            onExecute={execute}
          />
          <WhyItMatters />
          <HonestyPanel />
        </div>

        <div className="min-w-0 space-y-6">
          {error ? (
            <Card className="border-rose-500/40 p-4 text-sm text-rose-300">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4" /> Swarm run failed: {error}
              </div>
            </Card>
          ) : null}
          <DecisionBanner run={run} running={running} />
          {run?.mode === "spoofed_metrics" ? <AttackComparison run={run} onchain={telemetry?.onchain} /> : null}
          <Pipeline run={run} phase={phase} running={running} />
          {run ? <ProofInspector run={run} tab={tab} setTab={setTab} onchain={telemetry?.onchain} /> : null}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Header() {
  return (
    <header className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950 shadow-lg shadow-emerald-500/20">
            <Scale className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Zero<span className="text-emerald-400">Delta</span>
            </h1>
            <p className="text-xs text-slate-400">Cross-chain delta-neutral carry, encrypted order slices, contract-guarded on NEAR</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Hackathon tracks">
          {TRACKS.map((t, i) => (
            <Badge key={t} tone={i === 0 ? "emerald" : "cyan"} className="font-mono">
              [{t}]
            </Badge>
          ))}
        </div>
      </div>
      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl">
            <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
              Agents propose. <span className="text-emerald-300">The contract controls signing.</span>
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              The keyless NEAR contract builds the executable order and controls MPC requests. It enforces order shape, coin caps, expiry and nonce rules.
              Delta and leverage are consistency checks on solver-reported inputs, not verified portfolio exposure.
            </p>
          </div>
          <EvidenceLegend />
        </div>
      </Card>
    </header>
  );
}

type EvidenceKind = "live" | "historical" | "simulated";
const EVIDENCE: Record<EvidenceKind, { label: string; tone: "cyan" | "violet" | "amber"; help: string }> = {
  live: { label: "LIVE READ-ONLY CHECK", tone: "cyan", help: "Queries the deployed contract or a public API now. Writes nothing." },
  historical: { label: "HISTORICAL ON-CHAIN PROOF", tone: "violet", help: "A transaction already executed on NEAR testnet. Not created by your click." },
  simulated: { label: "SIMULATED EXECUTION", tone: "amber", help: "Calculated, quoted, signed locally or prepared. No funds move, nothing is broadcast." },
};

function EvidenceTag({ kind, className }: { kind: EvidenceKind; className?: string }) {
  const e = EVIDENCE[kind];
  return (
    <Badge tone={e.tone} className={cx("font-mono text-[10px] tracking-wide", className)}>
      <span title={e.help}>{e.label}</span>
    </Badge>
  );
}

function EvidenceLegend() {
  return (
    <ul className="grid shrink-0 gap-1.5 text-[11px] text-slate-400 lg:w-[420px]" aria-label="Evidence labels">
      {(Object.keys(EVIDENCE) as EvidenceKind[]).map((k) => (
        <li key={k} className="flex items-start gap-2">
          <EvidenceTag kind={k} className="shrink-0" />
          <span>{EVIDENCE[k].help}</span>
        </li>
      ))}
    </ul>
  );
}

function WhyItMatters() {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <ShieldCheck className="h-4 w-4 text-emerald-400" /> Why does this matter?
      </h2>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-slate-400">
        <p>
          An AI can pick a dangerous trade, and the software that builds the order can be hacked. If either one holds the treasury&apos;s signing key, one bad
          decision can drain it.
        </p>
        <p>
          In ZeroDelta the key is not held by any agent. It is derived by NEAR Chain Signatures for a smart contract that has no access keys of its own. That
          contract checks reported order parameters before requesting a signature. The current v3.1 path also constructs the executable sell itself, with fixed coin caps, expiry and replay protection. A solver can still fabricate holdings and treasury inputs; passing the math does not prove a hedge.
        </p>
        <p className="text-slate-500">
          Limits: reported holdings, treasury, collateral, slippage and reference price are trusted. The TEE is simulated. The v3.1 contract has no buy, reduce-only or withdrawal path; funded positions could not be closed by this key. See docs/SECURITY_MODEL.md.
        </p>
      </div>
    </Card>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  ok?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-slate-500">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {ok === undefined ? null : (
          <span className={cx("h-2 w-2 rounded-full", ok ? "bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" : "bg-rose-500")} />
        )}
      </div>
      <div className="mt-1 truncate font-mono text-sm text-slate-100">{value}</div>
      {sub ? <div className="truncate font-mono text-[11px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

function TelemetryBar({
  telemetry: t,
  loading,
  onRefresh,
}: {
  telemetry: LiveTelemetry | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card className="mt-6 p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Activity className="h-3.5 w-3.5 text-emerald-400" /> Live network telemetry <EvidenceTag kind="live" />
          {t ? <span className="text-slate-600">· {new Date(t.fetchedAt).toLocaleTimeString()}</span> : null}
        </div>
        <button
          onClick={onRefresh}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
        >
          <RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          icon={<Blocks className="h-3 w-3" />}
          label="Testnet block"
          ok={t?.testnet.live}
          value={t?.testnet.latestBlockHeight ? `#${t.testnet.latestBlockHeight.toLocaleString()}` : loading ? "loading…" : "offline"}
          sub={t?.testnet.latestBlockHash ? short(t.testnet.latestBlockHash, 10, 6) : undefined}
        />
        <Stat
          icon={<Blocks className="h-3 w-3" />}
          label="Mainnet block"
          ok={t?.mainnet.live}
          value={t?.mainnet.latestBlockHeight ? `#${t.mainnet.latestBlockHeight.toLocaleString()}` : loading ? "loading…" : "offline"}
          sub={t?.mainnet.gasPriceYocto ? `gas ${t.mainnet.gasPriceYocto} yocto` : undefined}
        />
        <Stat
          icon={<Network className="h-3 w-3" />}
          label="intents.near"
          ok={t?.intentsVerifier.exists && t.intentsVerifier.isContract}
          value={t?.intentsVerifier.exists ? "Verifier live" : loading ? "loading…" : "unreachable"}
          sub={t?.intentsVerifier.codeHash ? `code ${short(t.intentsVerifier.codeHash, 6, 4)}` : undefined}
        />
        <Stat
          icon={<KeyRound className="h-3 w-3" />}
          label="v1.signer-prod.testnet"
          ok={t?.mpc.live}
          value={t?.mpc.version ? `MPC v${t.mpc.version}` : loading ? "loading…" : "unreachable"}
          sub={t?.mpc.signatureDomains !== undefined ? `${t.mpc.signatureDomains} signature domains` : undefined}
        />
        <Stat
          icon={<Coins className="h-3 w-3" />}
          label="1Click tokens"
          ok={t?.oneClick.live}
          value={t ? `${t.oneClick.count} assets` : loading ? "loading…" : "unavailable"}
          sub={t ? `${t.oneClick.chains.length} chains${t.oneClick.live ? "" : " (snapshot)"}` : undefined}
        />
        <Stat
          icon={<Server className="h-3 w-3" />}
          label="RPC latency"
          value={t?.testnet.latencyMs !== undefined ? `${t.testnet.latencyMs} ms` : loading ? "loading…" : "unavailable"}
          sub={t?.testnet.endpoint ? t.testnet.endpoint.replace("https://", "") : undefined}
        />
      </div>
      <OnchainProofStrip onchain={t?.onchain} />
    </Card>
  );
}

function ExplorerLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cx("inline-flex items-center gap-1 text-cyan-300 underline-offset-2 transition hover:text-cyan-200 hover:underline", className)}
    >
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

const TX_SHORT: Record<string, string> = {
  DEPLOY_REGISTER_AND_LOCK: "Deploy + lock",
  RECORD_AND_SIGN_APPROVED_REBALANCE: "Approved + MPC sign",
  ROGUE_REBALANCE_REJECTED: "Rogue rejected",
  PAYLOAD_SWAP_REJECTED: "Spoofed payload rejected",
  REPLAY_REJECTED: "Replay rejected",
};

function OnchainProofStrip({ onchain }: { onchain?: OnchainProofStatus }) {
  const policy = onchain?.guard.policy ?? PROOF.contract.policy;
  const status = (hash: string) => onchain?.transactions.find((t) => t.hash === hash);
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">
          <ShieldCheck className="h-3 w-3 text-emerald-400" /> On-chain Risk Guard (NEAR testnet)
        </span>
        <EvidenceTag kind="live" />
        <ExplorerLink href={nbAccount(PROOF.contract.accountId)} className="font-mono">
          {PROOF.contract.accountId}
        </ExplorerLink>
        <Badge tone="emerald" className="font-mono">
          policy {policy.max_delta_bps}/{policy.max_leverage_x100}/{policy.max_slippage_bps}
        </Badge>
        <Badge tone={onchain?.guard.locked === false ? "rose" : "violet"}>
          <Lock className="h-3 w-3" /> {onchain?.guard.locked === false ? "NOT locked" : onchain?.guard.locked === true ? "locked (0 keys)" : "lock state unavailable"}
        </Badge>
        {onchain?.guard.attestationCount !== undefined ? (
          <Badge tone="cyan">
            {onchain.guard.attestationCount} on-chain attestation{onchain.guard.attestationCount === 1 ? "" : "s"}
          </Badge>
        ) : (
          <Badge tone="slate">{onchain ? "state unavailable" : "verifying…"}</Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EvidenceTag kind="historical" />
        <span className="text-[11px] text-slate-500">Nearblocks Testnet Explorer:</span>
        {PROOF.transactions.map((tx) => {
          const v = status(tx.hash);
          return (
            <span key={tx.hash} className="flex items-center gap-1" title={v ? v.detail : "verifying on-chain status…"}>
              <span className={cx("h-1.5 w-1.5 rounded-full", !v ? "bg-slate-500" : v.matchesExpectation ? "bg-emerald-400" : v.found ? "bg-rose-500" : "bg-slate-600")} />
              <ExplorerLink href={tx.explorerUrl}>{TX_SHORT[tx.kind] ?? tx.kind}</ExplorerLink>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function OnchainProofPanel({ onchain, run }: { onchain?: OnchainProofStatus; run: SwarmRun }) {
  const check = run.onchainCheck;
  if (!onchain) return <div className="text-xs text-slate-500">Loading on-chain proof from NEAR testnet…</div>;
  const cfg = onchain.guard.config;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-emerald-300">
            Deployed Risk Guard v2 contract <EvidenceTag kind="live" />
          </div>
          <KV label="Contract" value={<ExplorerLink href={onchain.contractUrl}>{onchain.contractId}</ExplorerLink>} />
          <KV label="Solver (only allowed caller)" value={<ExplorerLink href={onchain.accounts.solverUrl}>{onchain.accounts.solver}</ExplorerLink>} />
          <KV label="Account locked" value={onchain.guard.locked ? `TRUE (${onchain.guard.accessKeyCount} access keys)` : `FALSE (${onchain.guard.accessKeyCount ?? "?"} keys)`} />
          <KV
            label="Immutable policy"
            value={
              onchain.guard.policy
                ? `delta <= ${onchain.guard.policy.max_delta_bps} bps · leverage <= ${onchain.guard.policy.max_leverage_x100 / 100}x · slippage <= ${onchain.guard.policy.max_slippage_bps} bps`
                : onchain.guard.error ?? "—"
            }
          />
          <KV label="MPC target" value={cfg ? `${cfg.mpc_signer_contract} / ${cfg.mpc_path}` : "—"} />
          <KV label="Last accepted nonce" value={cfg ? String(cfg.last_nonce) : "—"} />
          <KV label="Code hash" value={short(onchain.guard.codeHash, 10, 6)} copy={onchain.guard.codeHash} />
          <KV label="Matches committed WASM" value={onchain.guard.codeHashMatchesProof ? "TRUE" : "FALSE"} />
          <KV label="Attestations stored" value={String(onchain.guard.attestationCount ?? "—")} />
          {onchain.guard.latest ? <KV label="Attestation #0 MPC status" value={onchain.guard.latest.mpc_status} /> : null}
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-cyan-300">
            This run, recomputed by the deployed contract <EvidenceTag kind="live" />
          </div>
          {check ? (
            check.live ? (
              <>
                <KV label="Call" value={`${check.contractId}.check_order_params`} />
                <KV label="Raw legs (cents)" value={`spot ${check.order.spot_long_usd_cents} / short ${check.order.perp_short_usd_cents} / long ${check.order.perp_long_usd_cents}`} />
                <KV label="Contract-computed delta" value={`${check.netDeltaBps} bps`} />
                <KV label="Contract-computed leverage" value={`${((check.leverageX100 ?? 0) / 100).toFixed(2)}x`} />
                <KV label="Payload commitment matches" value={check.payloadMatches ? "TRUE" : "FALSE"} />
                <KV label="Nonce fresh" value={check.nonceFresh ? "TRUE" : "FALSE"} />
                <KV label="Contract verdict" value={check.approved ? "APPROVED" : "REJECTED"} />
                <KV label="Agrees with Agent 3" value={check.approved === (run.guardian.decision === "APPROVED") ? "TRUE" : "FALSE"} />
                {check.violations?.length ? <KV label="Violations" value={check.violations.join("; ")} mono={false} /> : null}
              </>
            ) : (
              <div className="text-xs text-amber-300">Contract unreachable: {check.error}</div>
            )
          ) : (
            <div className="text-xs text-slate-500">Offline run: on-chain check skipped.</div>
          )}
          <div className="mt-3 border-t border-slate-800 pt-2">
            <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-violet-300">
              Contract-gated MPC signing proven on NEAR testnet <EvidenceTag kind="historical" />
            </div>
            <KV
              label="sign() called by"
              value={onchain.mpcGate.verified ? `${onchain.mpcGate.predecessorId} (the contract)` : "not verified"}
            />
            <KV label="Hedge key address" value={onchain.mpcSignature.evmAddress} copy={onchain.mpcSignature.evmAddress} />
            <KV label="Signed payload" value={short(onchain.mpcSignature.payloadHex, 10, 6)} copy={onchain.mpcSignature.payloadHex} />
            <KV label="Recovers to contract's key" value={onchain.mpcSignature.verification.valid ? "TRUE" : "FALSE"} />
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <EvidenceTag kind="historical" /> Five transactions sent once by the setup script. Statuses below are re-verified live; your clicks create none of them.
        </div>
        {onchain.transactions.map((tx) => (
          <div
            key={tx.hash}
            className={cx(
              "rounded-lg border px-3 py-2 text-xs",
              tx.matchesExpectation ? "border-emerald-500/20 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/10",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 font-medium text-slate-200">
                {tx.matchesExpectation ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleX className="h-3.5 w-3.5 text-rose-400" />}
                {tx.label}
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={tx.onchainStatus === "SUCCESS" ? "emerald" : tx.onchainStatus === "FAILURE" ? "amber" : "slate"}>{tx.onchainStatus}</Badge>
                <ExplorerLink href={tx.explorerUrl} className="font-mono">
                  {short(tx.hash, 8, 6)}
                </ExplorerLink>
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] text-slate-500">
              {tx.signerId} {"->"} {tx.receiverId}.{tx.methodName} · {tx.detail}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">
        Statuses come live from a NEAR testnet archival RPC (<span className="font-mono">EXPERIMENTAL_tx_status</span>, wait_until FINAL). The three FAILURE rows are
        attacks: the contract panics with ZERODELTA_REJECTED, stores nothing and never calls the MPC signer.
      </p>
    </div>
  );
}

function ControlPanel(props: {
  treasury: number;
  setTreasury: (n: number) => void;
  pair: PairSelection;
  setPair: (p: PairSelection) => void;
  slices: number;
  setSlices: (n: number) => void;
  autoSlices: boolean;
  setAutoSlices: (b: boolean) => void;
  simulateUnprofitable: boolean;
  setSimulateUnprofitable: (b: boolean) => void;
  running: SwarmMode | null;
  onExecute: (m: SwarmMode) => void;
}) {
  const { treasury, setTreasury, pair, setPair, slices, setSlices, autoSlices, setAutoSlices, simulateUnprofitable, setSimulateUnprofitable, running, onExecute } = props;
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Bot className="h-4 w-4 text-emerald-400" /> Swarm control panel
      </h2>
      <p className="mt-1 text-xs text-slate-500">No wallet needed. Each run creates a fresh ed25519 key on the server and never broadcasts a transaction.</p>

      <div className="mt-5 space-y-5">
        <div>
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="treasury" className="text-slate-400">
              Treasury size
            </label>
            <span className="font-mono text-emerald-300">{usd(treasury, 0)}</span>
          </div>
          <input
            id="treasury"
            type="range"
            min={10_000}
            max={1_000_000}
            step={10_000}
            value={treasury}
            onChange={(e) => setTreasury(Number(e.target.value))}
            className="mt-2 w-full"
          />
          <div className="flex justify-between font-mono text-[10px] text-slate-600">
            <span>$10K</span>
            <span>$1M</span>
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400">Target pair</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {PAIR_OPTIONS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPair(p.id)}
                className={cx(
                  "rounded-lg border px-2 py-2 text-[11px] font-medium transition",
                  p.id === "AUTO" && "col-span-2",
                  pair === p.id
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                    : "border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="slices" className="text-slate-400">
              Encrypted order slices
            </label>
            <span className="font-mono text-cyan-300">{autoSlices ? "auto" : slices}</span>
          </div>
          <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
            <input type="checkbox" checked={autoSlices} onChange={(e) => setAutoSlices(e.target.checked)} className="accent-emerald-500" />
            Let Agent 1 size slices from live liquidity (Agents 1 and 2 renegotiate if slippage is high)
          </label>
          <input
            id="slices"
            type="range"
            min={1}
            max={24}
            step={1}
            value={slices}
            disabled={autoSlices}
            onChange={(e) => setSlices(Number(e.target.value))}
            className="mt-2 w-full disabled:opacity-40"
          />
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2 text-[11px] text-slate-400">
        <input
          type="checkbox"
          checked={simulateUnprofitable}
          onChange={(e) => setSimulateUnprofitable(e.target.checked)}
          className="mt-0.5 accent-amber-500"
        />
        <span>
          Demo override: simulate settlement even if Agent 1 says <span className="font-mono text-amber-300">NO_TRADE</span> (the run is labelled as an
          override and never shown as profitable)
        </span>
      </label>
      <div className="mt-4 space-y-3">
        <button
          disabled={running !== null}
          onClick={() => onExecute("rebalance")}
          className="group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running === "rebalance" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Execute Autonomous Delta-Neutral Rebalance ({usd(treasury, 0)} Treasury)
        </button>
        <button
          disabled={running !== null}
          onClick={() => onExecute("rogue")}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm font-semibold text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running === "rogue" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
          Simulate Rogue AI Directional Gamble (Test Risk Guard)
        </button>
        <button
          disabled={running !== null}
          onClick={() => onExecute("spoofed_metrics")}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running === "spoofed_metrics" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <TriangleAlert className="h-4 w-4" />}
          Simulate Compromised Solver (Spoofed Metrics)
        </button>
      </div>
    </Card>
  );
}

function HonestyPanel() {
  type Row = { label: string; status: string; tone: "emerald" | "amber" | "cyan"; href?: string };
  const tx = (kind: string) => proofTx(kind)?.explorerUrl;
  const rows: Row[] = [
    { label: "NEAR RPC blocks, accounts, MPC contract reads", status: "Live", tone: "emerald" },
    { label: "1Click token list + dry-run quotes", status: "Live", tone: "emerald" },
    { label: "Hyperliquid funding rates", status: "Live", tone: "emerald" },
    { label: "NEP-413 signing + verification", status: "Real crypto", tone: "emerald" },
    { label: "intents.near simulate_intents", status: "Live mainnet dry-run", tone: "emerald" },
    { label: "Risk Guard smart contract", status: "Deployed on testnet", tone: "cyan", href: nbAccount(PROOF.contract.accountId) },
    { label: "Policy 200/300/25 registered + account locked", status: "Testnet tx", tone: "cyan", href: tx("DEPLOY_REGISTER_AND_LOCK") },
    { label: "Contract recomputes order, then calls v1.signer-prod.testnet.sign", status: "Testnet tx", tone: "cyan", href: tx("RECORD_AND_SIGN_APPROVED_REBALANCE") },
    { label: "Rogue 10x order rejected by contract math", status: "Failed tx (on purpose)", tone: "cyan", href: tx("ROGUE_REBALANCE_REJECTED") },
    { label: "Spoofed MPC payload rejected (commitment)", status: "Failed tx (on purpose)", tone: "cyan", href: tx("PAYLOAD_SWAP_REJECTED") },
    { label: "Replayed order rejected (nonce)", status: "Failed tx (on purpose)", tone: "cyan", href: tx("REPLAY_REJECTED") },
    { label: "Try the current contract proposal checks (no signature)", status: "Live v3.1 view (read-only)", tone: "emerald" },
    { label: "Contract recomputes every dashboard run", status: "Live view call", tone: "emerald" },
    { label: "Multi-asset ranking + slice negotiation", status: "Live quotes", tone: "emerald" },
    { label: "v3.1 contract builds the Hyperliquid order + EIP-712 digest (size caps, expiry), then calls MPC sign", status: "Testnet tx", tone: "cyan", href: V3_TX("APPROVED_EXECUTABLE_HEDGE_SIGNED") },
    { label: "Hyperliquid testnet recovers the contract's hedge address from that signature (signer recovery; no order placed)", status: "Recorded exchange response", tone: "cyan" },
    { label: "TEE enclave + attestation (prototype boundary)", status: "Software-simulated", tone: "amber" },
    { label: "Reference price for the v3.1 price band (size is capped in coins regardless)", status: "Trusted solver input", tone: "amber" },
    { label: "Real fills / funds movement / mainnet", status: "None", tone: "amber" },
  ];
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Info className="h-4 w-4 text-cyan-400" /> What is live vs simulated
      </h2>
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">{r.label}</span>
            {r.href ? (
              <a href={r.href} target="_blank" rel="noopener noreferrer" className="shrink-0" title="Open on Nearblocks Testnet Explorer">
                <Badge tone={r.tone} className="hover:brightness-125">
                  {r.status}
                  <ExternalLink className="h-3 w-3" />
                </Badge>
              </a>
            ) : (
              <Badge tone={r.tone} className="shrink-0">
                {r.status}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        No funds move. Swarm runs are dry runs against real contracts and APIs. The five testnet transactions were sent once, by the locked contract account and the solver{" "}
        <a className="text-cyan-300 hover:underline" href={nbAccount(PROOF.accounts.guard)} target="_blank" rel="noopener noreferrer">
          {PROOF.accounts.guard}
        </a>{" "}
        and{" "}
        <a className="text-cyan-300 hover:underline" href={nbAccount(PROOF.accounts.solver)} target="_blank" rel="noopener noreferrer">
          {PROOF.accounts.solver}
        </a>
        .
      </p>
    </Card>
  );
}

function DecisionBanner({ run, running }: { run: SwarmRun | null; running: SwarmMode | null }) {
  if (running) {
    return (
      <Card className="flex items-center gap-3 p-4 text-sm text-slate-300">
        <LoaderCircle className="h-5 w-5 animate-spin text-cyan-400" />
        Running the 3-agent swarm against live NEAR, 1Click and Hyperliquid endpoints…
      </Card>
    );
  }
  if (!run) {
    return (
      <Card className="p-6 text-sm text-slate-400">
        <div className="flex items-center gap-3">
          <Radar className="h-5 w-5 text-emerald-400" />
          Choose a treasury size and pair, then run the swarm. Results, signatures and proofs appear here.
        </div>
      </Card>
    );
  }
  const g = run.guardian;
  const approved = g.decision === "APPROVED";
  // Only an approved run can be "withheld"; a rejected run is shown as rejected.
  const noTrade = run.economics.settlementWithheld && approved;
  return (
    <Card className={cx("p-5", noTrade ? "border-amber-500/40" : approved ? "border-emerald-500/40" : "border-rose-500/50")} aria-live="polite">
      <div className="mb-3 flex flex-wrap gap-1.5">
        <EvidenceTag kind="simulated" />
        {run.onchainCheck?.live ? <EvidenceTag kind="live" /> : null}
        {run.economics.overridden ? <Badge tone="amber">demo override: Agent 1 said NO_TRADE</Badge> : null}
        {run.mode !== "rebalance" ? <Badge tone="rose">attack simulation: {run.mode === "rogue" ? "rogue planner" : "compromised solver"}</Badge> : null}
      </div>
      {noTrade ? (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100">
          <div className="font-semibold">Agent 1 recommends NO_TRADE: the treasury stays in USDC.</div>
          <div className="mt-1 text-amber-200/80">{run.economics.reason}</div>
          <div className="mt-1 text-amber-200/60">The solver and the Risk Guard still ran below so you can inspect them. Tick the demo override to simulate settlement.</div>
        </div>
      ) : null}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className={cx("grid h-14 w-14 place-items-center rounded-2xl", approved ? "bg-emerald-500/15" : "bg-rose-500/15")}>
            {approved ? <ShieldCheck className="h-7 w-7 text-emerald-400" /> : <ShieldAlert className="h-7 w-7 text-rose-400" />}
          </div>
          <div>
            <div className={cx("text-lg font-semibold", approved ? "text-emerald-300" : "text-rose-300")}>
              {noTrade
                ? "Risk-approved, but no trade: economics are negative"
                : approved
                  ? "Risk-approved order, simulated settlement"
                  : run.mode === "spoofed_metrics"
                    ? "Compromised solver caught by the Risk Guard"
                    : "Intent rejected by the Risk Guard"}
            </div>
            <div className="text-xs text-slate-400">
              {noTrade
                ? `All ${g.checks.length} invariants hold, but no intent was sent and no sign request was prepared.`
                : approved
                ? `All ${g.checks.length} invariants hold. ${run.settlement.notes[0]} Contract-gated MPC signing proven on NEAR testnet (historical tx, not this click).`
                : `Violated: ${g.violations.join(", ")}. The intent was never sent and no MPC signature was requested.${run.onchainCheck?.live ? ` The deployed contract also says ${run.onchainCheck.approved ? "APPROVED" : "REJECTED"}.` : ""}`}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <Metric label="Net delta" value={`${(g.metrics.netDeltaRatio * 100).toFixed(2)}%`} bad={!g.checks[0].pass} />
          <Metric label="Leverage" value={`${g.metrics.leverage.toFixed(2)}x`} bad={!g.checks[1].pass} />
          <Metric label="Slippage" value={`${g.metrics.maxPriceImpactBps.toFixed(1)} bps`} bad={!g.checks[2].pass} />
        </div>
      </div>
    </Card>
  );
}

function OrderSummary({ o }: { o: OrderParams }) {
  const m = computeOrderMetrics(o);
  const c = (v: number) => usd(v / 100, 0);
  return (
    <div className="space-y-0.5 font-mono text-[11px]">
      <div>
        spot long {c(o.spot_long_usd_cents)} · perp short {c(o.perp_short_usd_cents)} · perp long {c(o.perp_long_usd_cents)}
      </div>
      <div>
        net delta <span className="font-semibold">{(m.net_delta_bps / 100).toFixed(2)}%</span> · leverage <span className="font-semibold">{(m.leverage_x100 / 100).toFixed(2)}x</span>
      </div>
    </div>
  );
}

function AttackComparison({ run, onchain }: { run: SwarmRun; onchain?: OnchainProofStatus }) {
  const s = run.solver;
  const hidden = s.simulationOnlyHiddenOrder;
  const g = run.guardian;
  const caught = g.checks.filter((c) => !c.pass);
  const swapTx = proofTx("PAYLOAD_SWAP_REJECTED");
  const swapLive = onchain?.transactions.find((t) => t.kind === "PAYLOAD_SWAP_REJECTED");
  return (
    <Card className="border-amber-500/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <TriangleAlert className="h-4 w-4 text-amber-300" /> Compromised-solver attack, side by side
        </h3>
        <EvidenceTag kind="simulated" />
      </div>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-emerald-100">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">1. Solver claim</div>
          <p className="mb-2 text-[11px] text-emerald-200/70">The legs it reports to Agent 3 and would send to the contract.</p>
          <OrderSummary o={s.order} />
        </div>
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-100">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-rose-300">2. Actual payload</div>
          <p className="mb-2 text-[11px] text-rose-200/70">What its MPC payload really commits to (and its slices spend).</p>
          {hidden ? <OrderSummary o={hidden} /> : <span className="text-[11px]">not available</span>}
          <div className="mt-2 font-mono text-[10px] text-rose-200/60">payload {short(s.hedgeOrderPayloadHex, 10, 6)}</div>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-300">3. Risk Guard decision</div>
          <div className={cx("mb-2 font-mono text-sm font-semibold", g.decision === "APPROVED" ? "text-emerald-300" : "text-rose-300")}>{g.decision}</div>
          <ul className="space-y-1 text-[11px] text-slate-300">
            {caught.map((c) => (
              <li key={c.id}>
                <span className="font-mono text-rose-300">{c.id}</span>: {c.detail}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500">Delta and leverage pass because they are computed from the claim. The fingerprint check does not trust the claim.</p>
        </div>
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-300">4. Contract evidence</div>
          {run.onchainCheck?.live ? (
            <div className="mb-2 text-[11px] text-slate-300">
              <EvidenceTag kind="live" /> <span className="font-mono">check_order_params</span>:{" "}
              <span className="font-mono text-rose-300">{run.onchainCheck.violations?.map((v) => v.split(":")[0]).join(", ") || "approved"}</span>
            </div>
          ) : (
            <div className="mb-2 text-[11px] text-slate-500">Live contract check unavailable for this run.</div>
          )}
          {swapTx ? (
            <div className="text-[11px] text-slate-300">
              <EvidenceTag kind="historical" /> the same attack sent on-chain:{" "}
              <ExplorerLink href={swapTx.explorerUrl} className="font-mono">
                {short(swapTx.hash, 8, 6)}
              </ExplorerLink>{" "}
              failed with <span className="font-mono text-rose-300">{swapTx.expectedError}</span>
              {swapLive ? <span className="text-slate-500"> ({swapLive.matchesExpectation ? "re-verified now" : "re-verification failed"})</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, bad }: { label: string; value: string; bad: boolean }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cx("font-mono text-lg font-semibold", bad ? "text-rose-400" : "text-emerald-300")}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function StepShell({
  index,
  title,
  icon,
  state,
  durationMs,
  children,
}: {
  index: number;
  title: string;
  icon: React.ReactNode;
  state: "idle" | "running" | "done" | "approved" | "rejected" | "blocked" | "skipped";
  durationMs?: number;
  children?: React.ReactNode;
}) {
  const badge = {
    idle: <Badge>waiting</Badge>,
    running: (
      <Badge tone="cyan">
        <LoaderCircle className="h-3 w-3 animate-spin" /> running
      </Badge>
    ),
    done: (
      <Badge tone="emerald">
        <CircleCheck className="h-3 w-3" /> completed
      </Badge>
    ),
    approved: (
      <Badge tone="emerald">
        <ShieldCheck className="h-3 w-3" /> approved
      </Badge>
    ),
    rejected: (
      <Badge tone="rose">
        <CircleX className="h-3 w-3" /> rejected
      </Badge>
    ),
    blocked: (
      <Badge tone="rose">
        <Lock className="h-3 w-3" /> blocked
      </Badge>
    ),
    skipped: <Badge tone="amber">skipped</Badge>,
  }[state];
  return (
    <Card
      className={cx(
        "p-5 transition",
        state === "running" && "border-cyan-500/40",
        state === "rejected" && "border-rose-500/40",
        state === "approved" && "border-emerald-500/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-800 text-slate-200">{icon}</div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Agent {index}</div>
            <div className="text-sm font-semibold text-white">{title}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {durationMs !== undefined ? (
            <span className="flex items-center gap-1 font-mono text-[11px] text-slate-500">
              <Clock className="h-3 w-3" />
              {durationMs} ms
            </span>
          ) : null}
          {badge}
        </div>
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}

function Pipeline({ run, phase, running }: { run: SwarmRun | null; phase: number; running: SwarmMode | null }) {
  const stateFor = (i: number): "idle" | "running" | "done" => {
    if (!running) return "idle";
    if (phase > i) return "done";
    return phase === i ? "running" : "idle";
  };
  if (!run) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
        <StepShell index={1} title="Autonomous Opportunity Scanner" icon={<Radar className="h-4 w-4" />} state={stateFor(1)} />
        <StepShell index={2} title="Order Solver (simulated TEE)" icon={<Cpu className="h-4 w-4" />} state={stateFor(2)} />
        <StepShell index={3} title="Delta Risk Guard" icon={<ShieldCheck className="h-4 w-4" />} state={stateFor(3)} />
      </div>
    );
  }
  const step = (agent: string) => run.steps.find((s) => s.agent === agent);
  const g = run.guardian;
  return (
    <div className="space-y-6">
      <StepShell index={1} title="Autonomous Opportunity Scanner" icon={<Radar className="h-4 w-4" />} state="done" durationMs={step("scanner")?.durationMs}>
        <ScannerView run={run} />
      </StepShell>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <StepShell index={2} title="Order Solver (simulated TEE)" icon={<Cpu className="h-4 w-4" />} state="done" durationMs={step("solver")?.durationMs}>
          <SolverView run={run} />
        </StepShell>
        <StepShell
          index={3}
          title="Delta Risk Guard"
          icon={<ShieldCheck className="h-4 w-4" />}
          state={g.decision === "APPROVED" ? "approved" : "rejected"}
          durationMs={step("guardian")?.durationMs}
        >
          <GuardianView run={run} />
        </StepShell>
      </div>
      <SettlementView run={run} />
    </div>
  );
}

function ScannerView({ run }: { run: SwarmRun }) {
  const s = run.scanner;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={s.sources.funding.live ? "emerald" : "amber"}>funding: {s.sources.funding.live ? "live Hyperliquid" : "snapshot"}</Badge>
        <Badge tone={s.sources.tokens.live ? "emerald" : "amber"}>1Click: {s.sources.tokens.count} tokens</Badge>
        <Badge tone={s.sources.costs.includes("1click-live") ? "emerald" : "amber"}>costs: {s.sources.costs.join(", ")}</Badge>
        <Badge tone="cyan">{s.selection.mode === "auto" ? "autonomous selection" : "manual override"}</Badge>
      </div>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[760px] text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="py-1 font-medium">#</th>
              <th className="py-1 font-medium">Market</th>
              <th className="py-1 text-right font-medium">Funding APR</th>
              <th className="py-1 text-right font-medium">1Click round trip</th>
              <th className="py-1 text-right font-medium">Net carry APR</th>
              <th className="py-1 text-right font-medium">Breakeven</th>
              <th className="py-1 text-right font-medium">Hedge</th>
              <th className="py-1 text-right font-medium">Slices</th>
              <th className="py-1 pl-3 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {s.opportunityMatrix.map((o) => (
              <tr key={o.asset} className={cx("border-t border-slate-800/80", o.asset === s.selected.asset && "bg-emerald-500/5 text-emerald-300")}>
                <td className="py-1.5">{o.rank}</td>
                <td className="py-1.5">{o.pairLabel}</td>
                <td className={cx("py-1.5 text-right", o.grossCarryAprPct < 0 && "text-rose-400")}>{o.grossCarryAprPct.toFixed(2)}%</td>
                <td className="py-1.5 text-right text-slate-400">{o.estimatedRoundTripCostBps.toFixed(1)} bps</td>
                <td className={cx("py-1.5 text-right font-semibold", o.netCarryAprPct < 0 ? "text-rose-400" : "text-emerald-300")}>{o.netCarryAprPct.toFixed(2)}%</td>
                <td className="py-1.5 text-right text-slate-400">{o.breakevenDays === null ? "never" : `${o.breakevenDays} d`}</td>
                <td className="py-1.5 text-right text-slate-400">{o.hedgeLeverage}x</td>
                <td className="py-1.5 text-right text-slate-400">{o.recommendedSlices}</td>
                <td className="py-1.5 pl-3 font-sans text-[11px] text-slate-500">{o.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <KV label="Decision" value={s.selection.reason} mono={false} />
          <KV label="Expected treasury APR (net)" value={`${s.expectedTreasuryAprPct.toFixed(2)}%`} />
          <KV label="Slice sizing" value={s.sliceRationale} mono={false} />
          <KV label="Proposed plan" value={s.plan.planId} copy={s.plan.planId} />
        </div>
        {run.injectedPlan ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="h-3.5 w-3.5" /> Rogue plan injected
            </div>
            {run.injectedPlan.legs.map((l) => (
              <div key={l.id} className="flex justify-between font-mono">
                <span>
                  {l.kind} {l.side} {l.asset}
                </span>
                <span>{usd(l.notionalUsd, 0)}</span>
              </div>
            ))}
          </div>
        ) : (
          <ul className="list-disc space-y-1 rounded-xl border border-slate-800 bg-slate-950/60 py-3 pl-7 pr-3 text-[11px] leading-relaxed text-slate-400">
            {s.plan.rationale.map((r) => (
              <li key={r}>{r}</li>
            ))}
            <li>
              Costs: 2 x live 1Click entry + 2 x {s.assumptions.perpTakerFeeBps} bps perp taker fee, amortised over {s.assumptions.holdingDays} days.
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}

function NegotiationLog({ run }: { run: SwarmRun }) {
  if (run.negotiation.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
        <Bot className="h-3.5 w-3.5" /> Agent 1 / Agent 2 negotiation ({run.negotiation.length} round{run.negotiation.length === 1 ? "" : "s"})
      </div>
      <div className="space-y-1">
        {run.negotiation.map((n) => (
          <div key={n.round} className="grid grid-cols-[52px_70px_80px_1fr] items-center gap-2 font-mono text-[10px]">
            <span className="text-slate-500">round {n.round}</span>
            <span className="text-slate-300">{n.sliceCount} slices</span>
            <span className={n.observedSlippageBps > n.targetBps ? "text-amber-300" : "text-emerald-300"}>{n.observedSlippageBps} bps</span>
            <span className={cx("truncate", n.action === "RESLICE_REQUESTED" ? "text-cyan-300" : "text-slate-400")} title={n.note}>
              {n.action === "RESLICE_REQUESTED" ? `SOLVER_SLIPPAGE_FEEDBACK -> SCANNER_RESLICE ${n.nextSliceCount}` : n.action}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1 text-[10px] text-slate-500">Target {run.negotiation[0].targetBps} bps per slice; guard ceiling {run.negotiation[0].ceilingBps} bps.</div>
    </div>
  );
}

function SolverView({ run }: { run: SwarmRun }) {
  const s = run.solver;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
            <Fingerprint className="h-3.5 w-3.5" /> Enclave attestation
          </span>
          <Badge tone="amber">{s.attestation.report.teeType}</Badge>
        </div>
        <KV label="Measurement" value={short(s.attestation.report.measurement, 10, 8)} copy={s.attestation.report.measurement} />
        <KV label="Enclave key" value={short(s.attestation.report.enclavePublicKey, 8, 6)} copy={s.attestation.report.enclavePublicKey} />
        <KV label="Report data" value={short(s.attestation.report.reportData, 8, 6)} copy={s.attestation.report.reportData} />
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-cyan-300">
          <Lock className="h-3.5 w-3.5" /> {s.envelope.sliceCount} encrypted slices (nacl.box)
        </div>
        <div className="scrollbar-thin max-h-24 space-y-1 overflow-auto">
          {s.envelope.slices.map((sl) => (
            <div key={sl.index} className="flex justify-between gap-2 font-mono text-[10px] text-slate-500">
              <span>#{sl.index}</span>
              <span className="truncate text-slate-400">{sl.ciphertext.slice(0, 28)}…</span>
              <span className="text-slate-600">{sl.commitment.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        {s.quotes.map((q) => (
          <div key={q.legId} className="rounded-lg border border-slate-800 px-3 py-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-300">{q.legId}</span>
              <Badge tone={q.source === "1click-live" ? "emerald" : "amber"}>{q.source}</Badge>
            </div>
            <div className="mt-1 flex justify-between font-mono text-[11px] text-slate-400">
              <span>
                {usd(q.amountInUsd)} in, {usd(q.amountOutUsd)} out
              </span>
              <span>
                {q.priceImpactBps} bps slip · {q.totalCostBps} bps cost
              </span>
            </div>
          </div>
        ))}
      </div>
      <NegotiationLog run={run} />
      <div className={cx("rounded-xl border p-3", s.compromised ? "border-amber-500/40 bg-amber-500/10" : "border-slate-800 bg-slate-950/60")}>
        <div className="mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
            <KeyRound className="h-3.5 w-3.5" /> Order commitment for the Risk Guard
          </span>
          {s.compromised ? <Badge tone="amber">compromised solver</Badge> : null}
        </div>
        <KV label="Raw legs (cents)" value={`spot ${s.order.spot_long_usd_cents} · short ${s.order.perp_short_usd_cents} · long ${s.order.perp_long_usd_cents}`} />
        <KV label="Replay nonce" value={String(s.order.nonce)} />
        <KV label="Hedge payload (keccak256)" value={short(s.hedgeOrderPayloadHex, 10, 6)} copy={s.hedgeOrderPayloadHex} />
        <KV label="Committed to" value={s.commitmentContractId} />
      </div>
      <KV label="Signer (implicit)" value={short(s.signer.accountId, 10, 6)} copy={s.signer.accountId} />
    </div>
  );
}

function GuardianView({ run }: { run: SwarmRun }) {
  const g = run.guardian;
  return (
    <div className="space-y-2">
      {g.checks.map((c) => (
        <div
          key={c.id}
          className={cx(
            "rounded-lg border px-3 py-2",
            c.pass ? "border-emerald-500/20 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/10",
          )}
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-slate-200">
              {c.pass ? <CircleCheck className="h-3.5 w-3.5 text-emerald-400" /> : <CircleX className="h-3.5 w-3.5 text-rose-400" />}
              {c.label}
            </span>
            <span className={cx("font-mono", c.pass ? "text-emerald-300" : "text-rose-300")}>{c.observed}</span>
          </div>
          <div className="mt-0.5 flex justify-between gap-2 font-mono text-[10px] text-slate-500">
            <span className="truncate">{c.formula}</span>
            <span className="shrink-0">{c.threshold.length > 22 ? "" : c.threshold}</span>
          </div>
        </div>
      ))}
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        {run.onchainCheck?.live ? (
          <KV
            label="Testnet contract verdict"
            value={
              <span className={run.onchainCheck.approved ? "text-emerald-300" : "text-rose-300"}>
                {run.onchainCheck.approved ? "APPROVED" : "REJECTED"} (check_order_params: {run.onchainCheck.netDeltaBps} bps, {((run.onchainCheck.leverageX100 ?? 0) / 100).toFixed(2)}x)
              </span>
            }
          />
        ) : null}
        <KV
          label="MPC authorization"
          value={g.mpcSignRequest ? `prepared, not broadcast: ${g.mpcSignRequest.contractId}.record_rebalance` : run.economics.settlementWithheld ? "none (NO_TRADE)" : "none (blocked)"}
        />
        <KV label={g.decision === "APPROVED" ? "Approval proof" : "Rejection proof"} value={short(g.decisionHash, 10, 6)} copy={g.decisionHash} />
        <KV label="Guardian signature" value={short(g.guardianSignature, 10, 6)} copy={g.guardianSignature} />
      </div>
    </div>
  );
}

function SettlementView({ run }: { run: SwarmRun }) {
  const st = run.settlement;
  const sim = st.simulation;
  const approved = run.guardian.decision === "APPROVED";
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Layers className="h-4 w-4 text-cyan-400" /> {st.status === "DRY_RUN_SETTLED"
            ? "Target cross-chain allocation (dry-run settled)"
            : st.status === "SKIPPED_OFFLINE"
              ? "Target cross-chain allocation (offline: not simulated)"
              : "Treasury allocation (unchanged)"}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <EvidenceTag kind="simulated" />
          <Badge tone={st.status === "DRY_RUN_SETTLED" ? "emerald" : st.status === "BLOCKED_BY_GUARD" ? "rose" : "amber"}>{st.status}</Badge>
          {sim ? <Badge tone={sim.status === "INVALID_SIGNATURE" ? "rose" : "emerald"}>intents.near: {sim.status}</Badge> : null}
        </div>
      </div>
      <div className="scrollbar-thin mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="py-1.5 font-medium">Chain</th>
              <th className="py-1.5 font-medium">Role</th>
              <th className="py-1.5 font-medium">Asset</th>
              <th className="py-1.5 text-right font-medium">Amount</th>
              <th className="py-1.5 text-right font-medium">Value</th>
              <th className="py-1.5 text-right font-medium">Delta</th>
            </tr>
          </thead>
          <tbody>
            {st.allocation.map((a) => (
              <tr key={`${a.chain}-${a.role}`} className="border-t border-slate-800/80">
                <td className="py-2 font-medium text-slate-200">{a.chain}</td>
                <td className="py-2 text-slate-400">{a.role}</td>
                <td className="py-2 font-mono text-slate-300">{a.asset}</td>
                <td className="py-2 text-right font-mono text-slate-300">{a.amount}</td>
                <td className={cx("py-2 text-right font-mono", a.usd < 0 ? "text-amber-300" : "text-slate-300")}>{a.usd === 0 ? "—" : usd(a.usd)}</td>
                <td className={cx("py-2 text-right font-mono", a.deltaUsd > 0 ? "text-emerald-300" : a.deltaUsd < 0 ? "text-cyan-300" : "text-slate-500")}>
                  {a.deltaUsd === 0 ? "0" : `${a.deltaUsd > 0 ? "+" : "-"}${usd(Math.abs(a.deltaUsd), 0)}`}
                </td>
              </tr>
            ))}
            {approved ? (
              <tr className="border-t border-slate-700">
                <td colSpan={5} className="py-2 text-right text-[11px] uppercase tracking-wider text-slate-500">
                  Net delta
                </td>
                <td className="py-2 text-right font-mono font-semibold text-emerald-300">{usd(run.guardian.metrics.netDeltaUsd, 2)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
        {run.mpcAccount?.evmAddress ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-violet-300">
              <Wallet className="h-3.5 w-3.5" /> Chain Signatures hedge account
            </div>
            <KV label="EVM address" value={short(run.mpcAccount.evmAddress, 10, 8)} copy={run.mpcAccount.evmAddress} />
            <KV label="Path" value={run.mpcAccount.path} />
            <KV label="Predecessor" value={run.mpcAccount.predecessor} />
          </div>
        ) : null}
        <ul className="space-y-1.5 text-[11px] leading-relaxed text-slate-400">
          {st.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <Info className="mt-0.5 h-3 w-3 shrink-0 text-slate-600" />
              {n}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Proof inspector
// ---------------------------------------------------------------------------

function ProofInspector({
  run,
  tab,
  setTab,
  onchain,
}: {
  run: SwarmRun;
  tab: ProofTab;
  setTab: (t: ProofTab) => void;
  onchain?: OnchainProofStatus;
}) {
  const s = run.solver;
  const sigCheck = run.guardian.checks.find((c) => c.id === "NEP413_SIGNATURE");
  const sim = run.settlement.simulation;
  const tabs: { id: ProofTab; label: string }[] = [
    { id: "intent", label: "NEP-413 intent" },
    { id: "mpc", label: "Guard-gated MPC request" },
    { id: "attestation", label: "TEE attestation" },
    { id: "onchain", label: "On-chain proof (testnet)" },
    { id: "audit", label: `Audit trail (${run.audit.events.length})` },
  ];
  const nonceHex = s.intent.nonceHex;
  const accepted = useMemo(
    () => (sim ? sim.status === "EXECUTED" || sim.status === "SIGNATURE_ACCEPTED_UNFUNDED" : null),
    [sim],
  );
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Hash className="h-4 w-4 text-emerald-400" /> Cryptographic proof inspector
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={sigCheck?.pass ? "emerald" : "rose"}>Signature Verified: {sigCheck?.pass ? "TRUE" : "FALSE"}</Badge>
          {accepted !== null ? (
            <Badge tone={accepted ? "emerald" : "rose"}>intents.near accepted signature: {accepted ? "TRUE" : "FALSE"}</Badge>
          ) : (
            <Badge tone="slate">not submitted to intents.near</Badge>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1 border-b border-slate-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition",
              tab === t.id ? "border-emerald-400 text-emerald-300" : "border-transparent text-slate-500 hover:text-slate-300",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "intent" ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-0.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <KV label="standard" value="nep413" />
              <KV label="recipient" value={s.intent.signed.payload.recipient} />
              <KV label="signer_id" value={short(s.intent.signerId, 12, 8)} copy={s.intent.signerId} />
              <KV label="publicKey" value={short(s.intent.signed.public_key, 14, 6)} copy={s.intent.signed.public_key} />
              <KV label="nonce (32 B, hex)" value={short(nonceHex, 12, 8)} copy={nonceHex} />
              <KV label="nonce (base64)" value={s.intent.signed.payload.nonce} copy={s.intent.signed.payload.nonce} />
              <KV label="sha256(borsh payload)" value={short(s.intent.payloadHashHex, 12, 8)} copy={s.intent.payloadHashHex} />
              <KV label="signature (hex)" value={short(s.intent.signatureHex, 12, 8)} copy={s.intent.signatureHex} />
              <KV label="signature (base64)" value={short(s.intent.signatureBase64, 12, 8)} copy={s.intent.signatureBase64} />
              <KV label="signature (NEAR)" value={short(s.intent.signed.signature, 14, 6)} copy={s.intent.signed.signature} />
              {sim?.panicMessage ? <KV label="intents.near response" value={sim.panicMessage} mono={false} /> : null}
            </div>
            <CodeBlock value={{ ...s.intent.signed, payload: { ...s.intent.signed.payload, message: s.intent.message } }} />
          </div>
        ) : null}
        {tab === "mpc" ? (
          run.guardian.mpcSignRequest ? (
            <div className="space-y-3">
              <EvidenceTag kind="simulated" />
              <p className="text-xs text-slate-400">
                Approved by Agent 3. The solver may only send this <span className="font-mono text-slate-200">record_rebalance</span> call to the Risk Guard contract{" "}
                <span className="font-mono text-slate-200">{run.guardian.mpcSignRequest.contractId}</span>. The contract recomputes delta and leverage from reported legs and trusted treasury/collateral values,
                checks that the payload equals keccak256 of those legs and that the nonce is fresh, and only then calls{" "}
                <span className="font-mono text-slate-200">v1.signer-prod.testnet.sign</span> itself, as the predecessor that owns the hedge key. Prepared, not
                broadcast.
              </p>
              <CodeBlock value={run.guardian.mpcSignRequest} />
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
              <Lock className="h-4 w-4" />
              {run.economics.settlementWithheld && run.guardian.decision === "APPROVED"
                ? "No record_rebalance call was prepared: Agent 3 approved the risk, but Agent 1 recommends NO_TRADE, so no signature is requested."
                : "No record_rebalance call exists for this run: Agent 3 refused it, and the contract would refuse it too (see the On-chain proof tab)."}
            </div>
          )
        ) : null}
        {tab === "attestation" ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
            <CodeBlock value={s.attestation} />
            <CodeBlock value={{ verification: run.guardian.attestation, envelope: { ...s.envelope, slices: `${s.envelope.slices.length} ciphertexts` } }} />
          </div>
        ) : null}
        {tab === "onchain" ? <OnchainProofPanel onchain={onchain} run={run} /> : null}
        {tab === "audit" ? (
          <div className="scrollbar-thin max-h-96 space-y-1 overflow-auto">
            {run.audit.events.map((e) => (
              <div key={e.seq} className="grid grid-cols-[28px_90px_170px_1fr_110px] items-center gap-2 rounded-lg px-2 py-1.5 font-mono text-[11px] odd:bg-slate-950/50">
                <span className="text-slate-600">{e.seq}</span>
                <span className="text-slate-500">{e.agent}</span>
                <span className={cx(e.event.includes("REJECT") || e.event.includes("BLOCK") || e.event.includes("ROGUE") ? "text-rose-300" : "text-emerald-300")}>{e.event}</span>
                <span className="truncate text-slate-400" title={e.detail}>
                  {e.detail}
                </span>
                <span className="text-right text-slate-600" title={e.hash}>
                  {e.hash.slice(0, 12)}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2 px-2 pt-2 text-[11px] text-slate-500">
              <Gauge className="h-3.5 w-3.5" /> Chain root <span className="font-mono text-slate-300">{run.audit.rootHash}</span>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
