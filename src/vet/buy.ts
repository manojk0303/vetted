import type { Budget } from "../core/budget.js";
import type { AskRequest, TelegraphClient } from "../core/telegraph.js";
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
}

/**
 * Buy one fact. Tries each attempt in order and stops at the first answer the
 * extractor accepts. Every attempt, paid or not, usable or not, is kept as
 * evidence, so a junk answer from a miner is visible in the memo.
 */
export async function buy<T>(
  ctx: RunCtx,
  check: string,
  attempts: Attempt[],
  extract: (answer: unknown) => T | undefined,
  maxPaid = 2,
): Promise<{ value?: T; evidence: Evidence[] }> {
  const evidence: Evidence[] = [];
  let paid = 0;
  for (const a of attempts) {
    if (paid >= maxPaid) break;
    const r = await ctx.tg.ask(a.req, { budget: ctx.budget, runId: ctx.runId, check });
    if (r.ok) paid++;
    let value: T | undefined;
    if (r.ok) {
      try {
        value = extract(r.result);
      } catch {
        value = undefined;
      }
    }
    const ev: Evidence = {
      intent: r.intent ?? a.req.intent,
      minerId: r.minerId,
      minerSlug: r.minerSlug,
      ok: r.ok,
      usable: value !== undefined,
      costUsd: r.ok ? r.costUsd : 0,
      durationMs: r.durationMs,
      signalHash: r.receipt.signalHash,
      receiptHash: r.receipt.receiptHash,
      txHash: r.receipt.txHash,
      simulated: r.simulated,
      error: r.ok ? (value === undefined ? "answer did not contain the required fields" : undefined) : r.error,
      answer: trim(r.result),
    };
    evidence.push(ev);
    ctx.emit({ type: "attempt", check, why: a.why, evidence: ev });
    if (value !== undefined) return { value, evidence };
    if (r.errorCode === "budget") break;
  }
  return { evidence };
}

/** Resolve a miner by slug (ids can change between epochs) and build a direct ask. */
export async function directBySlug(
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

/** Canonical direct asks to the N best-ranked miners for an intent. */
export async function topRanked(
  ctx: RunCtx,
  intent: string,
  params: Record<string, unknown>,
  n: number,
  exclude: string[] = [],
): Promise<Attempt[]> {
  try {
    return (await ctx.tg.rankedMiners(intent))
      .filter((m) => !exclude.includes(m.slug))
      .slice(0, n)
      .map((m) => ({ req: { intent, params, minerId: m.id }, why: `rank #${m.rank ?? "?"} for ${intent} (${m.slug})` }));
  } catch {
    return [];
  }
}

export function auto(intent: string, params?: Record<string, unknown>, query?: string): Attempt {
  return { req: { intent, params, query }, why: `auto-routed by Telegraph to the best-ranked ${intent} miner` };
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
