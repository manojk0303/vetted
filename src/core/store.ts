import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { LedgerEntry } from "./ledger.js";
import type { Memo } from "../vet/memo.js";

export type MemoSummary = Pick<Memo, "id" | "createdAt" | "application" | "token" | "verdict" | "cost" | "simulated">;

/**
 * Durable state: signed memos and the purchase ledger. Two backends:
 *  - FileStore: JSON files under data/ (local dev, any host with a persistent disk)
 *  - PgStore:   Postgres via DATABASE_URL (free hosts whose filesystem is wiped on restart)
 */
export interface Store {
  readonly kind: "file" | "postgres";
  init(): Promise<void>;
  appendLedger(e: LedgerEntry): Promise<void>;
  /** Most recent `limit` entries, oldest first. */
  readLedger(limit: number): Promise<LedgerEntry[]>;
  /** Real (non-simulated) spend since a timestamp. Drives the daily cap. */
  spentSinceUsd(sinceMs: number): Promise<number>;
  saveMemo(m: Memo): Promise<void>;
  getMemo(id: string): Promise<Memo | undefined>;
  listMemos(limit: number): Promise<MemoSummary[]>;
  close(): Promise<void>;
}

const VALID_ID = /^[a-z0-9-]{6,64}$/i;
const summarize = ({ id, createdAt, application, token, verdict, cost, simulated }: Memo): MemoSummary => ({ id, createdAt, application, token, verdict, cost, simulated });

export class FileStore implements Store {
  readonly kind = "file" as const;
  private ledgerFile: string;
  private memoDir: string;

  constructor(dataDir: string) {
    this.ledgerFile = path.join(dataDir, "ledger.jsonl");
    this.memoDir = path.join(dataDir, "memos");
  }

  async init() {
    fs.mkdirSync(this.memoDir, { recursive: true });
  }

  async appendLedger(e: LedgerEntry) {
    fs.appendFileSync(this.ledgerFile, JSON.stringify(e) + "\n");
  }

  async readLedger(limit: number) {
    if (!fs.existsSync(this.ledgerFile)) return [];
    const lines = fs.readFileSync(this.ledgerFile, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as LedgerEntry);
  }

  async spentSinceUsd(sinceMs: number) {
    return (await this.readLedger(1_000_000))
      .filter((e) => e.status !== "simulated" && Date.parse(e.at) >= sinceMs)
      .reduce((s, e) => s + (e.costUsd || 0), 0);
  }

  async saveMemo(m: Memo) {
    fs.mkdirSync(this.memoDir, { recursive: true });
    fs.writeFileSync(path.join(this.memoDir, `${m.id}.json`), JSON.stringify(m, null, 2));
  }

  async getMemo(id: string) {
    if (!VALID_ID.test(id)) return undefined;
    const f = path.join(this.memoDir, `${id}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Memo) : undefined;
  }

  async listMemos(limit: number) {
    if (!fs.existsSync(this.memoDir)) return [];
    return fs
      .readdirSync(this.memoDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.memoDir, f), "utf8")) as Memo)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(summarize);
  }

  async close() {}
}

export class PgStore implements Store {
  readonly kind = "postgres" as const;
  private pool: pg.Pool;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    // An idle client dropped by the server (common on serverless Postgres) must not crash the process.
    this.pool.on("error", (e) => console.error("postgres pool error:", e.message));
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vetted_memos (
        id          text PRIMARY KEY,
        created_at  timestamptz NOT NULL,
        body        jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vetted_memos_created_idx ON vetted_memos (created_at DESC);
      CREATE TABLE IF NOT EXISTS vetted_ledger (
        seq       bigserial PRIMARY KEY,
        at        timestamptz NOT NULL,
        status    text NOT NULL,
        cost_usd  double precision NOT NULL DEFAULT 0,
        entry     jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vetted_ledger_at_idx ON vetted_ledger (at);
    `);
  }

  async appendLedger(e: LedgerEntry) {
    await this.pool.query("INSERT INTO vetted_ledger (at, status, cost_usd, entry) VALUES ($1, $2, $3, $4)", [e.at, e.status, e.costUsd || 0, e]);
  }

  async readLedger(limit: number) {
    const r = await this.pool.query("SELECT entry FROM vetted_ledger ORDER BY seq DESC LIMIT $1", [limit]);
    return r.rows.map((x) => x.entry as LedgerEntry).reverse();
  }

  async spentSinceUsd(sinceMs: number) {
    const r = await this.pool.query("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM vetted_ledger WHERE status <> 'simulated' AND at >= $1", [new Date(sinceMs)]);
    return Number(r.rows[0].s);
  }

  async saveMemo(m: Memo) {
    await this.pool.query("INSERT INTO vetted_memos (id, created_at, body) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body", [m.id, m.createdAt, m]);
  }

  async getMemo(id: string) {
    if (!VALID_ID.test(id)) return undefined;
    const r = await this.pool.query("SELECT body FROM vetted_memos WHERE id = $1", [id]);
    return r.rows[0]?.body as Memo | undefined;
  }

  async listMemos(limit: number) {
    const r = await this.pool.query("SELECT body FROM vetted_memos ORDER BY created_at DESC LIMIT $1", [limit]);
    return r.rows.map((x) => summarize(x.body as Memo));
  }

  async close() {
    await this.pool.end();
  }
}

/** Postgres when DATABASE_URL is set, otherwise files under dataDir. */
export async function openStore(opts: { databaseUrl?: string; dataDir: string }): Promise<Store> {
  const store: Store = opts.databaseUrl ? new PgStore(opts.databaseUrl) : new FileStore(opts.dataDir);
  await store.init();
  return store;
}
