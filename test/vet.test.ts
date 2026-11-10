import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { TelegraphClient } from "../src/core/telegraph.js";
import { parseContract } from "../src/vet/checks.js";
import { InvalidApplicationError, validateApplication, vet } from "../src/vet/engine.js";
import { memoDigest, verifyMemo } from "../src/vet/memo.js";
import { fixtureSimulator, SIM_RISKY_TOKEN } from "../src/vet/simulator.js";
import type { Finding } from "../src/vet/types.js";
import { decide } from "../src/vet/verdict.js";

const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // well-known test key, no funds

function client(withKey = true) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vetted-"));
  const cfg = { ...loadConfig(), dataDir, simulate: true, privateKey: withKey ? TEST_KEY : undefined, maxPerMemoUsd: 0.4, maxPerDayUsd: 5 };
  const tg = new TelegraphClient(cfg, fixtureSimulator());
  // Discovery is network-bound; tests run offline against the simulator.
  tg.rankedMiners = async () => [
    { id: "1", slug: "goplus-security", name: "", served: 0, intents: [], endpoints: [] },
    { id: "2", slug: "verifywire-wash-trading", name: "", served: 0, intents: [], endpoints: [] },
    { id: "3", slug: "zk-sanctions", name: "", served: 0, intents: [], endpoints: [] },
    { id: "4", slug: "supply-a", name: "", served: 0, intents: [], endpoints: [] },
  ];
  return tg;
}

describe("validateApplication", () => {
  it("rejects bad addresses and chains", () => {
    expect(() => validateApplication({ token: "0x123" })).toThrow(InvalidApplicationError);
    expect(() => validateApplication({ token: PEPE, chain: "solana" })).toThrow(/unsupported chain/);
  });
  it("normalises input", () => {
    const a = validateApplication({ token: PEPE.toUpperCase().replace("0X", "0x"), people: "A, B, C, D", mode: "x" });
    expect(a.token).toBe(PEPE);
    expect(a.people).toEqual(["A", "B", "C"]);
    expect(a.mode).toBe("listing");
  });
});

describe("contract parsing", () => {
  it("reads GoPlus flags, top holders and the deepest pool", () => {
    const c = parseContract(JSON.parse(fs.readFileSync("fixtures/goplus-pepe.json", "utf8")))!;
    expect(c.symbol).toBe("PEPE");
    expect(c.honeypot).toBe(false);
    expect(c.ownerRenounced).toBe(true);
    expect(c.bestPool?.liquidityUsd).toBeGreaterThan(1_000_000);
    expect(c.top10Pct).toBeGreaterThan(10);
  });
  it("returns undefined for an answer without security fields (junk miner)", () => {
    expect(parseContract({ answer: "<rss>...</rss>" })).toBeUndefined();
  });
});

describe("verdict", () => {
  const f = (check: string, status: Finding["status"], flags: string[] = []): Finding => ({ check, label: check, status, summary: "", facts: {}, flags, evidence: [] });
  it("hard REJECT flags override a good score", () => {
    const v = decide("listing", [f("contract", "fail", ["REJECT_HONEYPOT"]), f("liquidity", "pass"), f("holders", "pass")]);
    expect(v.decision).toBe("REJECT");
  });
  it("REVIEW flags force a human decision", () => {
    expect(decide("listing", [f("contract", "pass"), f("sanctions", "fail", ["REVIEW_SANCTIONS_MATCH"])]).decision).toBe("REVIEW");
  });
  it("all-pass lists, and pretrade uses ALLOW/CAUTION/BLOCK", () => {
    expect(decide("listing", [f("contract", "pass"), f("liquidity", "pass")]).decision).toBe("LIST");
    expect(decide("pretrade", [f("contract", "pass"), f("liquidity", "warn"), f("holders", "fail")]).decision).toBe("CAUTION");
  });
  it("unknown results lower the score instead of passing silently", () => {
    expect(decide("listing", [f("contract", "unknown"), f("liquidity", "unknown")]).score).toBeLessThan(50);
  });
});

describe("end-to-end (simulated)", () => {
  it("lists a healthy token and flags a sanctioned person", async () => {
    const tg = client();
    const memo = await vet(tg, validateApplication({ token: PEPE, people: ["Lazarus Group"], website: "pepe.vip" }));
    expect(memo.simulated).toBe(true);
    expect(memo.verdict.decision).toBe("REVIEW");
    expect(memo.verdict.flags).toContain("REVIEW_SANCTIONS_MATCH");
    expect(memo.findings.find((x) => x.check === "supply")?.status).toBe("pass");
    expect(memo.signer).toBe(privateKeyToAccount(TEST_KEY).address);
  });

  it("rejects the synthetic rug", async () => {
    const memo = await vet(client(), validateApplication({ token: SIM_RISKY_TOKEN }));
    expect(memo.verdict.decision).toBe("REJECT");
    expect(memo.verdict.flags).toEqual(expect.arrayContaining(["REJECT_HONEYPOT", "REJECT_PUNITIVE_TAX"]));
  });

  it("pretrade sizes the trade against liquidity", async () => {
    const memo = await vet(client(), validateApplication({ token: PEPE, mode: "pretrade", tradeUsd: 1_000_000 }));
    const liq = memo.findings.find((x) => x.check === "liquidity")!;
    expect(liq.status).toBe("fail");
    expect(liq.facts.maxTradeAt2PctUsd as number).toBeGreaterThan(100_000);
    expect(memo.findings.map((x) => x.check)).not.toContain("sanctions");
  });

  it("memo signature verifies, and any edit breaks the digest", async () => {
    const memo = await vet(client(), validateApplication({ token: PEPE }));
    const ok = await verifyMemo(memo, "http://127.0.0.1:9");
    expect(ok.digestMatches && ok.signatureValid).toBe(true);
    const tampered = { ...memo, verdict: { ...memo.verdict, decision: "REJECT" as const } };
    expect(memoDigest(tampered)).not.toBe(memo.digest);
    expect((await verifyMemo(tampered, "http://127.0.0.1:9")).digestMatches).toBe(false);
  });

  it("a budget smaller than one call blocks every purchase and records it", async () => {
    const tg = client();
    (tg.cfg as any).maxPerCallUsd = 0.05;
    const memo = await vet(tg, validateApplication({ token: PEPE }), undefined, 0.01);
    expect(memo.cost.purchases).toBe(0);
    expect(memo.findings.every((x) => x.status === "unknown")).toBe(true);
    expect(memo.verdict.decision).not.toBe("LIST");
    expect((await tg.ledger.read()).every((e) => e.status === "budget_blocked")).toBe(true);
  });
});

describe("consensus", async () => {
  const { consensus } = await import("../src/vet/checks.js");
  it("sets aside a single confidently-wrong miner when two sources agree", () => {
    const c = consensus([{ source: "scanner", value: 420.69e12 }, { source: "tsup-circle", value: 70.2e9 }, { source: "auto", value: 420.69e12 }], 1);
    expect(c.majority).toBe(true);
    expect(c.value).toBeCloseTo(420.69e12);
    expect(c.outliers.map((o) => o.source)).toEqual(["tsup-circle"]);
  });
  it("has no majority on a 1-vs-1 split", () => {
    const c = consensus([{ source: "a", value: 605_958 }, { source: "b", value: 9_589_908 }], 10);
    expect(c.majority).toBe(false);
    expect(c.value).toBeUndefined();
  });
});
