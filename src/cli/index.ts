#!/usr/bin/env node
/**
 * vetted <token> [--chain ethereum] [--mode listing|pretrade] [--issuer "Acme Ltd"] [--people "A,B"]
 *        [--x handle] [--website example.com] [--trade 5000] [--budget 0.4] [--fresh] [--json] [--simulate]
 * vetted verify <memo.json>
 */
import fs from "node:fs";
import { bootstrap } from "../app.js";
import { loadConfig } from "../core/config.js";
import { validateApplication, vet } from "../vet/engine.js";
import { verifyMemo, type Memo } from "../vet/memo.js";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);
const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const icon = { pass: `${c.g}✔${c.x}`, warn: `${c.y}▲${c.x}`, fail: `${c.r}✖${c.x}`, unknown: `${c.d}?${c.x}` } as const;

async function main() {
  if (!argv.length || has("help")) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2, 6).join("\n").replace(/^ \* ?/gm, ""));
    return;
  }
  const cfg = loadConfig(has("simulate") ? { simulate: true } : {});

  if (argv[0] === "verify") {
    const memo = JSON.parse(fs.readFileSync(argv[1], "utf8")) as Memo;
    const v = await verifyMemo(memo, cfg.nodeUrl);
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.digestMatches && (v.simulated || (v.signatureValid && v.allSignalsVerified)) ? 0 : 1);
  }

  const app = validateApplication({
    token: argv[0], chain: flag("chain"), mode: flag("mode"), issuer: flag("issuer"), people: flag("people"),
    xHandle: flag("x"), website: flag("website"), tradeUsd: flag("trade"),
  });
  const { tg, memos, store } = await bootstrap(has("simulate") ? { simulate: true } : {});
  const json = has("json");
  if (!json) {
    console.error(`${c.b}Vetted${c.x} ${app.mode} diligence for ${app.token} on ${app.chain}`);
    console.error(tg.simulated ? `${c.y}SIMULATED: no wallet or VETTED_SIMULATE=1. No Telegraph purchases are made.${c.x}` : `${c.d}payer ${tg.account!.address} · budget $${tg.runBudget(Number(flag("budget") ?? cfg.maxPerMemoUsd)).limitUsd}${c.x}`);
  }
  const memo = await vet(tg, app, (e) => {
    if (json) return;
    if (e.type === "attempt") {
      const ev = e.evidence;
      console.error(`  ${c.d}${ev.reused && ev.usable ? "reused" : ev.usable ? "bought" : ev.ok ? "unusable" : "failed"} ${e.check} ← ${ev.minerSlug ?? ev.intent} $${ev.costUsd.toFixed(3)} ${ev.durationMs}ms${ev.error ? ` (${ev.error})` : ""}${c.x}`);
    }
  }, flag("budget") ? Number(flag("budget")) : undefined, { fresh: has("fresh") });
  await memos.save(memo);
  await store.close();

  if (json) {
    console.log(JSON.stringify(memo, null, 2));
    return;
  }
  const v = memo.verdict;
  const col = /LIST|ALLOW/.test(v.decision) ? c.g : /REVIEW|CAUTION/.test(v.decision) ? c.y : c.r;
  console.log(`\n${c.b}${memo.token.name ?? ""} ${memo.token.symbol ? `(${memo.token.symbol})` : ""}${c.x}  ${col}${c.b}${v.decision}${c.x}  score ${v.score}/100`);
  for (const f of memo.findings) console.log(`  ${icon[f.status]} ${c.b}${f.label}${c.x}: ${f.summary}`);
  console.log(`\n  ${v.reasons.join(" ")}`);
  console.log(`  ${c.d}cost $${memo.cost.totalUsd.toFixed(3)} · ${memo.cost.purchases} new purchases, ${memo.cost.reused ?? 0} reused (${memo.cost.unusable} unusable) · ${(memo.durationMs / 1000).toFixed(1)}s · memo ${memo.id} (${store.kind})${c.x}`);
  if (memo.signature) console.log(`  ${c.d}signed by ${memo.signer} · digest ${memo.digest}${c.x}`);
}

main().catch((e) => {
  console.error(`${c.r}${e.message}${c.x}`);
  process.exit(1);
});
