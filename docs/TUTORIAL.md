# Build an agent that buys facts on Telegraph without overspending

*A hands-on guide, from a first $0.01 purchase to a production-shaped buyer. About 20 minutes. Everything runs on testnet with free test USDC.*

> Written while building [Vetted](../README.md) for Telegraph Hackathon Season II (Apps & Agents track, competing for prizes). Every number below was measured on the Telegraph testnet in November 2026.

## What Telegraph does for your agent

Your agent needs facts it cannot produce itself: how many wallets hold a token, whether a name is on a sanctions list, how deep a liquidity pool is. Telegraph is a market for those answers:

- An **intent** is a standard question with a fixed request and response schema, e.g. `TOKEN_HOLDER_COUNT_GENERAL` takes `{token, chain}` and returns `holders_count`.
- **Miners** (providers) compete to answer intents. **Evaluators** contribute test material, and the network uses it to **rank** miners per intent.
- Your agent calls one endpoint, `POST /engine/v1/ask`, names the intent, and Telegraph **routes** the question to a top-ranked miner.
- Payment is per answer over **x402**: the node replies `402 Payment Required`, your client signs a gasless USDC authorization (EIP-3009), and the request goes through. About $0.01 per answer on testnet.
- Every paid answer produces a **signal**: a public record whose hash anyone can recompute. Your agent gets a receipt, not just a response.

The important design consequence: **choosing and judging providers is Telegraph's job, not your app's.** Your app's job is to ask good questions, spend carefully, and act on the answers.

## Prerequisites

- Node 20 or newer
- A **throwaway** wallet key that has never held real funds
- A little Sepolia ETH (only for the one mint transaction) and test USDC

```bash
git clone <this repo> vetted && cd vetted && npm install
npm run wallet:new     # writes a fresh key to .env (git-ignored) and prints the address
# send ~0.01 Sepolia ETH to that address from any public Sepolia faucet
npm run wallet:mint    # mints 10 test USDC (anyone can mint the Telegraph test token)
```

You can also get test USDC from the faucet on anjoman.ai.

## Step 1: read the intent before you pay for it (free)

```bash
curl -s https://devnode.telegraphprotocol.com/engine/v1/intents/TOKEN_HOLDER_COUNT_GENERAL
```

Look at `request.params` (what to send), `response.fields` (what comes back) and `class` (`deterministic` answers can be checked against a truth source; `judgment` answers are scored differently). Also check `onchain.ready`: if an intent has **no response format**, Telegraph cannot evaluate its miners yet, so routing there is a coin toss.

Sending params that don't match the schema is rejected **before** the 402, so experimenting with request shapes costs nothing.

## Step 2: your first purchase, capped and routed

[examples/first-purchase.ts](../examples/first-purchase.ts) is about 50 lines. The parts that matter:

```ts
// A payment client that can only pay small amounts, in one asset, on one network.
const client = new x402Client()
  .register("eip155:11155111", new ExactEvmScheme(privateKeyToAccount(key)))
  .setSpendControls({ allowedAssets: [{ network: "eip155:11155111", asset: TEST_USDC, maxAmountPerPayment: "20000" }] })
  .registerPolicy((_v, reqs) => reqs.filter((r) => r.scheme === "exact" && BigInt(r.amount) <= 20000n));
const payFetch = wrapFetchWithPayment(fetch, client);

// A routed ask: name the intent, let Telegraph pick the miner.
const res = await payFetch(`${NODE}/engine/v1/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ intent: "TOKEN_HOLDER_COUNT_GENERAL", params: { token, chain: "ethereum" } }),
});
```

Three safety decisions are already in there:

1. **`maxAmountPerPayment`**: the client refuses to sign more than $0.02, whatever the server asks for.
2. **One asset, one network**: a misconfigured or malicious server cannot get your agent to sign for a different token.
3. **Only the `exact` scheme**: the client never signs escrow or other schemes by accident.

Run it:

```bash
npx tsx examples/first-purchase.ts 0x6982508145454ce325ddbe47a25d4ec3d2311933
```

Real output (15 Nov 2026):

```
holders of 0x6982508145454ce325ddbe47a25d4ec3d2311933: 9,590,660 (miner 501, $0.01)
signal 0x342791bd96a201273f28142a94e9c92f269607da844d902cb92c6b4ed8ea573b
receipt verified locally ✔
```

Hold on to that holder number. Step 5 comes back to it.

## Step 3: verify the receipt yourself

Don't rely on the node's own `verified: true` flag. Fetch the signal and recompute its hash:

```ts
const signal = await (await fetch(`${NODE}/engine/v1/signal/${signalHash}`)).json();
// keccak256 of the payload as compact JSON, keys sorted recursively,
// wallet_address lowercased, and < > & escaped as < > &
const recomputed = keccak256(toBytes(canonical(signal.payload)));
```

If the hashes match, the answer you acted on is the one the network recorded, from that miner, at that time. Vetted puts these hashes into every memo it signs, so a reader can re-check every fact without trusting Vetted ([src/core/verify.ts](../src/core/verify.ts)).

## Step 4: don't overspend

A per-call cap is not enough once an agent runs unattended. Vetted layers four more controls on top.

**Reserve before you spend.** Parallel calls can each pass a "do I have budget?" check and then overspend together. Reserve the worst-case price first, then settle the real price or release it ([src/core/budget.ts](../src/core/budget.ts)):

```ts
const r = budget.reserve(maxPerCallUsd);   // throws BudgetExceededError if it doesn't fit
try { const res = await ask(...); budget.settle(r, res.costUsd); }
catch (e) { budget.release(r); throw e; }
```

Nest budgets (per call, per decision, per day), and rebuild the daily total from your ledger on restart, so a crash loop can't reset it.

**Buy each question once.** It's tempting to ask several miners the same question and take a vote. The Telegraph team put it plainly in the hackathon Discord when asked about this pattern: it "defeats the whole purpose of Telegraph", and it gets "increasingly expensive to buy $1 worth of signals just to consume 1 cent." The cost of a decision becomes *questions × miners*. Telegraph already ranks miners, so lean on it: one routed purchase per question, and a second only if the first answer is unusable.

**Reuse answers while they're fresh.** Many facts don't change between two users asking about the same thing. Store each answer with its receipt and reuse it within a freshness window that matches the fact:

| Fact | Reuse window |
|---|---|
| contract code scan, total supply | 6 h |
| sanctions screen, social, website | 24 h |
| holder count | 1 h |
| wash-trading read | 15 min |
| pool liquidity | 5 min |

A reused answer keeps its original signal hash, so it still verifies. Let callers force fresh purchases (`fresh: true`) for moments that need it, like right before a trade.

**Share in-flight purchases.** If two users ask the same question in the same second, one payment should serve both. A map from request hash to pending promise does it.

Measured on Vetted, PEPE listing check:

| | Paid answers | Cost | Time |
|---|---|---|---|
| First check | 7 | $0.07 | 44 s |
| Same token again | 0 (6 reused) | $0.00 | 6 s |

## Step 5: check answers without buying more

Back to the 9,590,660 holders from Step 2. A different routed answer the same week said 601,904, and the contract scan Vetted already pays for reports a figure within 10% of that. One of these is wrong, and you can't afford to find out by buying five more opinions.

Check answers against what you already have, at no extra cost:

- **Compare with facts you already bought.** Vetted's contract scan includes holder count, total supply and pool liquidity. A routed answer that disagrees is marked down in the memo.
- **Demand that answers show their work.** On 13 Nov a routed sanctions screen for "Lazarus Group" (an OFAC-listed entity) came back `matched: false` with the name, the lists checked and the score all `null`. Vetted now refuses to treat a "no match" as clearance unless the answer shows what it screened. The retry reported the match.
- **Check plausibility.** A routed supply answer for PEPE returned 122,215,669 (true supply is about 420.69 trillion). It turned out to be another asset's data.

**Then report it, don't route around it.** If every app quietly blacklists the miners it dislikes, the network's ranking never improves. Vetted stores each bad answer with its signal hash (`GET /api/quality-reports`, and "Answers we flagged" on the home page). Those receipts are exactly what evaluation material and bounty reports need ([anjoman.ai/dashboard/eval](https://anjoman.ai/dashboard/eval), [bounties](https://github.com/telegraphprotocol/bounties/issues)).

## Step 6: put it together

Vetted ([src/vet/](../src/vet/)) is these steps applied to one job: token diligence before a listing or a trade.

```
token → contract scan ─┬─► liquidity (pool from the scan)
                       ├─► holders  (checked against the scan)
                       └─► supply   (checked against the scan)
        wash trading · sanctions per name · social · website
                       │  one routed ask each, reused while fresh
                       ▼
        verdict rules → signed memo → anyone can verify every receipt
```

Try it: [vetted-8olr.onrender.com](https://vetted-8olr.onrender.com), [@VettedCheckingBot](https://t.me/VettedCheckingBot) on Telegram, or `npm run vet -- <token>`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `400` before any payment | Params don't match the intent schema. Re-read `request.params` |
| `503` before any payment | No compatible miner for that request right now. You were not charged |
| Paid, then a 5xx or timeout | Telegraph credits failed paid requests to your **escrow** balance, not back to the wallet (see "When a Paid Request Fails" in the x402 docs on anjoman.ai) |
| Client refuses to pay | The price is above your `maxAmountPerPayment`, or the asset/network isn't the allowed one. That's the guard working |
| `wallet:mint` fails | The wallet needs a little Sepolia ETH for gas. Paying for answers is gasless |
| Signal hash doesn't match | Check the canonicalization rules: sorted keys, lowercase `wallet_address`, escaped `< > &` |

## What it costs

On testnet: $0.01 per answer, about 6–7 answers for a first token check, and close to nothing for repeats within the freshness window. Test USDC is free. The only real-world cost is a few cents of Sepolia ETH for one mint transaction.

## Lessons learned

1. **Routing quality varies by intent.** Holder counts, supply and wash-trading reads were often right; sanctions and contract audits were not reliable yet. Read `onchain.ready` before relying on an intent.
2. **Sanity checks catch more than votes, for less.** In one run, two routed answers were wrong (a null sanctions "no match" and another asset's supply), and both were caught without buying a second opinion.
3. **An intent with no response format can't be ranked.** For `SMART_CONTRACT_AUDIT_GENERAL`, Vetted pins a single structured miner (GoPlus) until the intent can be evaluated. That is the only pinned ask, and it is documented as an exception.
4. **Bad answers are the most useful data you produce.** Keep them with receipts and send them back as evaluation material.

## Next steps

- Read the Telegraph docs: [anjoman.ai/docs](https://anjoman.ai/docs)
- Pick an intent your agent needs and read its schema
- Fork Vetted and point it at a different decision. Open an issue if something in this guide doesn't work for you; reproduction reports help.
