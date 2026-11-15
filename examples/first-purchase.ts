/**
 * The smallest useful Telegraph buyer: one routed, capped, verified purchase.
 * Companion to docs/TUTORIAL.md. Spends $0.01 of test USDC on Ethereum Sepolia.
 *
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/first-purchase.ts 0x6982508145454ce325ddbe47a25d4ec3d2311933
 */
import "dotenv/config";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const NODE = process.env.TELEGRAPH_NODE_URL ?? "https://devnode.telegraphprotocol.com";
const NETWORK = "eip155:11155111"; // Ethereum Sepolia
const TEST_USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const MAX_PER_CALL_ATOMIC = "20000"; // $0.02 (USDC has 6 decimals). The client refuses to sign anything above this.

const token = (process.argv[2] ?? "0x6982508145454ce325ddbe47a25d4ec3d2311933").toLowerCase();
const key = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("Set EVM_PRIVATE_KEY to a throwaway testnet key (npm run wallet:new makes one).");

// 1. A payment client that can only pay small amounts, in one asset, on one network.
const client = new x402Client()
  .register(NETWORK, new ExactEvmScheme(privateKeyToAccount(key)))
  .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: TEST_USDC, maxAmountPerPayment: MAX_PER_CALL_ATOMIC }] })
  .registerPolicy((_v, reqs) => reqs.filter((r) => r.scheme === "exact" && BigInt(r.amount) <= BigInt(MAX_PER_CALL_ATOMIC)));
const payFetch = wrapFetchWithPayment(fetch, client);

// 2. A routed ask: name the intent and its canonical params, let Telegraph pick the best-ranked miner.
//    The node validates params before asking for payment, so a malformed request costs nothing.
const res = await payFetch(`${NODE}/engine/v1/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ intent: "TOKEN_HOLDER_COUNT_GENERAL", params: { token, chain: "ethereum" } }),
});
const body = (await res.json()) as any;
if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.message ?? body?.error ?? JSON.stringify(body)}`);

// 3. Sanity-check the answer before acting on it. Do not buy a second opinion; check what you can for free.
const holders = Number(body.result?.holders_count);
if (!Number.isFinite(holders) || holders < 0) throw new Error(`unusable answer: ${JSON.stringify(body.result)}`);
console.log(`holders of ${token}: ${holders.toLocaleString("en-US")} (miner ${body.miner_id}, $${body.cost_usd ?? "0.01"})`);
console.log(`signal ${body.signal_hash}`);

// 4. Verify the receipt yourself: recompute the signal hash from the published payload.
await new Promise((r) => setTimeout(r, 2500)); // give the node a moment to index the signal
const signal = (await (await fetch(`${NODE}/engine/v1/signal/${body.signal_hash}`)).json()) as any;
const sortKeys = (v: any): any =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const payload = { ...signal.payload, wallet_address: String(signal.payload.wallet_address).toLowerCase() };
const canonical = JSON.stringify(sortKeys(payload)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
const recomputed = keccak256(toBytes(canonical));
console.log(recomputed.toLowerCase() === String(body.signal_hash).toLowerCase() ? "receipt verified locally ✔" : `receipt MISMATCH: ${recomputed}`);
