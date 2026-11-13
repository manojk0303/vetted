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
  /** A previously bought answer, reusable while fresh (buy once, serve every user who asks). */
  getFact(key: string): Promise<CachedFact | undefined>;
  putFact(key: string, fact: CachedFact): Promise<void>;
  /** A routed answer that failed a sanity check, kept with its receipt so it can be reported back to Telegraph. */
  addQualityReport(r: QualityReport): Promise<void>;
  /** Most recent reports, newest first. */
  listQualityReports(limit: number): Promise<QualityReport[]>;
  close(): Promise<void>;
}

export interface CachedFact {
  /** When the answer was originally bought. */
  at: string;
  /** Full miner answer (not the trimmed copy stored in memos). */
  answer: unknown;
  /** Evidence of the original purchase: miner, cost, signal hash, receipt. */
  evidence: import("../vet/types.js").Evidence;
}

/**
 * Vetted does not rank miners itself: Telegraph's evaluations do that. When a routed
 * answer is unusable or contradicts a fact Vetted already holds, it is recorded here
 * (with the signal hash, so anyone can verify it) as input for Telegraph's evaluation
 * material and bounty reports.
 */
export interface QualityReport {
  at: string;
  check: string;
  intent?: string;
  minerId?: string;
  minerSlug?: string;
  signalHash?: string;
  txHash?: string;
  /** What was asked (params or query), never secrets. */
  asked?: unknown;
  /** Plain-language description of what was wrong. */
  problem: string;
  answer?: unknown;
}

const VALID_ID = /^[a-z0-9-]{6,64}$/i;
const summarize = ({ id, createdAt, application, token, verdict, cost, simulated }: Memo): MemoSummary => ({ id, createdAt, application, token, verdict, cost, simulated });

export class FileStore implements Store {
  readonly kind = "file" as const;
  private ledgerFile: string;
  private memoDir: string;
  private factsFile: string;
  private reportsFile: string;

  constructor(dataDir: string) {
    this.ledgerFile = path.join(dataDir, "ledger.jsonl");
    this.memoDir = path.join(dataDir, "memos");
    this.factsFile = path.join(dataDir, "facts.json");
    this.reportsFile = path.join(dataDir, "quality-reports.jsonl");
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  }

  async getFact(key: string) {
    return this.readJson<Record<string, CachedFact>>(this.factsFile, {})[key];
  }

  async putFact(key: string, fact: CachedFact) {
    const all = this.readJson<Record<string, CachedFact>>(this.factsFile, {});
    all[key] = fact;
    // Keep the file bounded: drop entries older than 2 days.
    const cutoff = Date.now() - 2 * 86400_000;
    for (const [k, v] of Object.entries(all)) if (Date.parse(v.at) < cutoff) delete all[k];
    this.writeJson(this.factsFile, all);
  }

  async addQualityReport(r: QualityReport) {
    fs.mkdirSync(path.dirname(this.reportsFile), { recursive: true });
    fs.appendFileSync(this.reportsFile, JSON.stringify(r) + "\n");
  }

  async listQualityReports(limit: number) {
    if (!fs.existsSync(this.reportsFile)) return [];
    const lines = fs.readFileSync(this.reportsFile, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as QualityReport).reverse();
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
  private memos: string;
  private ledger: string;
  private facts: string;
  private reports: string;

  /** `prefix` namespaces the tables (tests use a throwaway prefix so they never touch real data). */
  constructor(url: string, private readonly prefix = "vetted") {
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(prefix)) throw new Error("invalid table prefix");
    this.memos = `${prefix}_memos`;
    this.ledger = `${prefix}_ledger`;
    this.facts = `${prefix}_facts`;
    this.reports = `${prefix}_quality_reports`;
    // pg currently treats sslmode=require as verify-full and warns about it; ask for verify-full explicitly (same behavior, no warning).
    const connectionString = url.replace(/([?&])sslmode=(require|prefer|verify-ca)\b/, "$1sslmode=verify-full");
    this.pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
    // An idle client dropped by the server (common on serverless Postgres) must not crash the process.
    this.pool.on("error", (e) => console.error("postgres pool error:", e.message));
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.memos} (
        id          text PRIMARY KEY,
        created_at  timestamptz NOT NULL,
        body        jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.memos}_created_idx ON ${this.memos} (created_at DESC);
      CREATE TABLE IF NOT EXISTS ${this.ledger} (
        seq       bigserial PRIMARY KEY,
        at        timestamptz NOT NULL,
        status    text NOT NULL,
        cost_usd  double precision NOT NULL DEFAULT 0,
        entry     jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.ledger}_at_idx ON ${this.ledger} (at);
      CREATE TABLE IF NOT EXISTS ${this.facts} (
        key   text PRIMARY KEY,
        at    timestamptz NOT NULL,
        body  jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${this.reports} (
        seq   bigserial PRIMARY KEY,
        at    timestamptz NOT NULL,
        body  jsonb NOT NULL
      );
    `);
  }

  async appendLedger(e: LedgerEntry) {
    await this.pool.query(`INSERT INTO ${this.ledger} (at, status, cost_usd, entry) VALUES ($1, $2, $3, $4)`, [e.at, e.status, e.costUsd || 0, e]);
  }

  async readLedger(limit: number) {
    const r = await this.pool.query(`SELECT entry FROM ${this.ledger} ORDER BY seq DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.entry as LedgerEntry).reverse();
  }

  async spentSinceUsd(sinceMs: number) {
    const r = await this.pool.query(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ${this.ledger} WHERE status <> 'simulated' AND at >= $1`, [new Date(sinceMs)]);
    return Number(r.rows[0].s);
  }

  async saveMemo(m: Memo) {
    await this.pool.query(`INSERT INTO ${this.memos} (id, created_at, body) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`, [m.id, m.createdAt, m]);
  }

  async getMemo(id: string) {
    if (!VALID_ID.test(id)) return undefined;
    const r = await this.pool.query(`SELECT body FROM ${this.memos} WHERE id = $1`, [id]);
    return r.rows[0]?.body as Memo | undefined;
  }

  async listMemos(limit: number) {
    const r = await this.pool.query(`SELECT body FROM ${this.memos} ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => summarize(x.body as Memo));
  }

  async getFact(key: string) {
    const r = await this.pool.query(`SELECT body FROM ${this.facts} WHERE key = $1`, [key]);
    return r.rows[0]?.body as CachedFact | undefined;
  }

  async putFact(key: string, fact: CachedFact) {
    await this.pool.query(
      `INSERT INTO ${this.facts} (key, at, body) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET at = EXCLUDED.at, body = EXCLUDED.body`,
      [key, fact.at, fact],
    );
    // Opportunistic cleanup keeps the table small on a free database.
    if (Math.random() < 0.05) await this.pool.query(`DELETE FROM ${this.facts} WHERE at < now() - interval '2 days'`);
  }

  async addQualityReport(r: QualityReport) {
    await this.pool.query(`INSERT INTO ${this.reports} (at, body) VALUES ($1, $2)`, [r.at, r]);
  }

  async listQualityReports(limit: number) {
    const r = await this.pool.query(`SELECT body FROM ${this.reports} ORDER BY seq DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => x.body as QualityReport);
  }

  /** Drop this store's tables (used by tests on their throwaway prefix). */
  async dropTables() {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.memos}; DROP TABLE IF EXISTS ${this.ledger}; DROP TABLE IF EXISTS ${this.facts}; DROP TABLE IF EXISTS ${this.reports};`);
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
