# Demo video script (about 85 seconds)

Record [zerodelta.vercel.app](https://zerodelta.vercel.app/) full screen. Before recording, click each button once so the pages are warm, then reload. Use real clicks only; don't edit numbers into the video. Numbers change between runs because quotes are live; read what's on screen.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:08 | Top of the page: "Autonomous strategies. Contract-enforced boundaries." | "An AI agent can propose a trade. But should it hold the treasury's signing key?" |
| 0:08–0:25 | Click the amber **Simulate Compromised Solver**. Pause on the side-by-side panel. | "Here the solver is compromised. It reports a hedged order with zero delta, but what it actually asks to sign is a ten-times long. ZeroDelta recomputes the order's fingerprint, sees they don't match, and refuses." |
| 0:25–0:43 | Point at column 4, then open the proof inspector's **On-chain proof** tab and show "Account locked: TRUE" and "Contract-computed delta". | "The same check runs inside a NEAR smart contract with no access keys. It recalculates delta and leverage from the raw order, checks the fingerprint and a one-time nonce, and only then asks NEAR's MPC network for a signature." |
| 0:43–1:00 | Click the **Spoofed payload rejected** link (Nearblocks opens), go back, click **Approved + MPC sign** and show the receipt to `v1.signer-prod.testnet`. | "These are real testnet transactions. This attack failed with a commitment mismatch. And here the contract itself, not a person, called the signer, after its checks passed." |
| 1:00–1:15 | Back on the dashboard, click the green **Execute** button. Show the ranking table and the negotiation box. | "Strategy is autonomous too: one agent ranks NEAR, Solana, Ethereum and Bitcoin by funding minus live trading costs, and the solver and scanner renegotiate the order size when slippage is too high. If nothing pays, it says no trade." |
| 1:15–1:25 | Scroll back to the top. | "ZeroDelta: autonomous treasury strategies inside verifiable on-chain security boundaries. Built at NEAR HACKATHON." |

Notes for honesty on camera:
- Say "testnet" and "dry run" if you mention settlement; no funds move.
- The on-chain transactions are historical (sent once); your clicks don't create them.
- If the green button shows NO_TRADE, say so: "today nothing pays, so it stays in USDC." That's a feature. Tick the demo override to show the rest.
