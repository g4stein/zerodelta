import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZeroDelta — Contract-Guarded Carry Strategy on NEAR",
  description:
    "Three cooperating agents scan funding, construct NEP-413 intents with encrypted slices, and enforce delta-neutral risk invariants before any NEAR Chain Signature is authorized.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
