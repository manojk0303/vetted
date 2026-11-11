import { bool, findKey, num, str, taxPct, toBool, toNum } from "../core/extract.js";
import { applyTrust, auto, buy, directBySlug, record, topRanked, type RunCtx } from "./buy.js";
import { CHAINS, type Finding, type Status } from "./types.js";

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

function finding(check: string, label: string, status: Status, summary: string, facts: Record<string, unknown>, evidence: Finding["evidence"], flags: string[] = []): Finding {
  return { check, label, status, summary, facts, flags, evidence };
}

// ---------------------------------------------------------------- contract security

export interface ContractFacts {
  name?: string;
  symbol?: string;
  totalSupply?: number;
  holderCount?: number;
  honeypot?: boolean;
  buyTaxPct?: number;
  sellTaxPct?: number;
  mintable?: boolean;
  ownerRenounced?: boolean;
  ownerCanChangeBalance?: boolean;
  hiddenOwner?: boolean;
  canTakeBackOwnership?: boolean;
  proxy?: boolean;
  openSource?: boolean;
  cannotSellAll?: boolean;
  blacklist?: boolean;
  slippageModifiable?: boolean;
  transferPausable?: boolean;
  top10Pct?: number;
  bestPool?: { pair: string; dex: string; liquidityUsd: number };
}

const ZERO = /^0x0{40}$/i;

export function parseContract(answer: unknown): ContractFacts | undefined {
  const honeypot = bool(answer, ["is_honeypot", "honeypot"]);
  const buyTax = taxPct(findKey(answer, ["buy_tax"]));
  if (honeypot === undefined && buyTax === undefined) return undefined;
  const owner = str(answer, ["owner_address"]);
  const holders = findKey(answer, ["holders"]);
  let top10Pct: number | undefined;
  if (Array.isArray(holders)) {
    top10Pct = holders.slice(0, 10).reduce((s: number, h: any) => s + (toNum(h?.percent) ?? 0), 0) * 100;
  }
  const dex = findKey(answer, ["dex"]);
  let bestPool: ContractFacts["bestPool"];
  if (Array.isArray(dex)) {
    for (const d of dex as any[]) {
      const liq = toNum(d?.liquidity);
      if (liq !== undefined && d?.pair && (!bestPool || liq > bestPool.liquidityUsd)) bestPool = { pair: d.pair, dex: d.name, liquidityUsd: liq };
    }
  }
  return {
    name: str(answer, ["token_name", "name"]),
    symbol: str(answer, ["token_symbol", "symbol"]),
    totalSupply: num(answer, ["total_supply"]),
    holderCount: num(answer, ["holder_count"]),
    honeypot,
    buyTaxPct: buyTax,
    sellTaxPct: taxPct(findKey(answer, ["sell_tax"])),
    mintable: bool(answer, ["is_mintable"]),
    ownerRenounced: owner === undefined ? undefined : ZERO.test(owner) || owner === "",
    ownerCanChangeBalance: bool(answer, ["owner_change_balance"]),
    hiddenOwner: bool(answer, ["hidden_owner"]),
    canTakeBackOwnership: bool(answer, ["can_take_back_ownership"]),
    proxy: bool(answer, ["is_proxy"]),
    openSource: bool(answer, ["is_open_source"]),
    cannotSellAll: bool(answer, ["cannot_sell_all"]),
    blacklist: bool(answer, ["is_blacklisted"]),
    slippageModifiable: bool(answer, ["slippage_modifiable"]),
    transferPausable: bool(answer, ["transfer_pausable"]),
    top10Pct,
    bestPool,
  };
}

export async function checkContract(ctx: RunCtx): Promise<Finding & { contract?: ContractFacts }> {
  const { app } = ctx;
  const intent = "SMART_CONTRACT_AUDIT_GENERAL";
  const attempts = [
    ...(await directBySlug(ctx, intent, "goplus-security", {
      intent, method: "GET", endpoint: "/token-security",
      payload: { chain_id: CHAINS[app.chain].id, contract_addresses: app.token },
    }, "GoPlus contract scan via Telegraph (structured flags)")),
    auto(intent, undefined, `Smart contract security audit of token ${app.token} on ${CHAINS[app.chain].label}: honeypot, buy and sell tax, owner privileges, mintability, proxy, holder concentration.`),
  ];
  const { value: c, evidence } = await buy(ctx, "contract", attempts, parseContract);
  const label = "Contract security";
  if (!c) return finding("contract", label, "unknown", "No usable contract scan could be bought. Listing cannot proceed without one.", {}, evidence, ["REVIEW_NO_CONTRACT_SCAN"]);

  const flags: string[] = [];
  const issues: string[] = [];
  let status: Status = "pass";
  const bad = (s: Status, msg: string, flag?: string) => {
    issues.push(msg);
    if (flag) flags.push(flag);
    if (s === "fail" || (s === "warn" && status === "pass")) status = s;
  };
  if (c.honeypot) bad("fail", "honeypot: holders cannot sell", "REJECT_HONEYPOT");
  if (c.cannotSellAll) bad("fail", "holders cannot sell their full balance", "REJECT_CANNOT_SELL_ALL");
  if ((c.sellTaxPct ?? 0) > 25) bad("fail", `sell tax ${c.sellTaxPct!.toFixed(1)}%`, "REJECT_PUNITIVE_TAX");
  else if ((c.sellTaxPct ?? 0) > 5 || (c.buyTaxPct ?? 0) > 5) bad("warn", `transfer tax buy ${c.buyTaxPct?.toFixed(1)}% / sell ${c.sellTaxPct?.toFixed(1)}%`);
  if (c.ownerCanChangeBalance) bad("fail", "owner can rewrite balances", "REVIEW_OWNER_CHANGE_BALANCE");
  if (c.hiddenOwner) bad("fail", "hidden owner", "REVIEW_HIDDEN_OWNER");
  if (c.canTakeBackOwnership) bad("warn", "ownership can be reclaimed");
  if (c.mintable && c.ownerRenounced === false) bad("warn", "owner can mint new supply", "REVIEW_MINTABLE");
  if (c.proxy) bad("warn", "upgradeable proxy: logic can change after listing");
  if (c.openSource === false) bad("fail", "source code not verified", "REVIEW_CLOSED_SOURCE");
  if (c.blacklist) bad("warn", "contract can blacklist addresses");
  if (c.transferPausable) bad("warn", "transfers can be paused");
  if (c.slippageModifiable) bad("warn", "tax/slippage can be changed by owner");

  const who = [c.name, c.symbol && `(${c.symbol})`].filter(Boolean).join(" ");
  const summary = issues.length ? `${who}: ${issues.join("; ")}.` : `${who}: no honeypot, no punitive tax, ${c.ownerRenounced ? "ownership renounced" : "no dangerous owner powers detected"}, source verified.`;
  return { ...finding("contract", label, status, summary, c as Record<string, unknown>, evidence, flags), contract: c };
}

// ---------------------------------------------------------------- quorum helper

export interface Reading {
  source: string;
  value: number;
  /** Intent the reading was bought under (undefined for the contract scanner). */
  intent?: string;
  /** Reused from an earlier purchase: already counted in miner track records. */
  reused?: boolean;
}

export interface Consensus {
  value?: number;
  agreeing: Reading[];
  outliers: Reading[];
  /** True when the largest agreeing group has ≥2 independent sources and is strictly the biggest. */
  majority: boolean;
}

/**
 * Group readings that agree within `tolPct` and pick the largest group. Ranked
 * miners are sometimes confidently wrong (a USDC-only miner answering for any
 * token, a miner that ignored its params), so one dissenting source should be
 * named and set aside, not averaged in and not allowed to veto a clear majority.
 */
export function consensus(readings: Reading[], tolPct: number): Consensus {
  const close = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12) * 100 <= tolPct;
  let best: Reading[] = [];
  let tie = false;
  for (const r of readings) {
    const group = readings.filter((x) => close(x.value, r.value));
    if (group.length > best.length) {
      best = group;
      tie = false;
    } else if (group.length === best.length && !group.every((g) => best.includes(g))) tie = true;
  }
  const majority = best.length >= 2 && !tie;
  const sorted = [...best].map((r) => r.value).sort((a, b) => a - b);
  return {
    value: majority ? sorted[Math.floor(sorted.length / 2)] : undefined,
    agreeing: majority ? best : [],
    outliers: majority ? readings.filter((r) => !best.includes(r)) : readings,
    majority,
  };
}

/**
 * Buy the same deterministic fact from several sources until a majority forms
 * (counting the contract scanner as one source) or the paid-attempt cap is hit.
 * The node refuses incompatible miners before payment, so those cost nothing.
 */
async function buyQuorum(
  ctx: RunCtx,
  check: string,
  attempts: import("./types.js").Attempt[],
  extract: (a: unknown) => number | undefined,
  scanner: number | undefined,
  tolPct: number,
  maxPaid = 3,
): Promise<{ readings: Reading[]; consensus: Consensus; evidence: Finding["evidence"] }> {
  const readings: Reading[] = scanner !== undefined ? [{ source: "contract scanner", value: scanner }] : [];
  const evidence: Finding["evidence"] = [];
  const seen = new Set<string>();
  let paid = 0;
  for (const a of await applyTrust(ctx, attempts)) {
    if (paid >= maxPaid) break;
    if (readings.length >= 2 && consensus(readings, tolPct).majority && readings.length - (scanner !== undefined ? 1 : 0) >= 1) {
      // A majority that includes at least one miner reading is enough.
      break;
    }
    if (a.req.minerId && seen.has(a.req.minerId)) continue;
    const r = await buy(ctx, check, [a], extract, 1);
    evidence.push(...r.evidence);
    const ev = r.evidence[0];
    if (ev?.minerId) {
      if (seen.has(ev.minerId) && r.value !== undefined) continue; // auto-route landed on a miner we already counted
      seen.add(ev.minerId);
    }
    if (ev?.ok && !ev.reused) paid++;
    if (r.value !== undefined) readings.push({ source: ev?.minerSlug ?? ev?.minerId ?? "miner", value: r.value, intent: ev?.intent, reused: ev?.reused });
    if (ev?.error?.startsWith("budget")) break;
  }
  const c = consensus(readings, tolPct);
  if (c.majority) {
    // Feed the vote back into each miner's track record (once per purchase, never for reused answers).
    for (const r of readings) {
      if (!r.intent || r.reused) continue;
      await record(ctx, r.intent, r.source, c.agreeing.includes(r) ? "agree" : "disagree");
    }
  }
  return { readings, consensus: c, evidence };
}

const describeOutliers = (c: Consensus, fmt: (n: number) => string) =>
  c.outliers.length ? ` Set aside: ${c.outliers.map((o) => `${o.source} (${fmt(o.value)})`).join(", ")}.` : "";

// ---------------------------------------------------------------- holders & concentration

export async function checkHolders(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "TOKEN_HOLDER_COUNT_GENERAL";
  const params = { token: app.token, chain: app.chain };
  const attempts = [
    auto(intent, params),
    ...(await directBySlug(ctx, intent, "chainwire-holder-count", { intent, params }, "Blockscout explorer holder count via Telegraph")),
    ...(await topRanked(ctx, intent, params, 4)),
  ];
  const extract = (a: unknown) => num(a, ["holders_count", "holders", "holder_count", "count"]);
  const { readings, consensus: c, evidence } = await buyQuorum(ctx, "holders", attempts, extract, contract?.holderCount, 10);
  const label = "Holder base & concentration";
  const top10 = contract?.top10Pct;
  if (!readings.length) return finding("holders", label, "unknown", "Holder count could not be bought from Telegraph.", { top10Pct: top10 }, evidence);

  const value = c.value ?? readings[readings.length - 1].value;
  const min = app.mode === "listing" ? 1000 : 300;
  let status: Status = value >= min ? "pass" : value >= min / 4 ? "warn" : "fail";
  const parts = [c.majority ? `${fmtInt(value)} holders (${c.agreeing.length} sources agree within 10%)` : `holder count unconfirmed: ${readings.map((r) => `${r.source} ${fmtInt(r.value)}`).join(" vs ")}`];
  if (top10 !== undefined) {
    parts.push(`top-10 wallets hold ${top10.toFixed(1)}%`);
    if (top10 > 70 && status !== "fail") status = "warn";
  }
  if (!c.majority && status === "pass") status = "warn";
  return finding("holders", label, status, parts.join(", ") + "." + describeOutliers(c, fmtInt),
    { holders: c.value, readings, majority: c.majority, top10Pct: top10 }, evidence);
}

// ---------------------------------------------------------------- supply quorum

export async function checkSupply(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL";
  const params = { token: `${app.token} on ${CHAINS[app.chain].label}` };
  // General multi-chain miners first: several top-ranked supply miners are single-asset
  // (e.g. USDC-only) and answer with their own asset's supply whatever token is asked.
  const general = (await Promise.all(
    ["a1-preflight", "livecert", "txlens"].map((slug) => directBySlug(ctx, intent, slug, { intent, params }, `general on-chain miner ${slug}`)),
  )).flat();
  const attempts = [...general, ...(await topRanked(ctx, intent, params, 8)), auto(intent, params)];
  const extract = (x: unknown) => num(x, ["total_supply", "totalSupply", "supply"]);
  const { readings, consensus: c, evidence } = await buyQuorum(ctx, "supply", attempts, extract, contract?.totalSupply, 1);
  const label = "Supply verification (quorum)";
  if (readings.length < 2) {
    return finding("supply", label, "unknown", `Only ${readings.length} independent supply reading(s); quorum needs 2.`, { readings }, evidence);
  }
  if (c.majority) {
    return finding("supply", label, c.outliers.length ? "warn" : "pass",
      `${c.agreeing.length} independent sources agree on total supply ≈ ${fmtInt(c.value!)} (${c.agreeing.map((r) => r.source).join(", ")}).${describeOutliers(c, fmtInt)}`,
      { supply: c.value, readings, majority: true }, evidence);
  }
  return finding("supply", label, "warn",
    `No majority on total supply: ${readings.map((r) => `${r.source} ${fmtInt(r.value)}`).join(" vs ")}. Possible stale source, rebasing token or misreported supply.`,
    { readings, majority: false }, evidence, ["REVIEW_SUPPLY_DISAGREEMENT"]);
}

// ---------------------------------------------------------------- liquidity

export async function checkLiquidity(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "LIQUIDITY_DEPTH_VERIFY_GENERAL";
  const pool = contract?.bestPool?.pair;
  const attempts = pool
    ? [auto(intent, { pool, chain: app.chain }), ...(await topRanked(ctx, intent, { pool, chain: app.chain }, 1))]
    : [auto(intent, undefined, `What is the total USD liquidity of the main DEX pool for token ${app.token}${contract?.symbol ? ` (${contract.symbol})` : ""} on ${CHAINS[app.chain].label}?`)];
  const { value, evidence } = await buy(ctx, "liquidity", attempts, (a) => {
    const v = num(a, ["liquidity_usd", "liquidityUsd", "liquidity", "tvl_usd", "reserve_usd"]);
    return v !== undefined && v > 0 ? v : undefined;
  });
  const label = "On-chain liquidity";
  const scanner = contract?.bestPool?.liquidityUsd;
  const liq = value ?? undefined;
  if (liq === undefined) {
    return finding("liquidity", label, "unknown", `Liquidity could not be verified through Telegraph${scanner ? ` (contract scanner alone reports ${fmtUsd(scanner)})` : ""}.`, { scannerLiquidityUsd: scanner, pool }, evidence);
  }
  const [failBelow, warnBelow] = app.mode === "listing" ? [50_000, 250_000] : [10_000, 50_000];
  let status: Status = liq < failBelow ? "fail" : liq < warnBelow ? "warn" : "pass";
  const parts = [`${fmtUsd(liq)} in the deepest pool${contract?.bestPool ? ` (${contract.bestPool.dex} ${pool!.slice(0, 10)}…)` : ""}`];
  if (scanner) {
    const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= 0.15;
    // The contract scanner reports one side of the pool; liquidity miners usually report both sides.
    if (near(liq, 2 * scanner)) parts.push(`cross-checked: contract scanner reports ${fmtUsd(scanner)} per side`);
    else if (near(liq, scanner)) parts.push(`cross-checked against contract scanner (${fmtUsd(scanner)})`);
    else {
      parts.push(`contract scanner reports ${fmtUsd(scanner)}; sources disagree`);
      if (status === "pass") status = "warn";
    }
  }
  if (!pool) {
    // No pool address from the contract scan: the miner picked a pool itself, so the figure
    // may not be the token's deepest venue (e.g. stablecoins listed on many pools).
    parts.push("pool not identified by the contract scan, so this is the miner's choice of pool and may understate total liquidity");
    if (status === "fail") status = "warn";
  }
  const facts: Record<string, unknown> = { liquidityUsd: liq, scannerLiquidityUsd: scanner, pool };
  if (app.mode === "pretrade" && app.tradeUsd) {
    // Constant-product approximation: price impact ≈ trade / (pool_side + trade); pool_side ≈ liq/2.
    const impactPct = (app.tradeUsd / (liq / 2 + app.tradeUsd)) * 100;
    const maxAt2Pct = (0.02 / 0.98) * (liq / 2);
    facts.priceImpactPct = impactPct;
    facts.maxTradeAt2PctUsd = maxAt2Pct;
    parts.push(`a ${fmtUsd(app.tradeUsd)} trade moves price ≈${impactPct.toFixed(2)}%; max size at 2% impact ≈ ${fmtUsd(maxAt2Pct)}`);
    if (impactPct > 5) status = pool ? "fail" : "warn";
    else if (impactPct > 2 && status === "pass") status = "warn";
  }
  return finding("liquidity", label, status, parts.join("; ") + ".", facts, evidence, status === "fail" && app.mode === "listing" ? ["REVIEW_THIN_LIQUIDITY"] : []);
}

// ---------------------------------------------------------------- wash trading

export async function checkWash(ctx: RunCtx): Promise<Finding> {
  const { app } = ctx;
  const intent = "WASH_TRADING_DETECTION_GENERAL";
  const supported = ["ethereum", "base", "arbitrum", "optimism", "polygon"].includes(app.chain);
  const attempts = [
    ...(supported ? await directBySlug(ctx, intent, "verifywire-wash-trading", {
      intent, method: "GET", endpoint: "/washtrade", payload: { chain: app.chain, token: app.token, blocks: "300" },
    }, "live Transfer-log scan for reciprocal flows via Telegraph") : []),
    auto(intent, { subject: `${app.token} on ${CHAINS[app.chain].label}` }),
  ];
  const { value, evidence } = await buy(ctx, "wash", attempts, (a) => {
    const verdict = str(a, ["verdict", "risk_label"]);
    const pct = num(a, ["wash_volume_pct", "round_trip_volume_share_percent"]);
    const score = num(a, ["risk_score", "wash_score"]);
    if (verdict === undefined && pct === undefined && score === undefined) return undefined;
    return { verdict: verdict?.toLowerCase(), pct, score, transfers: num(a, ["transfers"]) };
  });
  const label = "Wash-trading signals";
  if (!value) return finding("wash", label, "unknown", "No usable wash-trading read could be bought.", {}, evidence);
  const v = value.verdict ?? "";
  let status: Status = "pass";
  const flags: string[] = [];
  if (v === "wash_trading" || v === "high" || (value.pct ?? 0) > 40) {
    status = "fail";
    flags.push("REVIEW_WASH_TRADING");
  } else if (v === "likely_wash_trading" || v === "medium" || v === "elevated" || (value.pct ?? 0) > 20) status = "warn";
  const summary = `${v ? `Verdict ${v.toUpperCase()}` : "Read complete"}${value.pct !== undefined ? `, round-trip volume ${value.pct.toFixed(1)}%` : ""}${value.transfers ? ` over ${fmtInt(value.transfers)} recent transfers` : ""}. A heuristic signal, not proof of intent.`;
  return finding("wash", label, status, summary, value, evidence, flags);
}

// ---------------------------------------------------------------- sanctions

export async function checkSanctions(ctx: RunCtx): Promise<Finding | undefined> {
  const names = [ctx.app.issuer, ...(ctx.app.people ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s).slice(0, 3);
  if (!names.length) return undefined;
  const intent = "SANCTIONS_SCREENING_MATCH_GENERAL";
  const extract = (a: unknown) => {
    const m = toBool(findKey(a, ["matched", "match", "on_list", "is_match"]));
    return m === undefined ? undefined : { matched: m, score: num(a, ["match_score", "score"]), summary: str(a, ["summary"]) };
  };
  // A missed sanctions hit is the costliest error in a listing memo, so every name is
  // screened by two independent miners, in parallel, and any disagreement goes to a human.
  const results = await Promise.all(
    names.map(async (name) => {
      const [first, second] = await Promise.all([
        (async () => buy(ctx, "sanctions", [
          ...(await directBySlug(ctx, intent, "zk-sanctions", { intent, method: "GET", endpoint: "/screen", payload: { name } }, "OFAC/UK/EU/UN list screen via Telegraph")),
          auto(intent, { name }),
        ], extract))(),
        (async () => buy(ctx, "sanctions", await topRanked(ctx, intent, { name }, 6, ["zk-sanctions"]), extract))(),
      ]);
      const opinions = [first, second]
        .map((r) => ({ miner: r.evidence.find((e) => e.usable)?.minerSlug ?? "miner", value: r.value }))
        .filter((o): o is { miner: string; value: NonNullable<typeof o.value> } => o.value !== undefined);
      // Two answers from the same miner are one opinion.
      const distinct = opinions.filter((o, i) => opinions.findIndex((x) => x.miner === o.miner) === i);
      return { name, opinions: distinct, evidence: [...first.evidence, ...second.evidence] };
    }),
  );
  const evidence = results.flatMap((r) => r.evidence);
  const label = "Sanctions screening";
  const facts = { screened: names, opinions: results.map((r) => ({ name: r.name, opinions: r.opinions.map((o) => ({ miner: o.miner, matched: o.value.matched })) })) };

  const hits = results.filter((r) => r.opinions.some((o) => o.value.matched));
  if (hits.length) {
    const h = hits[0];
    const yes = h.opinions.filter((o) => o.value.matched).map((o) => o.miner);
    const no = h.opinions.filter((o) => !o.value.matched).map((o) => o.miner);
    const summary = (h.opinions.find((o) => o.value.matched)?.value.summary ?? "sanctions-list match").replace(/\.+$/, "");
    const dispute = no.length ? ` Miners disagree: ${yes.join(", ")} report a match, ${no.join(", ")} do not.` : ` Confirmed by ${yes.length} miner${yes.length > 1 ? "s" : ""}.`;
    return finding("sanctions", label, "fail",
      `Name alert for ${hits.map((x) => `"${x.name}"`).join(", ")}: ${summary}.${dispute} A name match needs identity review before any listing.`,
      facts, evidence, no.length ? ["REVIEW_SANCTIONS_MATCH", "REVIEW_SANCTIONS_DISAGREEMENT"] : ["REVIEW_SANCTIONS_MATCH"]);
  }
  const unscreened = results.filter((r) => r.opinions.length === 0);
  if (unscreened.length === results.length) return finding("sanctions", label, "unknown", "Sanctions screening could not be bought.", facts, evidence, ["REVIEW_SANCTIONS_UNSCREENED"]);
  const single = results.filter((r) => r.opinions.length === 1);
  const parts = [`${names.length - unscreened.length}/${names.length} names screened, no list match`];
  if (single.length) parts.push(`only one miner could screen ${single.map((r) => `"${r.name}"`).join(", ")}`);
  else parts.push("each name confirmed by 2 independent miners");
  if (unscreened.length) parts.push(`${unscreened.map((u) => `"${u.name}"`).join(", ")} could not be screened`);
  return finding("sanctions", label, single.length || unscreened.length ? "warn" : "pass", `${parts.join("; ")}. A negative is not sanctions clearance.`, facts, evidence);
}

// ---------------------------------------------------------------- social authenticity

export async function checkSocial(ctx: RunCtx): Promise<Finding | undefined> {
  const handle = ctx.app.xHandle?.replace(/^@/, "").trim();
  if (!handle) return undefined;
  const intent = "SOCIAL_BOT_DETECTION_GENERAL";
  const attempts = [auto(intent, { account: `@${handle}` }), ...(await topRanked(ctx, intent, { account: `@${handle}` }, 1))];
  const { value, evidence } = await buy(ctx, "social", attempts, (a) => {
    const verdict = str(a, ["verdict", "label", "classification"]);
    const score = num(a, ["bot_score", "score", "bot_probability"]);
    return verdict === undefined && score === undefined ? undefined : { verdict: verdict?.toLowerCase(), score };
  });
  const label = "Community authenticity";
  if (!value) return finding("social", label, "unknown", `No usable bot-detection read for @${handle}.`, { handle }, evidence);
  const isBot = value.verdict === "bot" || value.verdict === "likely_bot" || (value.score ?? 0) >= 0.7;
  const unsure = value.verdict === "inconclusive" || ((value.score ?? 0) >= 0.4 && !isBot);
  return finding("social", label, isBot ? "fail" : unsure ? "warn" : "pass",
    `@${handle}: ${value.verdict ?? "scored"}${value.score !== undefined ? ` (bot score ${value.score.toFixed(2)})` : ""}.`, { handle, ...value }, evidence);
}

// ---------------------------------------------------------------- website

export async function checkWebsite(ctx: RunCtx): Promise<Finding | undefined> {
  const raw = ctx.app.website?.trim();
  if (!raw) return undefined;
  const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return finding("website", "Website safety", "fail", `"${raw}" is not a valid URL.`, {}, [], []);
  }
  const [safe, tls] = await Promise.all([
    buy(ctx, "website", [auto("URL_SAFE_GENERAL", { url }), auto("URL_SCAN_VERDICT", { url })], (a) => {
      const v = str(a, ["verdict", "risk_label"]);
      const s = bool(a, ["safe", "is_safe"]);
      return v === undefined && s === undefined ? undefined : { verdict: v?.toLowerCase() ?? (s ? "safe" : "suspicious"), reason: str(a, ["summary", "reason", "explanation"]) };
    }),
    buy(ctx, "website", [auto("SSL_VERIFICATION_CERT", { host })], (a) => bool(a, ["certificate_valid", "valid", "is_valid"]), 1),
  ]);
  const evidence = [...safe.evidence, ...tls.evidence];
  const label = "Website safety";
  const verdict = safe.value?.verdict;
  const flags: string[] = [];
  let status: Status = "pass";
  if (verdict === "malicious") {
    status = "fail";
    flags.push("REJECT_MALICIOUS_WEBSITE");
  } else if (verdict === "suspicious" || tls.value === false) status = "warn";
  else if (verdict === undefined && tls.value === undefined) status = "unknown";
  return finding("website", label, status, `${host}: ${verdict ? `verdict ${verdict}` : "no safety verdict"}, TLS ${tls.value === undefined ? "unchecked" : tls.value ? "valid" : "INVALID"}.${safe.value?.reason && verdict !== "safe" ? ` Miner's reasoning: "${safe.value.reason.slice(0, 220)}"` : ""}`, { url, verdict, reason: safe.value?.reason, tlsValid: tls.value }, evidence, flags);
}
