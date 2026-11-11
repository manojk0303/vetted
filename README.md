# Vetted

**An autonomous token-diligence desk. Every check is bought from ranked Telegraph miners, receipted, and independently verifiable.**

Paste a token contract. Vetted buys contract security, holder, supply, liquidity, wash-trading, sanctions and reputation intelligence from competing miners on the [Telegraph](https://telegraphprotocol.com) network, cross-checks them, and writes a signed **LIST / REVIEW / REJECT** memo with a cost line. A full memo takes about 30 seconds and costs about $0.10.

The same engine runs in a second mode for trading agents: **ALLOW / CAUTION / BLOCK** before a swap, with a maximum trade size derived from verified liquidity.

**Live demo:** https://vetted-8olr.onrender.com · **Telegram:** [@VettedCheckingBot](https://t.me/VettedCheckingBot) (send it a token address)

> Network status: runs on the **Telegraph testnet** (Ethereum Sepolia, test USDC). Nothing here is production volume or paying-customer usage.

Built for Telegraph Hackathon Season II, Apps & Agents track. Missions: **01 Exchange** (autonomous listings desk) and **14 Web3 Native & DeFi** (buy contract analysis before committing capital).

---

## Why

Exchanges, launchpads and wallets review thousands of tokens a year. The first pass is the same every time: is the contract a honeypot, who controls it, is the liquidity real, is the volume real, is anyone behind it sanctioned? Today that work is done by analysts, or by one vendor API whose answer you have to take on trust.

Vetted turns that first pass into a machine purchase:

| | Analyst first pass | Single vendor API | **Vetted** |
|---|---|---|---|
| Time | hours | seconds | ~30 s |
| Marginal cost | analyst time | subscription | ~$0.10, itemised |
| Sources | whatever the analyst checks | one | several competing miners per fact |
| Evidence | notes | none | a receipt per claim, re-derivable by anyone |
| Disagreement between sources | rarely noticed | invisible | flagged in the memo |

## How it works

```
Application (token, chain, optional issuer / people / X handle / website)
        │
        ▼
  ┌───────────────────────────── Vetted engine ─────────────────────────────┐
  │ contract scan ──┬─► liquidity (pool from the scan, verified separately)  │
  │  (GoPlus miner) ├─► holders + top-10 concentration                       │
  │                 └─► supply QUORUM (2+ independent miners + scanner)      │
  │ wash-trading (live Transfer-log scan)   sanctions (OFAC/UK/EU/UN lists)  │
  │ social bot detection   website safety + TLS                              │
  └───────────────┬─────────────────────────────────────────────────────────┘
                  │  each box = POST /engine/v1/ask → 402 → x402 payment → answer + signal_hash
                  ▼
        verdict rules ─► signed memo (EIP-191) ─► anyone can verify
```

1. **Buy.** Each check is a paid machine-to-machine request to the Telegraph Engine. Vetted sends a canonical `intent + params` request where a schema exists (the node validates it *before* charging), or a direct ask to a specific miner it trusts for structured output. Payment is per call over x402 (EIP-3009, gasless for the payer).
2. **Cross-check.** Deterministic facts such as total supply are bought from several miners and compared. Liquidity and holder counts are compared against the contract scanner. Disagreements become warnings, not silent averages.
3. **Fail over, visibly.** If a miner returns an answer that doesn't contain the needed fields, Vetted shows it on the memo as an *unusable answer* and buys from the next-ranked miner. Bad supply stays visible.
4. **Decide.** Transparent rules ([src/vet/verdict.ts](src/vet/verdict.ts)): hard stops (honeypot, punitive tax, malicious website), mandatory human review (sanctions name match, owner can rewrite balances, supply disagreement), then a weighted score.
5. **Prove.** The memo is hashed and signed by the agent wallet. Every finding links to the Telegraph `signal_hash` it was based on. `verify` recomputes each hash locally with keccak256 over the canonical payload, so it doesn't rely on the node's own `verified` flag.

### Spend safety

Vetted spends money autonomously, so spending is fenced in before anything is signed:

- **Per call:** the x402 client only signs `exact` payments at or below `VETTED_MAX_PER_CALL_USD`, and only for the Sepolia test USDC asset.
- **Per memo and per day:** nested reservation budgets ([src/core/budget.ts](src/core/budget.ts)). Parallel checks reserve their worst-case price first, so concurrent calls can never overshoot the cap together.
- **Ledger:** every purchase, refusal and budget block is appended to `data/ledger.jsonl` with its signal hash, receipt hash and settlement tx.
- **Never escrow by accident:** the client never signs the escrow scheme implicitly.
- **Per IP:** the web server rate-limits runs.

### Cost model: buy once, serve everyone

A naive agent pays for every signal on every decision, for every user who asks about the same thing: cost grows as *signals × users*. Vetted is built so that cost per decision falls as usage grows:

- **Reuse while fresh.** Every bought answer is stored and reused by anyone who asks the same question within its freshness window: contract scan and supply 6 h, sanctions/social/website 24 h, holders 1 h, wash trading 15 min, liquidity 5 min. A reused answer keeps the original signal hash and settlement tx, so it still verifies. Pass `fresh: true` (or `--fresh`) to force new purchases, e.g. right before a trade.
- **Share in-flight purchases.** Two users checking the same token at the same moment share one payment.
- **Stop paying miners that are wrong.** Each majority vote updates a per-miner track record. A miner outvoted at least twice and wrong more often than right is skipped. Live example: `sentinel-risk-oracle`, ranked #1 for holder counts, was outvoted 8 of 8 times and is no longer bought. The board is public at `/api/miners/reliability` and on the home page.
- **Second opinions only where they pay off.** Supply and holders stop as soon as two independent sources agree. Sanctions are always screened by two different miners, because a missed hit is the costliest error in a listing memo.

Observed on testnet (Nov 2026), same PEPE listing check run twice in a row:

| | Paid answers | Cost | Wall time |
|---|---|---|---|
| First check | 7 | $0.07 | 67 s |
| Same token again | 0 (7 reused) | $0.00 | 10 s |

Before the track records, about 42% of holder-count spend went to the miner that was always outvoted.

## Quickstart

Requires Node 20+.

```bash
git clone <this repo> vetted && cd vetted
npm install

# Try everything offline first (recorded fixtures, clearly labelled SIMULATED, no purchases)
VETTED_SIMULATE=1 npm start            # http://localhost:8787
```

### Go live on testnet (about 5 minutes)

```bash
npm run wallet:new        # creates a throwaway key in .env (git-ignored) and prints its address
# send ~0.01 Sepolia ETH to that address from any public Sepolia faucet (only needed for the mint tx)
npm run wallet:mint       # mints 10 test USDC (anyone can mint the Telegraph test token)
npm run smoke             # one real $0.01 purchase + independent receipt verification
npm start                 # LIVE mode
```

### CLI

```bash
npm run vet -- 0x6982508145454ce325ddbe47a25d4ec3d2311933 --chain ethereum \
  --issuer "Example Labs Ltd" --x pepecoineth --website pepe.vip

npm run vet -- 0x6982508145454ce325ddbe47a25d4ec3d2311933 --mode pretrade --trade 25000

npm run vet -- verify data/memos/<id>.json     # exit code 0 only if digest, signature and every receipt check out
```

### MCP (Claude Code, Cursor, OpenClaw, any MCP client)

```bash
claude mcp add vetted -- npx tsx /absolute/path/to/vetted/src/mcp/index.ts
```

| Tool | Cost | What it does |
|---|---|---|
| `vet_token` | ~$0.04–0.15 | Full diligence memo (listing or pre-trade) |
| `telegraph_ask` | ~$0.01 | Any Telegraph intent, behind per-call, per-session and per-day spend caps, written to the ledger |
| `telegraph_intent` | free | Intent schema + miners ordered by protocol rank |
| `verify_receipt` | free | Re-derive a signal hash, or verify a whole memo |
| `spend_report` | free | Budget state + recent purchases |

`telegraph_ask` is useful on its own. It gives any agent budget-capped, receipted access to the whole Telegraph market, which the raw client doesn't provide.

### Telegram bot

Paste a token address into a chat and get a receipted verdict back, with live progress while the checks are bought.

```bash
# 1. In Telegram, message @BotFather → /newbot → copy the token
# 2. Put it in .env as TELEGRAM_BOT_TOKEN=..., then either:
npm run bot        # bot only (long polling, no public URL needed)
npm start          # web app + bot together
```

| Command | |
|---|---|
| `/vet 0x… [chain]` | Full check. In a private chat, a bare address also works |
| `/trade 0x… 5000 [chain]` | Pre-trade check for a $5,000 buy, with a max safe size |
| `/chains`, `/help` | |

In groups the bot only runs on explicit commands, so ordinary chatter never spends anything. Each user gets one run at a time and 6 per hour, and there's a global concurrency cap on top of the daily budget. With `PUBLIC_URL` set, the bot switches to a webhook, so a free host can sleep and wake on incoming messages, and replies link to the full memo page.

### HTTP API

| Route | |
|---|---|
| `POST /api/vet` | Run diligence, returns the signed memo (body: `{ token, chain, mode, issuer?, people?, xHandle?, website?, tradeUsd? }`) |
| `GET /api/vet/stream?token=…` | Same, as server-sent events (`run`, `check:start`, `attempt`, `check:done`, `memo`) |
| `GET /api/memos/:id/verify` | Independent verification report |
| `POST /api/verify` | Verify a memo you were handed (it doesn't have to come from this server) |
| `POST /x402/vet` | **Machine-to-machine sale.** Other agents pay Vetted $0.25 test USDC over x402 for a memo. Vetted then pays Telegraph miners about $0.10 to produce it. 4xx/5xx responses are never settled. |

### A second agent buying from Vetted

[examples/buyer-agent.ts](examples/buyer-agent.ts) is a separate agent with its own wallet. It pays `POST /x402/vet`, receives the memo, and verifies the digest, signature and every receipt before it decides whether to trade.

```bash
npm run wallet:mint -- --to <buyer address> --amount 1     # fund a test buyer from your wallet
BUYER_PRIVATE_KEY=0x... VETTED_URL=http://localhost:8787 npx tsx examples/buyer-agent.ts <token> ethereum 25000
```

## Telegraph intents used

| Check | Intent | How it is bought |
|---|---|---|
| Contract security | `SMART_CONTRACT_AUDIT_GENERAL` | direct ask to `goplus-security` (structured flags), auto-route fallback |
| Holders | `TOKEN_HOLDER_COUNT_GENERAL` | canonical params `{token, chain}`, auto-routed, then ranked fallback |
| Supply | `TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL` | quorum across top-ranked miners, max 3 paid attempts |
| Liquidity | `LIQUIDITY_DEPTH_VERIFY_GENERAL` | canonical `{pool, chain}`, pool taken from the contract scan |
| Wash trading | `WASH_TRADING_DETECTION_GENERAL` | direct `verifywire-wash-trading` Transfer-log scan, auto fallback |
| Sanctions | `SANCTIONS_SCREENING_MATCH_GENERAL` | direct `zk-sanctions`, auto fallback, one purchase per name |
| Community | `SOCIAL_BOT_DETECTION_GENERAL` | canonical `{account}` |
| Website | `URL_SAFE_GENERAL`, `URL_SCAN_VERDICT`, `SSL_VERIFICATION_CERT` | canonical params |

Miner IDs are never hard-coded. Vetted resolves them by slug and rank from `GET /api/miners` at run time, because IDs change between epochs.

## Limits and honest caveats

- **Testnet only.** Prices, routing and miner quality are those of the Telegraph testnet today.
- **A sanctions name match is an alert, not an identity confirmation.** A negative result is not sanctions clearance. Vetted forces human review on any match.
- **Wash-trading reads are heuristics** over a recent block window, not proof of intent.
- **Verdict rules are opinionated defaults**, written to be read and changed ([src/vet/verdict.ts](src/vet/verdict.ts)).
- A memo is decision support, not investment or legal advice.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `SIMULATED` banner | No `EVM_PRIVATE_KEY` in `.env`, or `VETTED_SIMULATE=1` |
| `budget exceeded (daily)` | Raise `VETTED_MAX_PER_DAY_USD` or wait. Spend from the last 24h is read from the ledger |
| `Crypto API not available` | Use Node 20+ |
| A check shows *refused, not charged* | The node rejected that miner before payment (incompatible params or no miner). Vetted moves to the next one |
| `wallet:mint` fails | The wallet needs a little Sepolia ETH for gas. Paying for intelligence itself is gasless |

## Development

```bash
npm test            # 40 tests: budget concurrency, receipt re-derivation against a real signal, memo tamper detection, verdict rules, quorum outlier handling, end-to-end simulated runs
npm run typecheck
```

```
src/core/   Telegraph client (x402), budget guard, ledger, receipt verification, extraction helpers
src/vet/    checks, verdict rules, signed memo, engine, offline simulator
src/server/ web UI + JSON/SSE API + x402 sell endpoint
src/mcp/    MCP server
src/cli/    CLI
src/telegram/ Telegram bot (polling or webhook)
fixtures/   recorded miner responses (real PEPE data + one clearly synthetic risky token)
```

MIT licensed.
