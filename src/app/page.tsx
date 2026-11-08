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
} from "lucide-react";
import type { LiveTelemetry } from "@/lib/near/rpcClient";
import type { SwarmRun } from "@/lib/swarm/orchestrator";
import type { PairId, SwarmMode } from "@/lib/swarm/types";
import { Badge, Card, CodeBlock, KV, cx, short, usd } from "@/components/ui";

const PAIR_OPTIONS: { id: PairId; label: string }[] = [
  { id: "NEAR", label: "NEAR-PERP / wNEAR" },
  { id: "SOL", label: "SOL-PERP / SOL" },
  { id: "ETH", label: "ETH-PERP / ETH" },
];

const TRACKS = ["01 / DFI", "03 / PRV", "04 / BUS", "05 / SWM"];

type ProofTab = "intent" | "mpc" | "attestation" | "audit";

export default function Dashboard() {
  const [telemetry, setTelemetry] = useState<LiveTelemetry | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [treasury, setTreasury] = useState(50_000);
  const [pair, setPair] = useState<PairId>("NEAR");
  const [slices, setSlices] = useState(8);
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
          body: JSON.stringify({ mode, treasuryUsd: treasury, pair, sliceCount: slices }),
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
    [treasury, pair, slices],
  );

  return (
    <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-6 sm:px-6">
      <Header />
      <TelemetryBar telemetry={telemetry} loading={telemetryLoading} onRefresh={() => void loadTelemetry()} />

      <div className="mt-6 grid gap-6 xl:grid-cols-[380px_1fr]">
        <div className="space-y-6">
          <ControlPanel
            treasury={treasury}
            setTreasury={setTreasury}
            pair={pair}
            setPair={setPair}
            slices={slices}
            setSlices={setSlices}
            running={running}
            onExecute={execute}
          />
          <HonestyPanel />
        </div>

        <div className="space-y-6">
          {error ? (
            <Card className="border-rose-500/40 p-4 text-sm text-rose-300">
              <div className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4" /> Swarm run failed: {error}
              </div>
            </Card>
          ) : null}
          <DecisionBanner run={run} running={running} />
          <Pipeline run={run} phase={phase} running={running} />
          {run ? <ProofInspector run={run} tab={tab} setTab={setTab} /> : null}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Header() {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 text-slate-950 shadow-lg shadow-emerald-500/20">
            <Scale className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              Zero<span className="text-emerald-400">Delta</span>
            </h1>
            <p className="text-xs text-slate-400">Confidential cross-chain delta-neutral intent solver swarm on NEAR</p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {TRACKS.map((t) => (
          <Badge key={t} tone="cyan" className="font-mono">
            [{t}]
          </Badge>
        ))}
      </div>
    </header>
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
          <Activity className="h-3.5 w-3.5 text-emerald-400" /> Live network telemetry
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
          value={t?.testnet.latestBlockHeight ? `#${t.testnet.latestBlockHeight.toLocaleString()}` : loading ? "…" : "offline"}
          sub={t?.testnet.latestBlockHash ? short(t.testnet.latestBlockHash, 10, 6) : undefined}
        />
        <Stat
          icon={<Blocks className="h-3 w-3" />}
          label="Mainnet block"
          ok={t?.mainnet.live}
          value={t?.mainnet.latestBlockHeight ? `#${t.mainnet.latestBlockHeight.toLocaleString()}` : loading ? "…" : "offline"}
          sub={t?.mainnet.gasPriceYocto ? `gas ${t.mainnet.gasPriceYocto} yocto` : undefined}
        />
        <Stat
          icon={<Network className="h-3 w-3" />}
          label="intents.near"
          ok={t?.intentsVerifier.exists && t.intentsVerifier.isContract}
          value={t?.intentsVerifier.exists ? "Verifier live" : loading ? "…" : "unreachable"}
          sub={t?.intentsVerifier.codeHash ? `code ${short(t.intentsVerifier.codeHash, 6, 4)}` : undefined}
        />
        <Stat
          icon={<KeyRound className="h-3 w-3" />}
          label="v1.signer-prod.testnet"
          ok={t?.mpc.live}
          value={t?.mpc.version ? `MPC v${t.mpc.version}` : loading ? "…" : "unreachable"}
          sub={t?.mpc.signatureDomains !== undefined ? `${t.mpc.signatureDomains} signature domains` : undefined}
        />
        <Stat
          icon={<Coins className="h-3 w-3" />}
          label="1Click tokens"
          ok={t?.oneClick.live}
          value={t ? `${t.oneClick.count} assets` : "…"}
          sub={t ? `${t.oneClick.chains.length} chains${t.oneClick.live ? "" : " (snapshot)"}` : undefined}
        />
        <Stat
          icon={<Server className="h-3 w-3" />}
          label="RPC latency"
          value={t?.testnet.latencyMs !== undefined ? `${t.testnet.latencyMs} ms` : "…"}
          sub={t?.testnet.endpoint ? t.testnet.endpoint.replace("https://", "") : undefined}
        />
      </div>
    </Card>
  );
}

function ControlPanel(props: {
  treasury: number;
  setTreasury: (n: number) => void;
  pair: PairId;
  setPair: (p: PairId) => void;
  slices: number;
  setSlices: (n: number) => void;
  running: SwarmMode | null;
  onExecute: (m: SwarmMode) => void;
}) {
  const { treasury, setTreasury, pair, setPair, slices, setSlices, running, onExecute } = props;
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Bot className="h-4 w-4 text-emerald-400" /> Swarm control panel
      </h2>
      <p className="mt-1 text-xs text-slate-500">No wallet needed. Each run creates a fresh ed25519 key on the server.</p>

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
          <div className="mt-2 grid grid-cols-3 gap-2">
            {PAIR_OPTIONS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPair(p.id)}
                className={cx(
                  "rounded-lg border px-2 py-2 text-[11px] font-medium transition",
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
              Confidential order slices
            </label>
            <span className="font-mono text-cyan-300">{slices}</span>
          </div>
          <input
            id="slices"
            type="range"
            min={1}
            max={24}
            step={1}
            value={slices}
            onChange={(e) => setSlices(Number(e.target.value))}
            className="mt-2 w-full"
          />
        </div>
      </div>

      <div className="mt-6 space-y-3">
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
      </div>
    </Card>
  );
}

function HonestyPanel() {
  const rows: [string, string, "emerald" | "amber"][] = [
    ["NEAR RPC blocks, accounts, MPC contract reads", "Live", "emerald"],
    ["1Click token list + dry-run quotes", "Live", "emerald"],
    ["Hyperliquid funding rates", "Live", "emerald"],
    ["NEP-413 signing + verification", "Real crypto", "emerald"],
    ["intents.near simulate_intents", "Live mainnet dry-run", "emerald"],
    ["Chain Signatures derived hedge address", "Live testnet view", "emerald"],
    ["TEE enclave + attestation", "Software-simulated", "amber"],
    ["MPC sign() broadcast / real fills", "Prepared, not sent", "amber"],
  ];
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Info className="h-4 w-4 text-cyan-400" /> What is live vs simulated
      </h2>
      <ul className="mt-3 space-y-1.5">
        {rows.map(([label, status, tone]) => (
          <li key={label} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-400">{label}</span>
            <Badge tone={tone}>{status}</Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">No funds move. Every run is a dry run against real contracts and APIs.</p>
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
  return (
    <Card className={cx("p-5", approved ? "border-emerald-500/40" : "border-rose-500/50")}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className={cx("grid h-14 w-14 place-items-center rounded-2xl", approved ? "bg-emerald-500/15" : "bg-rose-500/15")}>
            {approved ? <ShieldCheck className="h-7 w-7 text-emerald-400" /> : <ShieldAlert className="h-7 w-7 text-rose-400" />}
          </div>
          <div>
            <div className={cx("text-lg font-semibold", approved ? "text-emerald-300" : "text-rose-300")}>
              {approved ? "Intent approved and dry-run settled" : "Intent rejected by the Risk Guard"}
            </div>
            <div className="text-xs text-slate-400">
              {approved
                ? `All ${g.checks.length} invariants hold. ${run.settlement.notes[0]}`
                : `Violated: ${g.violations.join(", ")}. The intent was never sent and no MPC signature was requested.`}
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
      <div className="grid gap-6 lg:grid-cols-3">
        <StepShell index={1} title="Opportunity & Funding Scanner" icon={<Radar className="h-4 w-4" />} state={stateFor(1)} />
        <StepShell index={2} title="Confidential TEE Solver" icon={<Cpu className="h-4 w-4" />} state={stateFor(2)} />
        <StepShell index={3} title="Delta Risk Guard" icon={<ShieldCheck className="h-4 w-4" />} state={stateFor(3)} />
      </div>
    );
  }
  const step = (agent: string) => run.steps.find((s) => s.agent === agent);
  const g = run.guardian;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 2xl:grid-cols-3">
        <StepShell index={1} title="Opportunity & Funding Scanner" icon={<Radar className="h-4 w-4" />} state="done" durationMs={step("scanner")?.durationMs}>
          <ScannerView run={run} />
        </StepShell>
        <StepShell index={2} title="Confidential TEE Solver" icon={<Cpu className="h-4 w-4" />} state="done" durationMs={step("solver")?.durationMs}>
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
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <th className="py-1 font-medium">Perp</th>
            <th className="py-1 text-right font-medium">Funding APR</th>
            <th className="py-1 text-right font-medium">Basis</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {s.scans.map((m) => (
            <tr key={m.asset} className={cx("border-t border-slate-800/80", m.asset === s.selected.asset && "text-emerald-300")}>
              <td className="py-1.5">{m.asset}-PERP</td>
              <td className={cx("py-1.5 text-right", m.fundingAprPct < 0 && "text-rose-400")}>{m.fundingAprPct.toFixed(2)}%</td>
              <td className="py-1.5 text-right text-slate-400">{m.basisBps === null ? "—" : `${m.basisBps.toFixed(1)} bps`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
        <KV label="Expected treasury APR" value={`${s.expectedTreasuryAprPct.toFixed(2)}%`} mono />
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
        <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-slate-400">
          {s.plan.rationale.slice(0, 2).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
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
          <Layers className="h-4 w-4 text-cyan-400" /> {approved ? "Target cross-chain allocation (dry-run settled)" : "Treasury allocation (unchanged)"}
        </h3>
        <div className="flex flex-wrap gap-1.5">
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
      <div className="mt-4 grid gap-3 md:grid-cols-2">
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

function ProofInspector({ run, tab, setTab }: { run: SwarmRun; tab: ProofTab; setTab: (t: ProofTab) => void }) {
  const s = run.solver;
  const sigCheck = run.guardian.checks.find((c) => c.id === "NEP413_SIGNATURE");
  const sim = run.settlement.simulation;
  const tabs: { id: ProofTab; label: string }[] = [
    { id: "intent", label: "NEP-413 intent" },
    { id: "mpc", label: "MPC sign request" },
    { id: "attestation", label: "TEE attestation" },
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
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
              <p className="text-xs text-slate-400">
                Approved by the guard. This is the exact call the guardian account would make on{" "}
                <span className="font-mono text-slate-200">v1.signer-prod.testnet</span> to have the MPC network sign the hedge order digest. It is prepared, not broadcast.
              </p>
              <CodeBlock value={run.guardian.mpcSignRequest} />
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200">
              <Lock className="h-4 w-4" /> No MPC sign request exists for this run: the Risk Guard refused to authorize it.
            </div>
          )
        ) : null}
        {tab === "attestation" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock value={s.attestation} />
            <CodeBlock value={{ verification: run.guardian.attestation, envelope: { ...s.envelope, slices: `${s.envelope.slices.length} ciphertexts` } }} />
          </div>
        ) : null}
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
