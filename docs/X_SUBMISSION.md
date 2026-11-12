# Historical X post drafts

> **Superseded production draft.** The project owner reports that the demo has been posted and ZeroDelta has been submitted. This file records earlier draft copy; it is not the current submission status or a publishing checklist. Do not submit the project again.

Use the [judge guide](JUDGE_GUIDE.md) and [security model](SECURITY_MODEL.md) for current claims and limitations. Draft text and counts below are preserved as historical material and should not be reused without review.

## Main post (draft A, recommended)

```
Should an AI agent hold your trading key?

In ZeroDelta a keyless NEAR contract checks the hedge, builds the Hyperliquid order and signs it via Chain Signatures. Hyperliquid testnet recovered its key.

https://zerodelta.vercel.app
Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

Length: 278.

## Main post (draft B)

```
AI agents shouldn't hold the trading key.

In ZeroDelta a NEAR contract with 0 keys checks the hedge, builds the Hyperliquid order and signs it via Chain Signatures. The exchange recovered its address.

https://zerodelta.vercel.app
Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

Length: 279.

## Reply to your own post (thread)

```
How to check it yourself:
• npm run hl:acceptance → recorded Hyperliquid testnet answer names 0xa74e...9f5e, the contract's MPC key. Flip v or s: other address
• npm run verify → 95 read-only checks

Testnet only, no funds, no fill.
Code: https://github.com/g4stein/zerodelta
@NearBuilders
```

Length: 280.

## Checklist from the rules

- Says it was built at NEAR HACKATHON ✔
- Tags @NEARProtocol ✔ and #NEARHackathon ✔ (@NearBuilders and @NearLegion are optional; the reply tags @NearBuilders)
- Leads with the user problem, explains NEAR's role concretely, gives a next step ✔
- Honest scope: testnet, no funds, no fill, stated in the reply ✔
- Demo video attached and post public: you
