import { createHash } from "node:crypto";
import type { Budget } from "../core/budget.js";
import type { AskRequest, AskResult, TelegraphClient } from "../core/telegraph.js";
import { canonicalPayload } from "../core/verify.js";
import type { Application, Attempt, Evidence } from "./types.js";

export type VetEvent =
  | { type: "run"; runId: string; app: Application; simulated: boolean; payer?: string }
  | { type: "check:start"; check: string; label: string }
  | { type: "attempt"; check: string; why: string; evidence: Evidence }
  | { type: "check:done"; check: string; finding: import("./types.js").Finding }
  | { type: "memo"; memo: import("./memo.js").Memo }
  | { type: "error"; message: string };

export interface RunCtx {
  tg: TelegraphClient;
  budget: Budget;
  runId: string;
  app: Application;
  emit: (e: VetEvent) => void;
  /** Skip reuse and buy every answer fresh (e.g. a trading agent right before a swap). */
  fresh?: boolean;
}

/**
 * How long a bought answer stays reusable, per check. Facts that rarely change
 * (contract code, supply, list membership) are reused for hours; market facts
 * for minutes. Every reuse still points at the original, publicly verifiable receipt.
 */
export const FRESH_FOR_SEC: Record<string, number> = {
  contract: 6 * 3600,
  supply: 6 * 3600,
  sanctions: 24 * 3600,
  social: 24 * 3600,
  website: 24 * 3600,
  holders: 3600,
  wash: 15 * 60,
  liquidity: 5 * 60,
};

/** Identical purchases that are in flight at the same moment share one payment. */
const inflight = new Map<string, Promise<AskResult>>();

export function factKey(req: AskRequest, simulated: boolean): string {
  const { intent, params, query, minerId, method, endpoint, payload } = req;
  const canon = canonicalPayload({ intent, params, query, minerId, method, endpoint, payload });
  return `${simulated ? "sim" : "live"}:${createHash("sha256").update(canon).digest("hex").slice(0, 40)}`;
}

// ---------------------------------------------------------------- quality reports

/**
 * Record a routed answer that failed a sanity check. Vetted never re-ranks miners or
 * routes around them: choosing the provider is Telegraph's job. Bad answers are kept,
 * with their receipts, as material for Telegraph's evaluations and bounty reports.
 */
export async function reportQuality(ctx: RunCtx, check: string, ev: Evidence, asked: unknown, problem: string) {
  if (ctx.tg.simulated || !ev.ok || ev.reused) return; // only real, fresh purchases are reportable
  try {
    await ctx.tg.store.addQualityReport({
      at: new Date().toISOString(),
      check,
      intent: ev.intent,
      minerId: ev.minerId,
      minerSlug: ev.minerSlug,
      signalHash: ev.signalHash,
      txHash: ev.txHash,
      asked,
      problem,
      answer: ev.answer,
    });
  } catch (e) {
    console.error("quality report write failed:", (e as Error).message);
  }
}

// ---------------------------------------------------------------- buying

/**
 * Buy one fact: one routed purchase per question, with Telegraph choosing the
 * provider. A second attempt is made only when the first answer is unusable
 * (missing the fields the question needs), never to second-guess a usable one.
 * A fresh answer bought earlier (by any user) is reused instead of paying again.
 * Every attempt, paid, reused or failed, is kept as evidence in the memo.
 */
export async function buy<T>(
  ctx: RunCtx,
  check: string,
  attempts: Attempt[],
  extract: (answer: unknown) => T | undefined,
  maxPaid = 2,
): Promise<{ value?: T; evidence: Evidence[] }> {
  const evidence: Evidence[] = [];
  const ttl = FRESH_FOR_SEC[check] ?? 0;
  const store = ctx.tg.store;
  let paid = 0;

  // 1. Reuse a fresh answer someone already paid for, under any of the attempt forms
  //    (so a fallback that worked last time is reused, not re-bought behind a failing first form).
  if (!ctx.fresh && ttl > 0) {
    for (const a of attempts) {
      const hit = await store.getFact(factKey(a.req, ctx.tg.simulated)).catch(() => undefined);
      if (!hit || Date.now() - Date.parse(hit.at) >= ttl * 1000) continue;
      const value = safe(() => extract(hit.answer));
      if (value === undefined) continue;
      const ev: Evidence = { ...hit.evidence, reused: true, boughtAt: hit.at, costUsd: 0, durationMs: 0 };
      evidence.push(ev);
      ctx.emit({ type: "attempt", check, why: `reused an answer bought ${ago(hit.at)}`, evidence: ev });
      return { value, evidence };
    }
  }

  for (const a of attempts) {
    if (paid >= maxPaid) break;
    const key = factKey(a.req, ctx.tg.simulated);

    // 2. Buy it (sharing the payment with any identical purchase already in flight).
    let p = inflight.get(key);
    const shared = !!p;
    if (!p) {
      p = ctx.tg.ask(a.req, { budget: ctx.budget, runId: ctx.runId, check });
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    const r = await p;
    if (r.ok && !shared) paid++;
    const value = r.ok ? safe(() => extract(r.result)) : undefined;
    const ev: Evidence = {
      intent: r.intent ?? a.req.intent,
      minerId: r.minerId,
      minerSlug: r.minerSlug,
      ok: r.ok,
      usable: value !== undefined,
      costUsd: r.ok && !shared ? r.costUsd : 0,
      durationMs: r.durationMs,
      signalHash: r.receipt.signalHash,
      receiptHash: r.receipt.receiptHash,
      txHash: r.receipt.txHash,
      simulated: r.simulated,
      reused: shared || undefined,
      error: r.ok ? (value === undefined ? "answer did not contain the required fields" : undefined) : r.error,
      answer: trim(r.result),
    };
    evidence.push(ev);
    ctx.emit({ type: "attempt", check, why: shared ? "shared a purchase already in flight" : a.why, evidence: ev });

    if (r.ok && !shared) {
      if (value === undefined) await reportQuality(ctx, check, ev, a.req.params ?? a.req.query ?? a.req.payload, "answer did not contain the fields the question needs");
      else if (ttl > 0) {
        await store
          .putFact(key, { at: new Date().toISOString(), answer: r.result, evidence: { ...ev, answer: undefined } })
          .catch((e) => console.error("fact cache write failed:", e.message));
      }
    }
    if (value !== undefined) return { value, evidence };
    if (r.errorCode === "budget") break;
  }
  return { evidence };
}

function safe<T>(f: () => T | undefined): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
}

/**
 * A direct ask to one named miner, through the Telegraph engine. Used only where
 * routing cannot work yet: an intent with no response format, so Telegraph cannot
 * evaluate and rank its miners. Remove once the intent is evaluated.
 */
export async function pinned(
  ctx: RunCtx,
  intent: string,
  slug: string,
  req: Omit<AskRequest, "minerId">,
  why: string,
): Promise<Attempt[]> {
  try {
    const m = (await ctx.tg.rankedMiners(intent)).find((x) => x.slug === slug);
    return m ? [{ req: { ...req, minerId: m.id }, why }] : [];
  } catch {
    return [];
  }
}

/** A routed ask: Telegraph picks the best-ranked miner for the intent. */
export function auto(intent: string, params?: Record<string, unknown>, query?: string): Attempt {
  return { req: { intent, params, query }, why: `routed by Telegraph to its best-ranked ${intent} miner` };
}

function trim(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  const clone = structuredClone(v) as any;
  // GoPlus holder/LP lists are long; keep the top entries only.
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (Array.isArray(o[k]) && o[k].length > 10) o[k] = o[k].slice(0, 10);
      else walk(o[k]);
    }
  };
  walk(clone);
  const s = JSON.stringify(clone);
  return s.length > 6000 ? { truncated: true, preview: s.slice(0, 6000) } : clone;
}
