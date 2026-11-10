import type { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SEPOLIA, type VettedConfig } from "../core/config.js";
import type { TelegraphClient } from "../core/telegraph.js";
import { InvalidApplicationError, validateApplication, vet } from "../vet/engine.js";
import type { MemoStore } from "../vet/memo.js";

/**
 * The sell side: other agents buy a signed memo from Vetted over x402.
 * Vetted is then both a Telegraph buyer (it pays miners per check) and a
 * machine-to-machine seller (it charges per memo), with the margin visible:
 * price per memo vs. the cost line inside the memo.
 *
 * POST /x402/vet   body: Application JSON   price: VETTED_SELL_PRICE_ATOMIC (default 250000 = $0.25 test USDC)
 */
export async function mountSell(app: Hono, tg: TelegraphClient, memos: MemoStore, _cfg: VettedConfig): Promise<void> {
  if (tg.simulated || !tg.account) {
    app.post("/x402/vet", (c) => c.json({ error: "selling is disabled in simulated mode (no operator wallet configured)" }, 503));
    return;
  }
  const price = process.env.VETTED_SELL_PRICE_ATOMIC || "250000";
  const facilitator = new HTTPFacilitatorClient({ url: process.env.X402_FACILITATOR_URL || "https://facilitator.x402.rs" });
  const server = new x402ResourceServer(facilitator).register(SEPOLIA.network, new ExactEvmScheme());
  try {
    await server.initialize(); // learn which networks/schemes the facilitator supports
  } catch (e) {
    console.error(`x402 facilitator unreachable (${(e as Error).message}); selling disabled`);
    app.post("/x402/vet", (c) => c.json({ error: "selling temporarily unavailable: payment facilitator unreachable" }, 503));
    return;
  }

  app.use(
    paymentMiddleware(
      {
        "POST /x402/vet": {
          accepts: [{
            scheme: "exact",
            network: SEPOLIA.network,
            payTo: tg.account.address,
            price: { asset: SEPOLIA.usdc, amount: price, extra: { name: "USD Coin", version: "2" } },
            maxTimeoutSeconds: 120,
          }],
          description: "Vetted signed token-diligence memo: every check bought from ranked Telegraph miners, receipted and verifiable.",
          mimeType: "application/json",
        },
      },
      server,
      undefined,
      undefined,
      false, // already initialized above
    ),
  );

  app.post("/x402/vet", async (c) => {
    let application;
    try {
      application = validateApplication(await c.req.json());
    } catch (e) {
      // 4xx responses are not settled by the middleware, so the buyer is not charged.
      return c.json({ error: e instanceof InvalidApplicationError ? e.message : "invalid JSON body" }, 400);
    }
    const memo = await vet(tg, application);
    if (memo.cost.usable === 0) return c.json({ error: "no usable intelligence could be bought; you were not charged", memo }, 502);
    await memos.save(memo);
    return c.json(memo);
  });
  console.log(`Selling memos at POST /x402/vet for ${Number(price) / 1e6} test USDC (payTo ${tg.account.address})`);
}
