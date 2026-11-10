import { randomUUID } from "node:crypto";
import { SEPOLIA } from "../core/config.js";
import type { TelegraphClient } from "../core/telegraph.js";
import type { RunCtx, VetEvent } from "./buy.js";
import { checkContract, checkHolders, checkLiquidity, checkSanctions, checkSocial, checkSupply, checkWash, checkWebsite } from "./checks.js";
import { MEMO_VERSION, signMemo, type Memo } from "./memo.js";
import { CHAINS, type Application, type Finding } from "./types.js";
import { decide } from "./verdict.js";

export class InvalidApplicationError extends Error {}

export function validateApplication(input: any): Application {
  const chain = String(input?.chain ?? "ethereum").toLowerCase();
  if (!(chain in CHAINS)) throw new InvalidApplicationError(`unsupported chain "${chain}"; use one of ${Object.keys(CHAINS).join(", ")}`);
  const token = String(input?.token ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new InvalidApplicationError("token must be a 0x-prefixed 20-byte contract address");
  const mode = input?.mode === "pretrade" ? "pretrade" : "listing";
  const clean = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const people = Array.isArray(input?.people) ? input.people : typeof input?.people === "string" ? input.people.split(",") : [];
  const tradeUsd = input?.tradeUsd !== undefined && input?.tradeUsd !== "" ? Number(input.tradeUsd) : undefined;
  if (tradeUsd !== undefined && (!Number.isFinite(tradeUsd) || tradeUsd <= 0)) throw new InvalidApplicationError("tradeUsd must be a positive number");
  return {
    chain: chain as Application["chain"],
    token: token.toLowerCase() as `0x${string}`,
    mode,
    projectName: clean(input?.projectName),
    issuer: clean(input?.issuer),
    people: people.map((p: unknown) => clean(p)).filter(Boolean).slice(0, 3),
    xHandle: clean(input?.xHandle, 40),
    website: clean(input?.website, 200),
    tradeUsd,
  };
}

/**
 * Run a full diligence pass. Independent checks are bought in parallel; checks
 * that need the contract scan (liquidity pool, supply cross-check, top-holder
 * concentration) start as soon as it lands.
 */
export async function vet(tg: TelegraphClient, app: Application, emit: (e: VetEvent) => void = () => {}, budgetUsd?: number): Promise<Memo> {
  const started = Date.now();
  const runId = randomUUID().slice(0, 12);
  const budget = tg.runBudget(budgetUsd);
  const ctx: RunCtx = { tg, budget, runId, app, emit };
  emit({ type: "run", runId, app, simulated: tg.simulated, payer: tg.account?.address });

  const done = (f: Finding | undefined) => {
    if (f) emit({ type: "check:done", check: f.check, finding: f });
    return f;
  };
  const start = (check: string, label: string) => emit({ type: "check:start", check, label });

  const listing = app.mode === "listing";
  start("contract", "Contract security");
  const contractP = checkContract(ctx).then((f) => (done(f), f));

  const tasks: Promise<Finding | undefined>[] = [contractP];
  start("liquidity", "On-chain liquidity");
  tasks.push(contractP.then((c) => checkLiquidity(ctx, c.contract)).then(done));
  start("holders", "Holder base & concentration");
  tasks.push(contractP.then((c) => checkHolders(ctx, c.contract)).then(done));
  start("wash", "Wash-trading signals");
  tasks.push(checkWash(ctx).then(done));
  if (listing) {
    start("supply", "Supply verification (quorum)");
    tasks.push(contractP.then((c) => checkSupply(ctx, c.contract)).then(done));
    if (app.issuer || app.people?.length) {
      start("sanctions", "Sanctions screening");
      tasks.push(checkSanctions(ctx).then(done));
    }
    if (app.xHandle) {
      start("social", "Community authenticity");
      tasks.push(checkSocial(ctx).then(done));
    }
    if (app.website) {
      start("website", "Website safety");
      tasks.push(checkWebsite(ctx).then(done));
    }
  }

  const findings = (await Promise.all(tasks)).filter((f): f is Finding => !!f);
  const contract = (await contractP).contract;
  const evidence = findings.flatMap((f) => f.evidence);
  const memo: Memo = {
    version: MEMO_VERSION,
    id: `${new Date().toISOString().slice(0, 10)}-${runId}`,
    createdAt: new Date().toISOString(),
    network: SEPOLIA.network,
    simulated: tg.simulated,
    application: app,
    token: { name: contract?.name, symbol: contract?.symbol },
    verdict: decide(app.mode, findings),
    findings,
    cost: {
      totalUsd: Math.round(evidence.reduce((s, e) => s + e.costUsd, 0) * 1e6) / 1e6,
      purchases: evidence.filter((e) => e.ok).length,
      usable: evidence.filter((e) => e.usable).length,
      unusable: evidence.filter((e) => e.ok && !e.usable).length,
      failed: evidence.filter((e) => !e.ok).length,
      budgetUsd: budget.limitUsd,
    },
    durationMs: Date.now() - started,
    payer: tg.account?.address,
  };
  const signed = await signMemo(memo, tg.account);
  emit({ type: "memo", memo: signed });
  return signed;
}
