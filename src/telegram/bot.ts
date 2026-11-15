/**
 * Vetted Telegram bot. People paste a token address in a chat and get a
 * receipted verdict back, with live progress while the checks are bought.
 *
 * Talks to the Telegram Bot API with plain fetch (no SDK). Two delivery modes:
 *  - polling (default): works anywhere, no public URL needed
 *  - webhook: for hosts that sleep when idle; Telegram's POST wakes them up
 */
import type { TelegraphClient } from "../core/telegraph.js";
import { validateApplication, vet } from "../vet/engine.js";
import type { MemoStore, Memo } from "../vet/memo.js";
import { CHAINS, type Chain, type Finding } from "../vet/types.js";
import type { VetEvent } from "../vet/buy.js";

export interface BotOptions {
  token: string;
  tg: TelegraphClient;
  memos: MemoStore;
  /** Public base URL of the Vetted web app, used for "full memo" links. */
  publicUrl?: string;
  /** Override for tests. */
  apiBase?: string;
  maxConcurrent?: number;
  runsPerUserPerHour?: number;
}

const CHAIN_ALIASES: Record<string, Chain> = {
  eth: "ethereum", ethereum: "ethereum", mainnet: "ethereum",
  base: "base",
  arb: "arbitrum", arbitrum: "arbitrum",
  polygon: "polygon", matic: "polygon", pol: "polygon",
  op: "optimism", optimism: "optimism",
  bsc: "bsc", bnb: "bsc", binance: "bsc",
};
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const ICON = { pass: "✅", warn: "⚠️", fail: "❌", unknown: "❔" } as const;
const VERDICT_ICON: Record<string, string> = { LIST: "🟢", ALLOW: "🟢", REVIEW: "🟡", CAUTION: "🟡", REJECT: "🔴", BLOCK: "🔴" };

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const HELP = [
  "<b>Vetted</b> checks a crypto token before you list, buy or trust it.",
  "",
  "Send me a token contract address, or use:",
  "<code>/vet 0x… [chain]</code>: full check (contract security, holders, supply, liquidity, fake-volume signals)",
  "<code>/trade 0x… 5000 [chain]</code>: should I buy $5,000 of it? Includes a max safe size",
  "<code>/chains</code>: supported chains (default: ethereum)",
  "",
  "Each check is bought on the Telegraph network, where data providers are ranked on quality, and every answer is sanity-checked and comes with a receipt you can verify.",
  "",
  "<i>Runs on the Telegraph testnet: the token data is real, payments for it use test money. Not financial advice.</i>",
].join("\n");

interface Parsed {
  kind: "vet" | "trade" | "help" | "chains" | "unknown" | "ignore";
  token?: string;
  chain?: Chain;
  tradeUsd?: number;
  error?: string;
}

/** Parse a message into a command. Exported for tests. */
export function parseMessage(text: string, isPrivate: boolean, botUsername?: string): Parsed {
  let t = text.trim();
  if (botUsername) t = t.replace(new RegExp(`@${botUsername}\\b`, "i"), "");
  const words = t.split(/\s+/).filter(Boolean);
  const cmd = words[0]?.toLowerCase() ?? "";
  const chainWord = words.slice(1).map((w) => CHAIN_ALIASES[w.toLowerCase()]).find(Boolean);
  const token = t.match(ADDRESS)?.[0];

  if (cmd === "/start" || cmd === "/help") return { kind: "help" };
  if (cmd === "/chains") return { kind: "chains" };
  if (cmd === "/vet" || cmd === "/check") {
    if (!token) return { kind: "vet", error: "Send it like this: <code>/vet 0x6982508145454ce325ddbe47a25d4ec3d2311933</code>" };
    return { kind: "vet", token, chain: chainWord ?? "ethereum" };
  }
  if (cmd === "/trade") {
    const amount = words.slice(1).filter((w) => !/^0x/i.test(w)).map((w) => Number(w.replace(/[$,_]/g, ""))).find((n) => Number.isFinite(n) && n > 0);
    if (!token || !amount) return { kind: "trade", error: "Send it like this: <code>/trade 0x6982…1933 5000</code> (token address, then USD amount)" };
    return { kind: "trade", token, chain: chainWord ?? "ethereum", tradeUsd: amount };
  }
  if (cmd.startsWith("/")) return isPrivate ? { kind: "unknown" } : { kind: "ignore" };
  // In private chats a bare address is enough. In groups only explicit commands run (no surprise spend).
  if (isPrivate && token) return { kind: "vet", token, chain: chainWord ?? "ethereum" };
  return isPrivate ? { kind: "help" } : { kind: "ignore" };
}

/** Render a finished memo as a Telegram HTML message (kept under the 4096-char limit). */
export function formatMemo(m: Memo, publicUrl?: string): string {
  const v = m.verdict;
  const name = [m.token.name, m.token.symbol && `(${m.token.symbol})`].filter(Boolean).join(" ") || "Unknown token";
  const lines = [
    `${VERDICT_ICON[v.decision] ?? "⚪"} <b>${esc(v.decision)}</b> · risk score ${v.score}/100`,
    `<b>${esc(name)}</b> · ${esc(CHAINS[m.application.chain].label)}`,
    `<code>${esc(m.application.token)}</code>`,
    "",
    ...m.findings.map((f: Finding) => `${ICON[f.status]} <b>${esc(f.label)}</b>: ${esc(clip(f.summary, 260))}`),
    "",
    `<i>${esc(clip(v.reasons.join(" "), 400))}</i>`,
    "",
    `💸 $${m.cost.totalUsd.toFixed(2)} · ${m.cost.purchases} new ${m.cost.purchases === 1 ? "purchase" : "purchases"}${m.cost.reused ? `, ${m.cost.reused} reused from earlier checks` : ""} ·${(m.durationMs / 1000).toFixed(0)}s${m.simulated ? " · <b>SIMULATED</b> (no real purchases)" : ""}`,
  ];
  if (notFound(m)) {
    lines.push("", `I couldn't find token data at this address on ${esc(CHAINS[m.application.chain].label)}. Is it on another chain? Try <code>/vet ${esc(m.application.token)} base</code> (or arbitrum, polygon, optimism, bsc).`);
  }
  lines.push(publicUrl ? `🔎 <a href="${esc(publicUrl)}/m/${esc(m.id)}">Full memo, receipts and verification</a>` : `🔎 memo <code>${esc(m.id)}</code>`);
  const out = lines.join("\n");
  return out.length > 4000 ? out.slice(0, 3990) + "…" : out;
}

function notFound(m: Memo): boolean {
  const c = m.findings.find((f) => f.check === "contract");
  return !!c && c.status === "unknown" && !m.token.name && !m.token.symbol;
}

export class TelegramBot {
  private api: string;
  private running = 0;
  private perUser = new Map<number, number[]>();
  private busyUsers = new Set<number>();
  private offset = 0;
  private stopped = false;
  username?: string;

  constructor(private o: BotOptions) {
    this.api = `${o.apiBase ?? "https://api.telegram.org"}/bot${o.token}`;
  }

  async call<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const r = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "getUpdates" ? 60_000 : 20_000),
    });
    const j = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`);
    return j.result;
  }

  /** Identify the bot and publish its command menu. */
  async init(): Promise<void> {
    const me = await this.call<{ username: string }>("getMe");
    this.username = me.username;
    await this.call("setMyCommands", {
      commands: [
        { command: "vet", description: "Check a token: /vet 0x… [chain]" },
        { command: "trade", description: "Pre-trade check: /trade 0x… 5000 [chain]" },
        { command: "chains", description: "Supported chains" },
        { command: "help", description: "How it works" },
      ],
    });
  }

  /** Long polling. Removes any webhook first, since Telegram allows only one delivery mode. */
  async poll(): Promise<void> {
    await this.call("deleteWebhook", { drop_pending_updates: false });
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.call<any[]>("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message"] });
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u).catch((e) => console.error("telegram update failed:", e.message));
        }
      } catch (e) {
        if (this.stopped) break;
        console.error(`telegram polling error: ${(e as Error).message}; retrying in ${backoff / 1000}s`);
        await new Promise((s) => setTimeout(s, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false });
  }

  stop(): void {
    this.stopped = true;
  }

  /** Handle one Telegram update. Resolves when the reply (including any diligence run) is finished. */
  async handleUpdate(update: any): Promise<void> {
    const msg = update.message;
    if (!msg?.text || !msg.chat) return;
    const chatId = msg.chat.id as number;
    const userId = (msg.from?.id ?? chatId) as number;
    const isPrivate = msg.chat.type === "private";
    const p = parseMessage(msg.text, isPrivate, this.username);
    const reply = (text: string) => this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_to_message_id: msg.message_id, disable_web_page_preview: true });

    if (p.kind === "ignore") return;
    if (p.kind === "help") return void (await reply(HELP));
    if (p.kind === "chains") return void (await reply(`Supported chains: ${Object.entries(CHAINS).map(([k, v]) => `<code>${k}</code> (${v.label})`).join(", ")}. Default is ethereum.`));
    if (p.kind === "unknown") return void (await reply(`I don't know that command.\n\n${HELP}`));
    if (p.error) return void (await reply(p.error));

    // Abuse limits: one run per user at a time, N per hour, and a global concurrency cap.
    if (this.busyUsers.has(userId)) return void (await reply("Your previous check is still running. One at a time, please."));
    const now = Date.now();
    const recent = (this.perUser.get(userId) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= (this.o.runsPerUserPerHour ?? 6)) return void (await reply("You've hit the hourly limit for checks. Try again a bit later."));
    if (this.running >= (this.o.maxConcurrent ?? 3)) return void (await reply("I'm busy with other checks right now. Try again in a minute."));
    if (!this.o.tg.simulated && this.o.tg.daily.remainingUsd < this.o.tg.cfg.maxPerCallUsd) {
      return void (await reply("Today's budget for checks is used up. Please try again tomorrow."));
    }

    let app;
    try {
      app = validateApplication({ token: p.token, chain: p.chain, mode: p.kind === "trade" ? "pretrade" : "listing", tradeUsd: p.tradeUsd });
    } catch (e) {
      return void (await reply(esc((e as Error).message)));
    }

    recent.push(now);
    this.perUser.set(userId, recent);
    this.busyUsers.add(userId);
    this.running++;
    try {
      await this.runCheck(chatId, msg.message_id, app);
    } finally {
      this.running--;
      this.busyUsers.delete(userId);
    }
  }

  private async runCheck(chatId: number, replyTo: number, app: ReturnType<typeof validateApplication>): Promise<void> {
    const header = `🔍 ${app.mode === "pretrade" ? `Pre-trade check ($${app.tradeUsd!.toLocaleString("en-US")})` : "Checking"} <code>${short(app.token)}</code> on ${CHAINS[app.chain].label}`;
    const sent = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: chatId, text: `${header}\nBuying checks from Telegraph data providers…`, parse_mode: "HTML", reply_to_message_id: replyTo,
    });
    const labels = new Map<string, string>();
    const done = new Map<string, Finding>();
    let bought = 0;
    let lastEdit = 0;
    let editing: Promise<unknown> = Promise.resolve();

    const progress = () =>
      [header, "", ...[...labels].map(([k, label]) => {
        const f = done.get(k);
        return f ? `${ICON[f.status]} ${esc(label)}` : `⏳ ${esc(label)}`;
      }), "", `<i>${bought} answers bought so far</i>`].join("\n");

    const edit = (text: string, force = false) => {
      const t = Date.now();
      if (!force && t - lastEdit < 2500) return; // stay well under Telegram's edit rate limits
      lastEdit = t;
      editing = editing
        .then(() => this.call("editMessageText", { chat_id: chatId, message_id: sent.message_id, text, parse_mode: "HTML", disable_web_page_preview: true }))
        .catch(() => { /* "message is not modified" and transient errors are harmless */ });
    };

    const onEvent = (e: VetEvent) => {
      if (e.type === "check:start") labels.set(e.check, e.label);
      else if (e.type === "attempt" && e.evidence.ok) bought++;
      else if (e.type === "check:done") done.set(e.check, e.finding);
      else return;
      edit(progress());
    };

    try {
      const memo = await vet(this.o.tg, app, onEvent);
      await this.o.memos.save(memo);
      edit(formatMemo(memo, this.o.publicUrl), true);
    } catch (e) {
      edit(`${header}\n\n❌ The check failed: ${esc((e as Error).message)}. Please try again.`, true);
    }
    await editing;
  }
}
