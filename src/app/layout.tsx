import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZeroDelta — Confidential Delta-Neutral Intent Swarm on NEAR",
  description:
    "Three cooperating agents scan funding, confidentially solve NEP-413 intents, and enforce delta-neutral risk invariants before any NEAR Chain Signature is authorized.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
