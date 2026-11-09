# How to submit ZeroDelta to the NEAR Hackathon

This guide is for you, the project owner. You don't need to write code or use a terminal. Every step is something you click or copy-paste.

**Deadline: 14 November 2026, 23:59 UTC.** Aim to finish a day early.

According to [nearhackathon.com](https://nearhackathon.com/), you need three things:

1. A **public GitHub repository** with the code.
2. A **public post on X** (Twitter) with a demo video or screenshots that tags `@NEARProtocol` and `#NEARHackathon` and says you built it at NEAR HACKATHON.
3. The **submission form** on nearhackathon.com with both links, plus a NEAR account address where a prize would be sent.

**Your links:**
- Code: [github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta)
- Live site: [zerodelta.vercel.app](https://zerodelta.vercel.app/)

Steps 1 and 2 are already done or optional. Start at **Step 3**.

---

## Step 1 — Put the code on GitHub ✅ Done

Your code is at [github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta), and the site at [zerodelta.vercel.app](https://zerodelta.vercel.app/) updates automatically whenever new code is pushed there.

One optional touch: on the repository page, click the ⚙️ next to **About**, paste `https://zerodelta.vercel.app` into **Website**, and click **Save changes**. The live link then shows at the top of your GitHub page.

The instructions below are kept for reference.

### Easiest option: ask Kiro
1. Make a free account at [github.com](https://github.com) if you don't have one, and connect it to Kiro.
2. In this Kiro chat, type:
   > Create a new public GitHub repository called `zerodelta` and push the project to it.
3. Kiro replies with a link like `https://github.com/your-name/zerodelta`. Open it and check that you can see `README.md` on the page.

### Manual option: GitHub Desktop
1. Install [GitHub Desktop](https://desktop.github.com) and sign in.
2. Choose **File → Add local repository** and select the `zerodelta` folder.
3. Click **Publish repository**. **Untick "Keep this code private"**, because judges can't open private repositories.
4. Click **Publish**.

**Check:** open the repository link in a private/incognito browser window. If you can see the files without logging in, it's public.

---

## Step 2 — Run the app on your computer (optional)

**You can skip this.** The live site at [zerodelta.vercel.app](https://zerodelta.vercel.app/) works the same way. Only follow these steps if you want a copy running on your own computer.

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org). Accept all the defaults.
2. Download your project: on your GitHub repository page click the green **Code** button → **Download ZIP**, then unzip it.
3. Open a terminal in that folder:
   - **Mac:** open the unzipped folder in Finder, right-click it, choose **New Terminal at Folder**.
   - **Windows:** open the unzipped folder, click the address bar, type `cmd`, press Enter.
4. Copy-paste these two lines, pressing Enter after each:
   ```
   npm install
   npm run dev
   ```
5. When you see `Ready`, open [http://localhost:3000](http://localhost:3000) in your browser.

To stop the app, click the terminal window and press `Ctrl + C`.

If anything goes wrong, copy the error text from the terminal and paste it into the Kiro chat.

---

## Step 3 — Record a 90-second demo video

Open [zerodelta.vercel.app](https://zerodelta.vercel.app/) in your browser and wait a few seconds for the live numbers in the top bar to fill in. Then record with any screen recorder: **QuickTime** (Mac: File → New Screen Recording), **Xbox Game Bar** (Windows: `Win + G`), or [Loom](https://loom.com). Record the browser window at full screen.

Tip: do one practice click of each button before you start recording, so you know what to expect.

Suggested script (read it out loud or add it as captions):

| Time | What to show | What to say |
|---|---|---|
| 0:00–0:10 | The top of the dashboard | "This is ZeroDelta: AI agents that run a delta-neutral treasury on NEAR, where a locked smart contract is the only thing that can use the treasury's signing key." |
| 0:10–0:20 | Point at the telemetry bar and the on-chain Risk Guard row | "These numbers are live: NEAR blocks, intents.near, the Chain Signatures MPC contract, and our Risk Guard contract on testnet, locked with zero access keys." |
| 0:20–0:45 | Leave the pair on **Auto**, click the green **Execute Autonomous Delta-Neutral Rebalance** button, then scroll to Agent 1's table and Agent 2's negotiation box | "Agent 1 ranks NEAR, Solana, Ethereum and Bitcoin by funding minus live trading costs and picks the winner. Agent 2 quotes live, and if slippage is too high the two agents renegotiate the slice count." |
| 0:45–0:60 | Scroll to Agent 3 and the proof inspector, open **On-chain proof (testnet)**, click the green "Approved + MPC sign" link | "Agent 3 checks eight rules, and the deployed contract recomputes the same order itself. Here's the real testnet transaction where the contract, not a person, asked NEAR's MPC network to sign." |
| 1:00–1:12 | Click the red **Simulate Rogue AI Directional Gamble** button | "A hallucinating AI tries a 10x unhedged long. Blocked on the math: about 1000% net delta, 10x leverage." |
| 1:12–1:25 | Click the amber **Simulate Compromised Solver** button, then point at the FAILURE rows in the On-chain proof tab | "Now the solver itself lies: it reports a hedged order but hides a 10x one in what it asks MPC to sign. The fingerprint doesn't match, so it's blocked here and on-chain too. Replays fail as well." |
| 1:25–1:30 | Back to the top | "ZeroDelta: an AI treasury that can't gamble or forge its way past the rules. Built at NEAR HACKATHON." |

Keep it under about 2 minutes 20 seconds so it fits on X without a paid account.

---

## Step 4 — Post the demo on X

1. Go to [x.com](https://x.com) and start a new post.
2. Attach your video (or 2–4 screenshots).
3. Paste this text exactly as it is. Your links are already filled in, and it fits X's 280-character limit:

```
Built ZeroDelta at NEAR HACKATHON 🛡️

AI agents run a delta-neutral treasury. A locked NEAR contract is the only path to its signing key, so rogue and spoofed trades fail on-chain.

Try it: https://zerodelta.vercel.app
Code: https://github.com/g4stein/zerodelta

@NEARProtocol #NEARHackathon
```

4. Post it. Click the post to open it, then copy the link from the address bar (it looks like `https://x.com/your-name/status/123…`).

**Check:** open the post link in a private/incognito window to make sure it's public.

---

## Step 5 — Submit the form

1. Go to [nearhackathon.com](https://nearhackathon.com) and scroll to **Final submission**.
2. Fill in:
   - **Repository link:** `https://github.com/g4stein/zerodelta`
   - **Live demo link** (if the form has a field for it): `https://zerodelta.vercel.app`
   - **Demo post link:** your X post link from Step 4.
   - **Tracks:** tick all six: **01 / DFI Unstoppable DeFi**, **03 / PRV Privacy & Private AI**, **04 / BUS Autonomous Business**, **05 / SWM AI Swarms**, **06 / SEC AI Security & Defense** and **07 / AGT Agent Economy**. The README's track table explains how each one fits.
   - **NEAR account address:** where a prize would be paid. If you don't have one, create a free wallet at [wallet.near.org](https://wallet.near.org) or [meteorwallet.app](https://meteorwallet.app) and copy your account name (for example `yourname.near`). Never share your seed phrase or private key; the form only needs the address.
   - **Email** and any other fields the form asks for.
3. Click submit.

Made a mistake? The site has a **Request changes** page where you can fix fields later.

---

## What the AI judge will do

The first judge, "Claude Code & Codex", will download your repository, read `README.md`, and run:

```
npm install
npm test
npm run verify
npm run build
```

All four (plus the contract's own `cargo test`) were run successfully before handover. `npm run verify` makes real calls to NEAR and should print `ALL CHECKS PASSED`. You don't have to do anything for this, but don't delete files from the repository.

## Quick checklist

- [x] GitHub repository is **public** and shows `README.md`
- [x] Live site works at [zerodelta.vercel.app](https://zerodelta.vercel.app/)
- [ ] (Optional) Website link added to the repository's **About** box
- [ ] Demo video recorded (about 90 seconds)
- [ ] X post is public and tags `@NEARProtocol` and `#NEARHackathon`
- [ ] Form submitted with both links before **14 Nov 2026, 23:59 UTC**
