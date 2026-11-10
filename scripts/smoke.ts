/**
 * Milestone smoke test: one real paid Telegraph request, then independent
 * verification of its signal hash. Spends $0.01 of test USDC.
 *   npm run smoke
 */
import { loadConfig } from "../src/core/config.js";
import { TelegraphClient } from "../src/core/telegraph.js";
import { verifySignal } from "../src/core/verify.js";

const cfg = loadConfig({ simulate: false });
if (!cfg.privateKey) {
  console.error("No EVM_PRIVATE_KEY. Run: npm run wallet:new");
  process.exit(1);
}
const tg = await new TelegraphClient(cfg).init();
console.log(`payer ${tg.account!.address}, USDC balance ${await tg.usdcBalance()}`);

const r = await tg.ask({ intent: "CRYPTO_PRICE_USD", params: { symbol: "ETH" } }, { budget: tg.runBudget(0.05), check: "smoke" });
console.log(JSON.stringify(r, null, 2));
if (!r.ok) process.exit(1);

if (r.receipt.signalHash) {
  // The signal can take a moment to be indexed.
  await new Promise((s) => setTimeout(s, 2500));
  const v = await verifySignal(cfg.nodeUrl, r.receipt.signalHash);
  console.log("independent verification:", v);
}
