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

## Step 3 — Record a demo video (60–90 seconds)

Open [zerodelta.vercel.app](https://zerodelta.vercel.app/), click each button once to warm the page up, then reload. Record the browser full screen with **QuickTime** (Mac: File → New Screen Recording), **Xbox Game Bar** (Windows: `Win + G`) or [Loom](https://loom.com).

Follow the shot list and narration in **[docs/DEMO_VIDEO_SCRIPT.md](docs/DEMO_VIDEO_SCRIPT.md)**: it opens with the compromised-solver attack, then the locked contract and the real testnet transactions, then the market ranking. Read the numbers that are on screen; they change between runs because quotes are live. If the green button shows **NO_TRADE**, that's honest behaviour: say "nothing pays today, so it stays in USDC", then tick the demo override to show the rest.

---

## Step 4 — Post the demo on X

1. Go to [x.com](https://x.com) and start a new post.
2. Attach your video (or 2–4 screenshots).
3. Paste this text exactly as it is. Your links are already filled in, and it fits X's 280-character limit:

```
Built ZeroDelta at NEAR HACKATHON 🛡️

AI agents run a delta-neutral treasury, but only a keyless NEAR contract can get signatures, after rechecking risk. A lying solver gets a failed tx.

Demo: https://zerodelta.vercel.app
Code: https://github.com/g4stein/zerodelta

@NEARProtocol #NEARHackathon
```

4. Post it. Click the post to open it, then copy the link from the address bar (it looks like `https://x.com/your-name/status/123…`).

**Check:** open the post link in a private/incognito window to make sure it's public.

---

## Step 5 — Submit the form

Go to [nearhackathon.com](https://nearhackathon.com) → **Final submission**. The official agent instructions ([HACKATHON.md](https://nearhackathon.com/HACKATHON.md)) list these fields; only you can fill the personal ones:

| Field | What to enter |
|---|---|
| Project name | `ZeroDelta` |
| Team lead's name, contact email, team size | yours |
| Tracks | Tick **06 / SEC AI Security & Defense** first, plus 01 / DFI, 05 / SWM, 04 / BUS, 07 / AGT. 03 / PRV fits only partly (the TEE is simulated); tick it only if you're comfortable with that. |
| NEAR account for the prize (**mainnet**) | A named account like `yourname.near` or a 64-character implicit account that **you** created in a NEAR wallet ([wallet.near.org](https://wallet.near.org)). Never share a seed phrase; the form only needs the address. Kiro will not create one for you. |
| Repository link | `https://github.com/g4stein/zerodelta` (each repository can be submitted only once) |
| Demo post link | your X post from Step 4 |
| What you built (20–2000 characters) | the text below, or your own |
| Consent | "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Suggested "What you built" text (about 900 characters):

```
ZeroDelta is an autonomous cross-chain carry-strategy prototype. Three deterministic agents rank NEAR, SOL, ETH and BTC funding trades net of live NEAR Intents (1Click) costs, size a delta-neutral spot-long / perp-short hedge, negotiate slice sizes, and sign a NEP-413 intent that the real intents.near contract verifies in simulation.

The security idea: no agent holds the signing key. A Rust Risk Guard contract on NEAR testnet (zerodelta-guard-fb604f.testnet) has zero access keys and is the only caller that can get a NEAR Chain Signatures signature for the treasury's hedge key. It recomputes delta and leverage from raw order legs, checks a keccak256 commitment of the order and a nonce, and only then calls v1.signer-prod.testnet. Five public testnet transactions show one contract-originated MPC signature and three blocked attacks (rogue 10x trade, spoofed payload, replay). No funds move; the TEE is simulated.
```

You get **one submission per repository**. Mistakes are fixed later through the **Request changes** page, not by submitting again. Submit before **14 November 2026, 23:59 UTC**.

If you also enter a different project in this hackathon, both READMEs must name each other (rule Q-015).

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

| # | Item | Status |
|---|---|---|
| 1 | Inspect the finished repository on GitHub ([github.com/g4stein/zerodelta](https://github.com/g4stein/zerodelta)); check the README and `docs/` look right | **you** |
| 2 | Open the production demo ([zerodelta.vercel.app](https://zerodelta.vercel.app/)) and click all three buttons | **you** |
| 3 | Record the real demo video ([script](docs/DEMO_VIDEO_SCRIPT.md)) and post it publicly on X | **you** |
| 4 | The post says "Built ... at NEAR HACKATHON" and tags `@NEARProtocol` and `#NEARHackathon` ([ready-made text](docs/X_SUBMISSION.md), 277/280 characters) | ready, **you post** |
| 5 | Submit the repository link and the X post link in the form | **you** |
| 6 | Enter a NEAR **mainnet** payout account you created yourself | **you** |
| 7 | All of the above before **14 Nov 2026, 23:59 UTC** | **you** |
| — | Repository public, LICENSE (MIT) present, README explains NEAR's role | done |
| — | Keep the demo online until at least 18 Nov 2026 (ideally 25 Nov), per rule Q-012 | Vercel keeps it up; don't delete the project |
