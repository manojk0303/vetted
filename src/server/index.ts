import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bootstrap } from "../app.js";
import { InvalidApplicationError, validateApplication, vet } from "../vet/engine.js";
import { verifyMemo } from "../vet/memo.js";
import { mountSell } from "./sell.js";
import { randomBytes } from "node:crypto";
import { TelegramBot } from "../telegram/bot.js";

const { cfg, store, tg, memos } = await bootstrap();
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "public");

/** Every run spends real (testnet) USDC, so cap runs per client IP on top of the budget guard. */
const RUNS_PER_HOUR = Number(process.env.VETTED_RUNS_PER_HOUR || 12);
const hits = new Map<string, number[]>();
function allowRun(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= RUNS_PER_HOUR) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}
const clientIp = (c: any) => c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.env?.incoming?.socket?.remoteAddress || "local";

const app = new Hono();

app.get("/api/status", async (c) => {
  let usdc: number | undefined;
  try {
    usdc = await tg.usdcBalance();
  } catch { /* RPC hiccup: report unknown */ }
  return c.json({
    simulated: tg.simulated,
    payer: tg.account?.address,
    usdc,
    node: cfg.nodeUrl,
    network: "eip155:11155111 (Ethereum Sepolia testnet)",
    budget: { perCallUsd: cfg.maxPerCallUsd, perMemoUsd: cfg.maxPerMemoUsd, dailyRemainingUsd: tg.daily.remainingUsd },
  });
});

/** Streamed run for the UI. Events: run, check:start, attempt, check:done, memo, error. */
app.get("/api/vet/stream", (c) => {
  const q = c.req.query();
  let application;
  try {
    application = validateApplication(q);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  if (!allowRun(clientIp(c))) return c.json({ error: `rate limit: ${RUNS_PER_HOUR} runs per hour` }, 429);
  return streamSSE(c, async (stream) => {
    const queue: Promise<unknown>[] = [];
    try {
      const memo = await vet(tg, application, (e) => {
        queue.push(stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
      });
      await memos.save(memo);
    } catch (e) {
      queue.push(stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: (e as Error).message }) }));
    }
    await Promise.all(queue);
  });
});

/** Plain JSON API for scripts and agents (free to the caller; the operator's wallet pays Telegraph). */
app.post("/api/vet", async (c) => {
  let application;
  try {
    application = validateApplication(await c.req.json());
  } catch (e) {
    return c.json({ error: e instanceof InvalidApplicationError ? e.message : "invalid JSON body" }, 400);
  }
  if (!allowRun(clientIp(c))) return c.json({ error: `rate limit: ${RUNS_PER_HOUR} runs per hour` }, 429);
  const memo = await vet(tg, application);
  await memos.save(memo);
  return c.json(memo);
});

app.get("/api/memos", async (c) => c.json(await memos.list()));
app.get("/api/memos/:id", async (c) => {
  const m = await memos.get(c.req.param("id"));
  return m ? c.json(m) : c.json({ error: "not found" }, 404);
});
app.get("/api/memos/:id/verify", async (c) => {
  const m = await memos.get(c.req.param("id"));
  return m ? c.json(await verifyMemo(m, cfg.nodeUrl)) : c.json({ error: "not found" }, 404);
});
/** Verify a memo someone hands you (it need not have been produced by this server). */
app.post("/api/verify", async (c) => c.json(await verifyMemo(await c.req.json(), cfg.nodeUrl)));
app.get("/api/ledger", async (c) => c.json((await tg.ledger.read(200)).reverse()));
/** Liveness probe for the host (and for an uptime pinger that keeps a free instance awake). */
app.get("/healthz", (c) => c.json({ ok: true, storage: store.kind }));

await mountSell(app, tg, memos, cfg);

// Optional Telegram bot. With PUBLIC_URL set it uses a webhook (lets free hosts sleep and wake on messages);
// otherwise it long-polls from this process.
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "");
if (botToken) {
  const bot = new TelegramBot({ token: botToken, tg, memos, publicUrl });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || randomBytes(24).toString("hex");
  app.post("/telegram/webhook", async (c) => {
    if (c.req.header("x-telegram-bot-api-secret-token") !== secret) return c.text("forbidden", 403);
    const update = await c.req.json();
    // Ack immediately: a diligence run takes ~40 s and Telegram retries slow webhooks.
    bot.handleUpdate(update).catch((e) => console.error("telegram update failed:", e.message));
    return c.text("ok");
  });
  bot
    .init()
    .then(async () => {
      if (publicUrl && process.env.TELEGRAM_MODE !== "polling") {
        await bot.setWebhook(`${publicUrl}/telegram/webhook`, secret);
        console.log(`Telegram bot @${bot.username} on webhook ${publicUrl}/telegram/webhook`);
      } else {
        console.log(`Telegram bot @${bot.username} polling`);
        await bot.poll();
      }
    })
    .catch((e) => console.error(`Telegram bot disabled: ${e.message}`));
}

// Static UI. Memo permalinks (/m/:id) are rendered client-side.
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
app.get("*", (c) => {
  const p = c.req.path === "/" || c.req.path.startsWith("/m/") ? "/index.html" : c.req.path;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return c.text("not found", 404);
  return c.body(fs.readFileSync(file), 200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
});

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Vetted on http://localhost:${info.port}  storage=${store.kind}  ${tg.simulated ? "[SIMULATED: no Telegraph purchases]" : `[LIVE testnet, payer ${tg.account!.address}]`}`);
});
