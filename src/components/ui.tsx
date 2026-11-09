"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function short(value: string | undefined, head = 8, tail = 6) {
  if (!value) return "—";
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function usd(n: number, dp = 2) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp })}`;
}

export function Card({ children, className, ...rest }: { children: React.ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div {...rest} className={cx("rounded-2xl border border-slate-800/80 bg-slate-900/60 shadow-xl shadow-black/20 backdrop-blur", className)}>
      {children}
    </div>
  );
}

type Tone = "emerald" | "rose" | "cyan" | "amber" | "slate" | "violet";
const TONES: Record<Tone, string> = {
  emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  rose: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  cyan: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  slate: "border-slate-600/40 bg-slate-700/30 text-slate-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-300",
};

export function Badge({ tone = "slate", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function KV({ label, value, mono = true, copy }: { label: string; value: React.ReactNode; mono?: boolean; copy?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={cx("flex min-w-0 items-center gap-1 text-right text-slate-200", mono && "font-mono")}>
        <span className="truncate">{value}</span>
        {copy ? <CopyButton value={copy} /> : null}
      </span>
    </div>
  );
}

export function CodeBlock({ value, maxHeight = "max-h-80" }: { value: unknown; maxHeight?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <div className="absolute right-2 top-2">
        <CopyButton value={text} />
      </div>
      <pre className={cx("scrollbar-thin overflow-auto rounded-xl border border-slate-800 bg-slate-950/80 p-3 pr-10 font-mono text-[11px] leading-relaxed text-cyan-100/90", maxHeight)}>
        {text}
      </pre>
    </div>
  );
}
