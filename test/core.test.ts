import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError } from "../src/core/budget.js";
import { bool, findKey, num, taxPct } from "../src/core/extract.js";
import { signalHashOf } from "../src/core/verify.js";

describe("Budget", () => {
  it("blocks reservations past the cap, including under concurrency", () => {
    const b = new Budget(0.1, "memo");
    const r = [b.reserve(0.05), b.reserve(0.05)];
    expect(() => b.reserve(0.01)).toThrow(BudgetExceededError);
    b.settle(r[0], 0.01); // actual price lower than the reservation frees the difference
    expect(b.remainingUsd).toBeCloseTo(0.04, 6);
    b.release(r[1]);
    expect(b.remainingUsd).toBeCloseTo(0.09, 6);
    expect(b.spentUsd).toBeCloseTo(0.01, 6);
  });

  it("charges child spend to the parent and respects the parent cap", () => {
    const day = new Budget(0.06, "daily");
    const memo = day.child(1, "memo");
    const a = memo.reserve(0.05);
    expect(() => memo.reserve(0.05)).toThrow(/daily/);
    memo.settle(a, 0.02);
    expect(day.spentUsd).toBeCloseTo(0.02, 6);
    expect(day.remainingUsd).toBeCloseTo(0.04, 6);
  });

  it("settling twice is a no-op", () => {
    const b = new Budget(1, "x");
    const r = b.reserve(0.5);
    b.settle(r, 0.1);
    b.settle(r, 0.4);
    expect(b.spentUsd).toBeCloseTo(0.1, 6);
  });
});

describe("signal verification", () => {
  it("re-derives a real Telegraph signal hash from its payload", () => {
    const s = JSON.parse(fs.readFileSync("fixtures/signal-sample.json", "utf8"));
    expect(signalHashOf(s.payload)).toBe(s.signal_hash);
  });

  it("detects a tampered payload", () => {
    const s = JSON.parse(fs.readFileSync("fixtures/signal-sample.json", "utf8"));
    s.payload.response.data.amount = "1.00";
    expect(signalHashOf(s.payload)).not.toBe(s.signal_hash);
  });
});

describe("extract", () => {
  const goplus = JSON.parse(fs.readFileSync("fixtures/goplus-pepe.json", "utf8"));
  it("finds provider-native keys at any depth", () => {
    expect(bool(goplus, ["is_honeypot"])).toBe(false);
    expect(num(goplus, ["holder_count"])).toBeGreaterThan(100_000);
    expect(findKey({ a: [{ b: { holders_count: 7 } }] }, ["holders_count"])).toBe(7);
  });
  it("normalises tax fractions and percents", () => {
    expect(taxPct("0.05")).toBeCloseTo(5);
    expect(taxPct("12")).toBe(12);
    expect(taxPct(undefined)).toBeUndefined();
  });
});
