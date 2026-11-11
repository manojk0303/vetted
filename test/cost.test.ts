import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { TelegraphClient, type AskRequest, type Simulator } from "../src/core/telegraph.js";
import { applyTrust, auto, isDistrusted, type RunCtx } from "../src/vet/buy.js";
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

describe("miner track records", () => {
  it("treats a miner as distrusted only after repeated losses", () => {
    expect(isDistrusted({ intent: "X", miner: "m", agree: 0, disagree: 1, unusable: 0, updatedAt: "" })).toBe(false);
    expect(isDistrusted({ intent: "X", miner: "m", agree: 0, disagree: 2, unusable: 0, updatedAt: "" })).toBe(true);
    expect(isDistrusted({ intent: "X", miner: "m", agree: 5, disagree: 2, unusable: 0, updatedAt: "" })).toBe(false);
  });

  it("skips direct asks to distrusted miners and tries auto-routing last", async () => {
    const tg = client();
    for (let i = 0; i < 3; i++) await tg.store.recordMinerOutcome("HOLDERS", "supply-a", "disagree");
    const ctx = { tg } as RunCtx;
    const attempts = [auto("HOLDERS", { a: 1 }), { req: { intent: "HOLDERS", params: { a: 1 }, minerId: "4" }, why: "supply-a" }, { req: { intent: "HOLDERS", params: { a: 1 }, minerId: "5" }, why: "txlens" }];
    const ordered = await applyTrust(ctx, attempts);
    expect(ordered.map((a) => a.why)).toEqual(["txlens", attempts[0].why]);
  });

  it("leaves order alone when nobody is distrusted", async () => {
    const tg = client();
    const attempts = [auto("HOLDERS", {}), { req: { intent: "HOLDERS", minerId: "4" } as AskRequest, why: "supply-a" }];
    expect(await applyTrust({ tg } as RunCtx, attempts)).toEqual(attempts);
  });
});

describe("sanctions: two independent miners per name", () => {
  const sanctionsSim = (matchedByMiner: Record<string, boolean>): Simulator => {
    const base = fixtureSimulator();
    return async (req) => {
      if (req.intent !== "SANCTIONS_SCREENING_MATCH_GENERAL") return base(req);
      const id = req.minerId ?? "auto";
      const matched = matchedByMiner[id] ?? false;
      return { result: { name: "x", matched, summary: matched ? "x: OFAC SDN match" : "x: no match" }, minerId: id, minerSlug: `miner-${id}` };
    };
  };

  it("flags a disagreement for human review", async () => {
    const tg = client(sanctionsSim({ "3": true })); // zk-sanctions says match, the second miner says no
    const memo = await vet(tg, validateApplication({ token: PEPE, issuer: "Example Holdings" }));
    const f = memo.findings.find((x) => x.check === "sanctions")!;
    expect(f.status).toBe("fail");
    expect(memo.verdict.flags).toEqual(expect.arrayContaining(["REVIEW_SANCTIONS_MATCH", "REVIEW_SANCTIONS_DISAGREEMENT"]));
    expect(f.summary).toContain("Miners disagree");
    expect(memo.verdict.decision).not.toBe("LIST");
  });

  it("passes only when two different miners both say no match", async () => {
    const tg = client(sanctionsSim({}));
    const memo = await vet(tg, validateApplication({ token: PEPE, issuer: "Example Holdings" }));
    const f = memo.findings.find((x) => x.check === "sanctions")!;
    expect(f.status).toBe("pass");
    expect(f.summary).toContain("confirmed by 2 independent miners");
  });
});
