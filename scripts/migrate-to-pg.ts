/**
 * Copy memos and ledger rows from data/ (FileStore) into Postgres (DATABASE_URL).
 * Simulated memos are skipped. Safe to re-run: memos upsert by id, and ledger rows
 * already present (same timestamp + status + signal hash) are not duplicated.
 *   npm run migrate:pg
 */
import { loadConfig } from "../src/core/config.js";
import { FileStore, PgStore } from "../src/core/store.js";

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const files = new FileStore(cfg.dataDir);
const db = new PgStore(cfg.databaseUrl);
await db.init();

const summaries = await files.listMemos(100_000);
let memos = 0;
for (const s of summaries) {
  if (s.simulated) continue;
  const m = await files.getMemo(s.id);
  if (m) {
    await db.saveMemo(m);
    memos++;
  }
}

const existing = new Set((await db.readLedger(1_000_000)).map((e) => `${e.at}|${e.status}|${e.signalHash ?? ""}`));
let rows = 0;
for (const e of await files.readLedger(1_000_000)) {
  if (e.status === "simulated") continue;
  const key = `${e.at}|${e.status}|${e.signalHash ?? ""}`;
  if (existing.has(key)) continue;
  await db.appendLedger(e);
  existing.add(key);
  rows++;
}
console.log(`copied ${memos} real memos and ${rows} ledger rows into Postgres (simulated ones skipped)`);
await db.close();
