#!/usr/bin/env node
/**
 * Run only the Telegram bot (long polling, no web server, no public URL needed).
 *   TELEGRAM_BOT_TOKEN=... npm run bot
 * To run it alongside the web app instead, just set TELEGRAM_BOT_TOKEN and `npm start`.
 */
import { bootstrap } from "../app.js";
import { TelegramBot } from "./bot.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN (get one from @BotFather in Telegram).");
  process.exit(1);
}
const { tg, memos, store } = await bootstrap();
const bot = new TelegramBot({ token, tg, memos, publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL)?.replace(/\/$/, "") });
await bot.init();
console.log(`@${bot.username} polling, storage=${store.kind} ${tg.simulated ? "[SIMULATED: no Telegraph purchases]" : `[LIVE testnet, payer ${tg.account!.address}]`}`);
process.on("SIGINT", () => { bot.stop(); process.exit(0); });
await bot.poll();
