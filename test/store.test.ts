import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, PgStore, type Store } from "../src/core/store.js";
import type { Memo } from "../src/vet/memo.js";

const memo = (id: string, createdAt: string) =>
  ({ id, createdAt, application: { token: "0x1", chain: "ethereum", mode: "listing" }, token: {}, verdict: { decision: "LIST", score: 90, flags: [], reasons: [] }, cost: { totalUsd: 0.1 }, simulated: false, findings: [] }) as unknown as Memo;

async function exercise(store: Store) {
  await store.init();
  await store.saveMemo(memo("2026-11-10-aaaaaa", "2026-11-10T01:00:00Z"));
  await store.saveMemo(memo("2026-11-10-bbbbbb", "2026-11-10T02:00:00Z"));
  expect((await store.getMemo("2026-11-10-aaaaaa"))?.verdict.score).toBe(90);
  expect(await store.getMemo("../../etc/passwd")).toBeUndefined();
  expect((await store.listMemos(10)).map((m) => m.id).slice(0, 2)).toEqual(["2026-11-10-bbbbbb", "2026-11-10-aaaaaa"]);
  const now = new Date().toISOString();
  await store.appendLedger({ at: now, status: "paid", costUsd: 0.01 });
  await store.appendLedger({ at: now, status: "simulated", costUsd: 0.01 });
  await store.appendLedger({ at: "2020-01-01T00:00:00Z", status: "paid", costUsd: 5 });
  expect(await store.spentSinceUsd(Date.now() - 3600_000)).toBeCloseTo(0.01, 6);
  const last = await store.readLedger(2);
  expect(last.map((e) => e.status)).toEqual(["simulated", "paid"]);
}

describe("FileStore", () => {
  it("round-trips memos and ledger, and counts only real recent spend", async () => {
    await exercise(new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), "vetted-store-"))));
  });
});

// Runs only when a throwaway test database is provided: TEST_DATABASE_URL=postgres://... npm test
describe.skipIf(!process.env.TEST_DATABASE_URL)("PgStore", () => {
  it("round-trips memos and ledger against real Postgres", { timeout: 60_000 }, async () => {
    // Throwaway tables, dropped afterwards: never touches the real vetted_* tables.
    const store = new PgStore(process.env.TEST_DATABASE_URL!, `vetted_test_${Date.now().toString(36)}`);
    try {
      await exercise(store);
    } finally {
      await store.dropTables();
      await store.close();
    }
  });
});
