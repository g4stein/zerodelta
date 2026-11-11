# Demo video script, v3.1 (about 110 seconds)

A draft for you to record or animate. Nothing here has been published. Every number below is from the recorded proof (`testnet-proof.json`, `hl-acceptance.json`); on screen, show the real page and terminal rather than retyping numbers.

Before recording: open [zerodelta.vercel.app](https://zerodelta.vercel.app/), wait until the v3.1 panel's top-right badges say *locked (0 keys)* and *attestation #0 Signed*, and open the approved transaction on Nearblocks in a second tab. In a terminal, `cd zerodelta && npm ci` so `npm run hl:acceptance` starts quickly.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:10 | The page header: "Autonomous strategies. Contract-enforced boundaries." | "Would you give an AI agent the key to a trading account? One hijacked prompt, and the key signs whatever the attacker wants." |
| 0:10–0:22 | Scroll to the v3.1 panel. Point at the top-right badges. | "In ZeroDelta the agents hold no key. The only signer is a NEAR smart contract with zero access keys, so nobody, not even us, can change its rules." |
| 0:22–0:38 | Step 1 and step 2 of the panel. | "The solver sends raw legs: a SOL spot long and an equal perp short. The contract recomputes delta and leverage itself. Then it builds the only order it will sign: one IOC sell of 16.0016 ETH on Hyperliquid testnet, sized from the approved notional and checked against a per-market cap in coins and a one-hour expiry." |
| 0:38–0:52 | Step 3: the digest and the green "recomputed in your browser" checks. | "It encodes that order exactly as Hyperliquid does and computes the signing digest on-chain. It never accepts a digest from the agent. Your browser rebuilds the same digest from the recorded request." |
| 0:52–1:05 | Switch to the Nearblocks tab: the receipt `zerodelta-guard-v31-c6e71c.testnet → v1.signer-prod.testnet.sign`. | "Only then does the contract itself call NEAR Chain Signatures. The MPC network signs for the key derived from the contract's own account." |
| 1:05–1:25 | Terminal: run `npm run hl:acceptance` (offline: it re-checks the recorded Hyperliquid answers). Let the three lines print. | "Now ask Hyperliquid. We posted the signed order to the testnet exchange once. It recovered the signer: 0xa74e, the contract's key. Flip one bit of the signature and it names a different address. That's signer recovery: the signature is the contract's. Hyperliquid remembers that nonce, so here we re-check the recorded answer." |
| 1:25–1:40 | Back on the page: the links under the panel; click "size-inflation attack rejected". | "And the attacks fail on-chain: a solver that sets the price to a tenth to inflate the order size, a two-hour expiry, a replayed order, and a call to the private callback. None of them got a signature. (We found the size flaw in our own earlier version, disclosed it, and redeployed.)" |
| 1:40–1:50 | The README's v3.1 table, or the repo URL. | "Testnet only: no funds moved, no order filled. Everything is reproducible with one verify command. ZeroDelta, built at NEAR HACKATHON." |

Notes for honesty on camera:

- Say "testnet" and "no fill". Hyperliquid's answer was "User or API Wallet 0xef63… does not exist": the address in that answer is the proof, not an executed trade.
- The transactions are historical (sent once by `scripts/testnet-setup-v31.ts`); page clicks don't create them.
- If `npm run hl:acceptance` can't reach Hyperliquid while recording, show `hl-acceptance.json` instead and say it is the recorded run. Do not run `--live` on camera: it will say SPENT.
- The v2 attack buttons (compromised solver, rogue 10x) still work; show one only if you have time left.
