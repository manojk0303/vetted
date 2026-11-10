/**
 * A separate agent that BUYS a diligence memo from a Vetted server over x402,
 * then verifies it before acting. This is the machine-to-machine sale leg:
 * buyer agent → (pays Vetted) → Vetted → (pays Telegraph miners) → signed memo.
 *
 *   BUYER_PRIVATE_KEY=0x... VETTED_URL=http://localhost:8787 npx tsx examples/buyer-agent.ts <token> [chain] [tradeUsd]
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const NETWORK = "eip155:11155111";
const MAX_PRICE_ATOMIC = "500000"; // refuse to pay more than $0.50 for a memo

const [token, chain = "ethereum", trade] = process.argv.slice(2);
const key = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
const base = (process.env.VETTED_URL || "http://localhost:8787").replace(/\/$/, "");
if (!token || !key) {
  console.error("usage: BUYER_PRIVATE_KEY=0x... npx tsx examples/buyer-agent.ts <token> [chain] [tradeUsd]");
  process.exit(1);
}

const buyer = privateKeyToAccount(key);
const client = new x402Client()
  .register(NETWORK, new ExactEvmScheme(buyer))
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: MAX_PRICE_ATOMIC }] });
const pay = wrapFetchWithPayment(fetch, client);

console.log(`buyer ${buyer.address} asking ${base} for a pre-trade memo on ${token} (${chain})`);
const res = await pay(`${base}/x402/vet`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token, chain, mode: "pretrade", tradeUsd: trade ? Number(trade) : undefined }),
});
const memo = (await res.json()) as any;
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, memo.error ?? memo);
  process.exit(1);
}
const settlement = res.headers.get("payment-response");
const paid = settlement ? (decodePaymentResponseHeader(settlement) as any) : undefined;
console.log(`paid Vetted: tx ${paid?.transaction ?? "?"} (success=${paid?.success})`);
console.log(`Vetted paid Telegraph: $${memo.cost.totalUsd} across ${memo.cost.purchases} purchases`);

// Don't trust the seller: check the memo before acting on it.
const v = (await (await fetch(`${base}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(memo) })).json()) as any;
const trusted = v.digestMatches && v.signatureValid && v.allSignalsVerified;
console.log(`verification: digest=${v.digestMatches} signature=${v.signatureValid} receipts=${v.signals.filter((s: any) => s.matches).length}/${v.signals.length}`);
console.log(`decision: ${memo.verdict.decision} (score ${memo.verdict.score}) → ${trusted && memo.verdict.decision === "ALLOW" ? "proceed with trade" : "do not trade automatically"}`);
