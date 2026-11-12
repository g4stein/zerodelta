import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZeroDelta — Contract-Guarded Carry Strategy on NEAR",
  description:
    "Keyless NEAR contract controls MPC signing of contract-built Hyperliquid testnet orders with coin caps, expiry and replay protection. Portfolio inputs are solver-reported; no funds move.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
