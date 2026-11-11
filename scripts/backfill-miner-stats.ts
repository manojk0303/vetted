/**
 * One-off: rebuild miner track records from the votes recorded in existing real memos
 * (who agreed with the majority, who was outvoted, who returned an unusable answer).
 * Refuses to run if track records already exist, so it can never double-count.
 *   npx tsx scripts/backfill-miner-stats.ts
 */
import { bootstrap } from "../src/app.js";
import type { MinerOutcome } from "../src/core/store.js";

const { store } = await bootstrap();
if ((await store.minerStats()).length > 0) {
  console.log("miner stats already exist; nothing to do");
  process.exit(0);
}

const tally = new Map<string, { intent: string; miner: string; agree: number; disagree: number; unusable: number }>();
const bump = (intent: string, miner: string, o: MinerOutcome) => {
  const k = `${intent}|${miner}`;
  const t = tally.get(k) ?? { intent, miner, agree: 0, disagree: 0, unusable: 0 };
  t[o]++;
  tally.set(k, t);
};

let memos = 0;
for (const s of await store.listMemos(10_000)) {
  if (s.simulated) continue;
  const m = await store.getMemo(s.id);
  if (!m) continue;
  memos++;
  for (const f of m.findings) {
    // Unusable answers: paid for, but missing the fields the check needed.
    for (const e of f.evidence) if (e.ok && !e.usable && !e.reused && e.intent && e.minerSlug) bump(e.intent, e.minerSlug, "unusable");
    // Majority votes (holders, supply).
    const facts = f.facts as { majority?: boolean; readings?: { source: string; value: number }[]; holders?: number; supply?: number };
    if (!facts.majority || !facts.readings) continue;
    const consensusValue = facts.holders ?? facts.supply;
    const tol = f.check === "supply" ? 0.01 : 0.1;
    if (consensusValue === undefined) continue;
    for (const r of facts.readings) {
      if (r.source === "contract scanner") continue;
      const intent = f.evidence.find((e) => e.minerSlug === r.source)?.intent;
      if (!intent) continue;
      const agrees = Math.abs(r.value - consensusValue) / Math.max(consensusValue, 1) <= tol;
      bump(intent, r.source, agrees ? "agree" : "disagree");
    }
  }
}

for (const t of tally.values()) {
  for (const o of ["agree", "disagree", "unusable"] as const) for (let i = 0; i < t[o]; i++) await store.recordMinerOutcome(t.intent, t.miner, o);
}
console.log(`rebuilt track records for ${tally.size} miners from ${memos} real memos:`);
for (const t of tally.values()) console.log(`  ${t.intent.padEnd(32)} ${t.miner.padEnd(26)} agree ${t.agree}  outvoted ${t.disagree}  unusable ${t.unusable}`);
await store.close();
