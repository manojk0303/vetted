# Vetted

**An autonomous token-diligence desk. Every check is bought through Telegraph's router, receipted, and independently verifiable.**

Paste a token contract. Vetted buys contract security, holder, supply, liquidity, wash-trading, sanctions and reputation intelligence on the [Telegraph](https://telegraphprotocol.com) network, one routed answer per question, sanity-checks each answer against what it already knows, and writes a signed **LIST / REVIEW / REJECT** memo with a cost line. A first check of a token costs about $0.06; a repeat check within the freshness window costs close to nothing.

The same engine runs in a second mode for trading agents: **ALLOW / CAUTION / BLOCK** before a swap, with a maximum trade size derived from verified liquidity.

**Live demo:** https://vetted-8olr.onrender.com · **Telegram:** [@VettedCheckingBot](https://t.me/VettedCheckingBot) (send it a token address)

**New to Telegraph?** Start with the tutorial: [Build an agent that buys facts on Telegraph without overspending](docs/TUTORIAL.md), and its 50-line runnable example [examples/first-purchase.ts](examples/first-purchase.ts).

> Network status: runs on the **Telegraph testnet** (Ethereum Sepolia, test USDC). Nothing here is production volume or paying-customer usage.

Built for Telegraph Hackathon Season II, Apps & Agents track. Missions: **01 Exchange** (autonomous listings desk) and **14 Web3 Native & DeFi** (buy contract analysis before committing capital).

---

## Why

Exchanges, launchpads and wallets review thousands of tokens a year. The first pass is the same every time: is the contract a honeypot, who controls it, is the liquidity real, is the volume real, is anyone behind it sanctioned? Today that work is done by analysts, or by one vendor API whose answer you have to take on trust.

Vetted turns that first pass into a machine purchase:

| | Analyst first pass | Single vendor API | **Vetted** |
|---|---|---|---|
| Time | hours | seconds | ~30 s |
| Marginal cost | analyst time | subscription | ~$0.06 first check, ~$0 repeats, itemised |
| Sources | whatever the analyst checks | one vendor | the best-ranked Telegraph miner per question, re-ranked continuously by the network |
| Evidence | notes | none | a receipt per claim, re-derivable by anyone |
| Bad answers | rarely noticed | invisible | flagged in the memo and reported back with the receipt |

## How it works

```
Application (token, chain, optional issuer / people / X handle / website)
        │
        ▼
  ┌───────────────────────────── Vetted engine ─────────────────────────────┐
  │ contract scan ──┬─► liquidity (pool from the scan)                      │
  │                 ├─► holders  (compared with the scan, no extra purchase) │
  │                 └─► supply   (compared with the scan, no extra purchase) │
  │ wash trading     sanctions (per name)     social     website + TLS       │
  └───────────────┬─────────────────────────────────────────────────────────┘
                  │  each box = one routed POST /engine/v1/ask → 402 → x402 → answer + signal_hash
                  │  (a fresh answer bought earlier by anyone is reused instead of re-bought)
                  ▼
        verdict rules ─► signed memo (EIP-191) ─► anyone can verify
```

1. **Buy, routed.** Each question is one paid machine-to-machine request to the Telegraph Engine as a canonical `intent + params` request (the node validates it *before* charging). Telegraph picks the miner from its own evaluations and rankings; Vetted does not pin, poll or vote across miners. Payment is per call over x402 (EIP-3009, gasless for the payer).
2. **Sanity-check without buying more.** Holder count and total supply are compared with the contract scan Vetted already paid for. A sanctions "no match" only counts if the answer shows what was screened (the name, the lists or a score). A mismatch becomes a warning in the memo, never a silent average.
3. **Report bad answers back.** An unusable or contradictory answer is shown on the memo and stored as a quality report with its signal hash (`GET /api/quality-reports`, and "Answers we flagged" on the home page). These are evidence for Telegraph's evaluation material and bounty reports, so the network's ranking improves instead of every app routing around bad miners on its own. A second routed attempt is made only when the first answer is unusable.
4. **Decide.** Transparent rules ([src/vet/verdict.ts](src/vet/verdict.ts)): hard stops (honeypot, punitive tax, malicious website), mandatory human review (sanctions name match, owner can rewrite balances, supply disagreement), then a weighted score.
5. **Prove.** The memo is hashed and signed by the agent wallet. Every finding links to the Telegraph `signal_hash` it was based on. `verify` recomputes each hash locally with keccak256 over the canonical payload, so it doesn't rely on the node's own `verified` flag.

### Spend safety

Vetted spends money autonomously, so spending is fenced in before anything is signed:

- **Per call:** the x402 client only signs `exact` payments at or below `VETTED_MAX_PER_CALL_USD`, and only for the Sepolia test USDC asset.
- **Per memo and per day:** nested reservation budgets ([src/core/budget.ts](src/core/budget.ts)). Parallel checks reserve their worst-case price first, so concurrent calls can never overshoot the cap together.
- **Ledger:** every purchase, refusal and budget block is appended to `data/ledger.jsonl` with its signal hash, receipt hash and settlement tx.
- **Never escrow by accident:** the client never signs the escrow scheme implicitly.
- **Per IP:** the web server rate-limits runs.

### Cost model: one purchase per question, then reuse

A naive agent pays for every signal on every decision, for every user, and a "cross-check everything" agent multiplies that again by the number of miners it polls. Vetted's cost is *questions*, not *questions × miners*, and it falls as usage grows:

- **One routed answer per question.** Quality is Telegraph's job (evaluations and rankings), so Vetted never buys the same fact twice to vote on it. The single exception is below.
- **Reuse while fresh.** Every bought answer is stored and reused by anyone who asks the same question within its freshness window: contract scan and supply 6 h, sanctions/social/website 24 h, holders 1 h, wash trading 15 min, liquidity 5 min. A reused answer keeps the original signal hash and settlement tx, so it still verifies. Pass `fresh: true` (or `--fresh`) to force new purchases, e.g. right before a trade.
- **Share in-flight purchases.** Two users checking the same token at the same moment share one payment.

**The one pinned ask.** `SMART_CONTRACT_AUDIT_GENERAL` has no response format yet, so Telegraph cannot evaluate or rank its miners. A routed question there was answered by a general LLM with "no findings" without reading the contract. Until the intent is rankable, Vetted asks `goplus-security` (structured honeypot/tax/owner flags) directly through the engine, one call, with a routed fallback. This is the only pinned miner.

Observed on testnet, 13 Nov 2026, PEPE listing check with one sanctions name (memo `2026-11-13-b11dd48e-034`):

| | Paid answers | Cost | Wall time |
|---|---|---|---|
| First check (`--fresh`) | 7 (6 questions + 1 retry after an unusable answer) | $0.07 | 44 s |
| Same token again | 0 (6 reused, receipts intact) | $0.00 | 6 s |

The same run shows what the sanity checks are for. Two routed answers were wrong, and both were caught without buying a second opinion:

- **Sanctions:** the first answer for "Lazarus Group" was `matched: false` with name, lists and score all null. Vetted refused to treat it as clearance and asked again; the second answer reported the OFAC match.
- **Supply:** the routed supply miner returned 122,215,669 for PEPE (true supply ≈ 420.69 trillion). It disagreed with the on-chain contract scan, so the memo used the on-chain figure and filed a quality report.

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
| `POST /x402/vet` | **Machine-to-machine sale.** Other agents pay Vetted $0.25 test USDC over x402 for a memo. Vetted then pays Telegraph about $0.06 to produce it (less when answers are reused). 4xx/5xx responses are never settled. |

### A second agent buying from Vetted

[examples/buyer-agent.ts](examples/buyer-agent.ts) is a separate agent with its own wallet. It pays `POST /x402/vet`, receives the memo, and verifies the digest, signature and every receipt before it decides whether to trade.

```bash
npm run wallet:mint -- --to <buyer address> --amount 1     # fund a test buyer from your wallet
BUYER_PRIVATE_KEY=0x... VETTED_URL=http://localhost:8787 npx tsx examples/buyer-agent.ts <token> ethereum 25000
```

## Telegraph intents used

| Check | Intent | How it is bought |
|---|---|---|
| Contract security | `SMART_CONTRACT_AUDIT_GENERAL` | pinned to `goplus-security` through the engine (intent has no response format yet, so it cannot be ranked), routed fallback |
| Holders | `TOKEN_HOLDER_COUNT_GENERAL` | routed, canonical `{token, chain}`; compared with the contract scan |
| Supply | `TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL` | routed, canonical `{token}`; compared with the contract scan |
| Liquidity | `LIQUIDITY_DEPTH_VERIFY_GENERAL` | routed, canonical `{pool, chain}`, pool taken from the contract scan |
| Wash trading | `WASH_TRADING_DETECTION_GENERAL` | routed, canonical `{subject}` |
| Sanctions | `SANCTIONS_SCREENING_MATCH_GENERAL` | routed, canonical `{name}`, one purchase per name; a bare "no match" is not trusted |
| Community | `SOCIAL_BOT_DETECTION_GENERAL` | routed, canonical `{account}` |
| Website | `URL_SAFE_GENERAL`, `URL_SCAN_VERDICT`, `SSL_VERIFICATION_CERT` | routed, canonical params |

The pinned contract-scan miner is resolved by slug from `GET /api/miners` at run time, because IDs change between epochs.

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
| A check shows *refused, not charged* | The node rejected the request before payment (incompatible params or no miner) |
| A check shows *unusable answer* | The routed miner's answer lacked the needed fields. It is listed under "Answers we flagged" with its receipt, and one more routed attempt is made |
| `wallet:mint` fails | The wallet needs a little Sepolia ETH for gas. Paying for intelligence itself is gasless |

## Development

```bash
npm test            # budget concurrency, receipt re-derivation against a real signal, memo tamper detection, verdict rules, routing (one purchase per question), reuse, end-to-end simulated runs
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
