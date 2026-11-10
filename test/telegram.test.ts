import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { TelegraphClient } from "../src/core/telegraph.js";
import { MemoStore } from "../src/vet/memo.js";
import { FileStore } from "../src/core/store.js";
import { fixtureSimulator, SIM_RISKY_TOKEN } from "../src/vet/simulator.js";
import { parseMessage, TelegramBot } from "../src/telegram/bot.js";

const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";

describe("parseMessage", () => {
  it("parses /vet with optional chain aliases", () => {
    expect(parseMessage(`/vet ${PEPE}`, true)).toMatchObject({ kind: "vet", token: PEPE, chain: "ethereum" });
    expect(parseMessage(`/vet ${PEPE} arb`, true)).toMatchObject({ chain: "arbitrum" });
    expect(parseMessage(`/vet@VettedBot ${PEPE} base`, false, "VettedBot")).toMatchObject({ kind: "vet", chain: "base" });
  });
  it("parses /trade without mistaking the hex address for the amount", () => {
    expect(parseMessage(`/trade ${PEPE} 5000`, true)).toMatchObject({ kind: "trade", tradeUsd: 5000 });
    expect(parseMessage(`/trade ${PEPE} $25,000 base`, true)).toMatchObject({ tradeUsd: 25000, chain: "base" });
    expect(parseMessage(`/trade ${PEPE}`, true).error).toBeTruthy();
  });
  it("accepts a bare address in private chats but never spends on chatter in groups", () => {
    expect(parseMessage(`is this legit? ${PEPE}`, true)).toMatchObject({ kind: "vet", token: PEPE });
    expect(parseMessage(`is this legit? ${PEPE}`, false).kind).toBe("ignore");
    expect(parseMessage("hello", false).kind).toBe("ignore");
    expect(parseMessage("/vet", true).error).toBeTruthy();
  });
});

// ---- end-to-end against a fake Telegram Bot API ----

let server: http.Server;
let apiBase = "";
const calls: { method: string; body: any }[] = [];

beforeAll(async () => {
  let nextId = 100;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = req.url!.split("/").pop()!;
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      const result = method === "sendMessage" ? { message_id: nextId++ } : method === "getMe" ? { username: "VettedTestBot" } : true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function makeBot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vetted-tg-"));
  const store = new FileStore(dataDir);
  const tg = new TelegraphClient({ ...loadConfig(), dataDir, simulate: true, privateKey: undefined, databaseUrl: undefined }, fixtureSimulator(), store);
  tg.rankedMiners = async () => [{ id: "1", slug: "goplus-security", name: "", served: 0, intents: [], endpoints: [] }];
  return new TelegramBot({ token: "TEST", tg, memos: new MemoStore(store), publicUrl: "https://vetted.example", apiBase, runsPerUserPerHour: 2 });
}
const update = (text: string, userId = 1, type = "private") => ({ update_id: 1, message: { message_id: 7, text, chat: { id: userId, type }, from: { id: userId } } });

describe("TelegramBot", () => {
  it("runs a check, shows progress, and ends with the verdict and a memo link", async () => {
    calls.length = 0;
    const bot = makeBot();
    await (bot as any).o.tg.init();
    await bot.init();
    expect(calls.find((c) => c.method === "setMyCommands")).toBeTruthy();
    await bot.handleUpdate(update(`/vet ${PEPE}`));
    const first = calls.find((c) => c.method === "sendMessage")!;
    expect(first.body.text).toContain("Checking");
    const edits = calls.filter((c) => c.method === "editMessageText");
    const final = edits[edits.length - 1].body.text as string;
    expect(final).toMatch(/LIST|REVIEW/);
    expect(final).toContain("Pepe (PEPE)");
    expect(final).toContain("https://vetted.example/m/");
    expect(final).toContain("SIMULATED");
    expect(final.length).toBeLessThan(4096);
  });

  it("flags the synthetic rug as REJECT", async () => {
    calls.length = 0;
    const bot = makeBot();
    await bot.handleUpdate(update(`/vet ${SIM_RISKY_TOKEN}`, 2));
    const edits = calls.filter((c) => c.method === "editMessageText");
    expect(edits[edits.length - 1].body.text).toContain("REJECT");
  });

  it("enforces the per-user hourly limit", async () => {
    calls.length = 0;
    const bot = makeBot();
    await bot.handleUpdate(update(`/vet ${PEPE}`, 3));
    await bot.handleUpdate(update(`/vet ${PEPE}`, 3));
    await bot.handleUpdate(update(`/vet ${PEPE}`, 3));
    const texts = calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
    expect(texts.some((t) => t.includes("hourly limit"))).toBe(true);
  });

  it("answers /help and ignores group chatter", async () => {
    calls.length = 0;
    const bot = makeBot();
    await bot.handleUpdate(update("/help"));
    await bot.handleUpdate(update("gm everyone", 9, "group"));
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].body.text).toContain("Vetted");
  });
});
