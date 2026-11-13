import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { TelegraphClient, type Simulator } from "../src/core/telegraph.js";
import { reportQuality, type RunCtx } from "../src/vet/buy.js";
import { FileStore } from "../src/core/store.js";
import { validateApplication, vet } from "../src/vet/engine.js";
import { fixtureSimulator, SIM_RISKY_TOKEN } from "../src/vet/simulator.js";

const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
const MINERS = [
  { id: "1", slug: "goplus-security" },
  { id: "2", slug: "verifywire-wash-trading" },
  { id: "3", slug: "zk-sanctions" },
  { id: "4", slug: "supply-a" },
  { id: "5", slug: "txlens" },
];

function client(sim: Simulator = fixtureSimulator()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vetted-cost-"));
  const tg = new TelegraphClient({ ...loadConfig(), dataDir, simulate: true, privateKey: undefined, databaseUrl: undefined, maxPerMemoUsd: 0.4 }, sim);
  tg.rankedMiners = async () => MINERS.map((m) => ({ ...m, name: "", served: 0, intents: [], endpoints: [] }));
  return tg;
}

describe("buy once, reuse for everyone", () => {
  it("a second check of the same token reuses fresh answers instead of paying again", async () => {
    const tg = client();
    const first = await vet(tg, validateApplication({ token: PEPE }));
    expect(first.cost.purchases).toBeGreaterThan(0);
    expect(first.cost.reused ?? 0).toBe(0);

    const second = await vet(tg, validateApplication({ token: PEPE }));
    expect(second.cost.purchases).toBe(0);
    expect(second.cost.totalUsd).toBe(0);
    expect(second.cost.reused).toBeGreaterThan(0);
    // Same verdict, and reused evidence still carries the original purchase details.
    expect(second.verdict.decision).toBe(first.verdict.decision);
    const reused = second.findings.flatMap((f) => f.evidence).filter((e) => e.reused);
    expect(reused.every((e) => e.boughtAt && e.costUsd === 0)).toBe(true);
  });

  it("fresh: true buys everything again", async () => {
    const tg = client();
    await vet(tg, validateApplication({ token: PEPE }));
    const again = await vet(tg, validateApplication({ token: PEPE }), undefined, undefined, { fresh: true });
    expect(again.cost.purchases).toBeGreaterThan(0);
    expect(again.cost.reused ?? 0).toBe(0);
  });

  it("identical purchases in flight at the same moment share one payment", async () => {
    let calls = 0;
    const base = fixtureSimulator();
    const counting: Simulator = async (req) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return base(req);
    };
    const solo = client(counting);
    await vet(solo, validateApplication({ token: PEPE }));
    const soloCalls = calls;

    calls = 0;
    const tg = client(counting);
    await Promise.all([vet(tg, validateApplication({ token: PEPE })), vet(tg, validateApplication({ token: PEPE }))]);
    expect(calls).toBe(soloCalls); // two simultaneous checks, one set of purchases
  });

  it("a different token is not served from another token's answers", async () => {
    const tg = client();
    await vet(tg, validateApplication({ token: PEPE }));
    // The synthetic token has its own contract data and its own pool, so nothing may carry over.
    const other = await vet(tg, validateApplication({ token: SIM_RISKY_TOKEN }));
    expect(other.cost.reused ?? 0).toBe(0);
  });
});

describe("routing: Telegraph picks the miner", () => {
  it("every schema'd question is one routed ask with no pinned miner", async () => {
    const asked: { intent?: string; minerId?: string }[] = [];
    const base = fixtureSimulator();
    const tg = client(async (req) => {
      asked.push({ intent: req.intent, minerId: req.minerId });
      return base(req);
    });
    await vet(tg, validateApplication({ token: PEPE, issuer: "Example Holdings" }));
    const pinned = asked.filter((a) => a.minerId);
    // Only the contract scan is pinned (its intent has no response format, so it cannot be ranked yet).
    expect(pinned.map((a) => a.intent)).toEqual(["SMART_CONTRACT_AUDIT_GENERAL"]);
    // One purchase per question: no quorum, no second opinions on usable answers.
    const perIntent = new Map<string, number>();
    for (const a of asked) perIntent.set(a.intent!, (perIntent.get(a.intent!) ?? 0) + 1);
    expect([...perIntent.values()].every((n) => n === 1)).toBe(true);
  });

  it("bad routed answers become quality reports with their receipt, never re-rankings", async () => {
    const store = new FileStore(fs.mkdtempSync(path.join(os.tmpdir(), "vetted-qr-")));
    const ctx = { tg: { simulated: false, store } } as unknown as RunCtx;
    const ev = { ok: true, usable: false, costUsd: 0.01, durationMs: 5, simulated: false, intent: "X", minerSlug: "m1", signalHash: "0xabc" };
    await reportQuality(ctx, "holders", ev, { token: "0x1" }, "answer did not contain the fields the question needs");
    await reportQuality(ctx, "holders", { ...ev, reused: true }, {}, "reused answers are never reported twice");
    const reports = await store.listQualityReports(10);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ check: "holders", minerSlug: "m1", signalHash: "0xabc" });
  });
});

describe("sanctions: one routed screen per name", () => {
  const sanctionsSim = (answer: (name: string) => unknown): Simulator => {
    const base = fixtureSimulator();
    return async (req) => {
      if (req.intent !== "SANCTIONS_SCREENING_MATCH_GENERAL") return base(req);
      const name = String((req.params as any)?.name ?? "Example Holdings");
      return { result: answer(name), minerId: "7", minerSlug: "routed-screen" };
    };
  };

  it("a match goes to human review", async () => {
    const tg = client(sanctionsSim((name) => ({ name, matched: true, lists: ["OFAC SDN"], summary: `${name}: OFAC SDN match` })));
    const memo = await vet(tg, validateApplication({ token: PEPE, issuer: "Example Holdings" }));
    expect(memo.findings.find((x) => x.check === "sanctions")!.status).toBe("fail");
    expect(memo.verdict.flags).toContain("REVIEW_SANCTIONS_MATCH");
    expect(memo.verdict.decision).not.toBe("LIST");
  });

  it("a negative that shows what was screened passes", async () => {
    const tg = client(sanctionsSim((name) => ({ name, matched: false, lists: ["OFAC SDN", "UN"], match_score: 0.1 })));
    const memo = await vet(tg, validateApplication({ token: PEPE, issuer: "Example Holdings" }));
    expect(memo.findings.find((x) => x.check === "sanctions")!.status).toBe("pass");
  });

  it("a bare 'no match' with nothing screened is not trusted", async () => {
    // Shape observed live for "Lazarus Group": matched false, everything else null.
    const tg = client(sanctionsSim(() => ({ name: null, matched: false, matches: null, lists: null, match_score: null })));
    const memo = await vet(tg, validateApplication({ token: PEPE, issuer: "Lazarus Group" }));
    const f = memo.findings.find((x) => x.check === "sanctions")!;
    expect(f.status).toBe("unknown");
    expect(memo.verdict.flags).toContain("REVIEW_SANCTIONS_UNSCREENED");
    expect(memo.verdict.decision).not.toBe("LIST");
  });
});
