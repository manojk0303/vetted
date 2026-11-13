import { bool, findKey, num, str, taxPct, toBool, toNum } from "../core/extract.js";
import { auto, buy, pinned, reportQuality, type RunCtx } from "./buy.js";
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
  // The one pinned ask in Vetted. SMART_CONTRACT_AUDIT_GENERAL has no response format yet, so
  // Telegraph cannot evaluate or rank its miners, and a routed question lands on a general LLM
  // that answers "no findings" without reading the contract (observed live, 13 Nov 2026).
  // GoPlus is the miner on this intent that returns structured token-security flags. Routed
  // asking takes over once the intent has a response format and evaluations.
  const attempts = [
    ...(await pinned(ctx, intent, "goplus-security", {
      intent, method: "GET", endpoint: "/token-security",
      payload: { chain_id: CHAINS[app.chain].id, contract_addresses: app.token },
    }, "GoPlus token-security scan via the Telegraph engine (intent not yet rankable)")),
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
  // Blacklist, pause and tax switches are owner functions: with ownership renounced nobody can call them.
  if (c.ownerRenounced !== true) {
    if (c.blacklist) bad("warn", "contract can blacklist addresses");
    if (c.transferPausable) bad("warn", "transfers can be paused");
    if (c.slippageModifiable) bad("warn", "tax/slippage can be changed by owner");
  }

  const who = [c.name, c.symbol && `(${c.symbol})`].filter(Boolean).join(" ");
  const summary = issues.length ? `${who}: ${issues.join("; ")}.` : `${who}: no honeypot, no punitive tax, ${c.ownerRenounced ? "ownership renounced" : "no dangerous owner powers detected"}, source verified.`;
  return { ...finding("contract", label, status, summary, c as Record<string, unknown>, evidence, flags), contract: c };
}

// ---------------------------------------------------------------- cross-check helper

/** Compare a routed answer with a value Vetted already holds from the contract scan (no extra purchase). */
function crossCheck(value: number, scanner: number | undefined, tolPct: number): "agree" | "disagree" | "none" {
  if (scanner === undefined) return "none";
  return (Math.abs(value - scanner) / Math.max(Math.abs(value), Math.abs(scanner), 1e-12)) * 100 <= tolPct ? "agree" : "disagree";
}

const minerOf = (ev: Finding["evidence"]) => ev.find((e) => e.usable)?.minerSlug ?? "the routed miner";

// ---------------------------------------------------------------- holders & concentration

export async function checkHolders(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "TOKEN_HOLDER_COUNT_GENERAL";
  const params = { token: app.token, chain: app.chain };
  const { value, evidence } = await buy(ctx, "holders", [auto(intent, params)], (a) => num(a, ["holders_count", "holders", "holder_count", "count"]));
  const label = "Holder base & concentration";
  const top10 = contract?.top10Pct;
  const scanner = contract?.holderCount;
  if (value === undefined) {
    if (scanner === undefined) return finding("holders", label, "unknown", "Holder count could not be bought from Telegraph.", { top10Pct: top10 }, evidence);
  }
  const holders = value ?? scanner!;
  const min = app.mode === "listing" ? 1000 : 300;
  let status: Status = holders >= min ? "pass" : holders >= min / 4 ? "warn" : "fail";
  const parts: string[] = [];
  const cc = value === undefined ? "none" : crossCheck(value, scanner, 10);
  if (value === undefined) {
    parts.push(`${fmtInt(holders)} holders per the contract scan only (routed holder count unusable)`);
    if (status === "pass") status = "warn";
  } else if (cc === "disagree") {
    parts.push(`${fmtInt(value)} holders per ${minerOf(evidence)}, but the contract scan reports ${fmtInt(scanner!)}`);
    if (status === "pass") status = "warn";
    const ev = evidence.find((e) => e.usable);
    if (ev) await reportQuality(ctx, "holders", ev, params, `holder count ${value} differs by more than 10% from the contract scan (${scanner})`);
  } else {
    parts.push(`${fmtInt(value)} holders${cc === "agree" ? ` (matches the contract scan within 10%)` : ""}`);
  }
  if (top10 !== undefined) {
    parts.push(`top-10 wallets hold ${top10.toFixed(1)}%`);
    if (top10 > 70 && status !== "fail") status = "warn";
  }
  return finding("holders", label, status, parts.join(", ") + ".", { holders, scannerHolders: scanner, crossCheck: cc, top10Pct: top10 }, evidence);
}

// ---------------------------------------------------------------- supply

export async function checkSupply(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL";
  const params = { token: `${app.token} on ${CHAINS[app.chain].label}` };
  const { value, evidence } = await buy(ctx, "supply", [auto(intent, params)], (x) => num(x, ["total_supply", "totalSupply", "supply"]));
  const label = "Supply verification";
  const scanner = contract?.totalSupply;
  if (value === undefined) {
    return finding("supply", label, "unknown", `No usable total supply could be bought${scanner !== undefined ? ` (the contract scan alone reports ${fmtInt(scanner)})` : ""}.`, { scannerSupply: scanner }, evidence);
  }
  const cc = crossCheck(value, scanner, 1);
  if (cc === "disagree") {
    // The contract scan reads totalSupply() on-chain, so it is kept as the figure of record;
    // the routed answer is shown, marked down and reported back with its receipt.
    const ev = evidence.find((e) => e.usable);
    if (ev) await reportQuality(ctx, "supply", ev, params, `total supply ${value} differs by more than 1% from the on-chain contract scan (${scanner})`);
    return finding("supply", label, "warn",
      `The routed answer (${minerOf(evidence)}: ${fmtInt(value)}) does not match the on-chain total supply from the contract scan (${fmtInt(scanner!)}); using the on-chain figure and reporting the mismatch. If the token rebases, review manually.`,
      { supply: scanner, routedSupply: value, scannerSupply: scanner, crossCheck: cc }, evidence);
  }
  return finding("supply", label, "pass",
    `Total supply ${fmtInt(value)}${cc === "agree" ? ", matching the contract scan" : " (no second source to compare)"}.`,
    { supply: value, scannerSupply: scanner, crossCheck: cc }, evidence);
}

// ---------------------------------------------------------------- liquidity

export async function checkLiquidity(ctx: RunCtx, contract?: ContractFacts): Promise<Finding> {
  const { app } = ctx;
  const intent = "LIQUIDITY_DEPTH_VERIFY_GENERAL";
  const pool = contract?.bestPool?.pair;
  const attempts = pool
    ? [auto(intent, { pool, chain: app.chain })]
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
  const { value, evidence } = await buy(ctx, "wash", [auto(intent, { subject: `${app.token} on ${CHAINS[app.chain].label}` })], (a) => {
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
  // A "no match" must show what was screened: an answer that echoes no name, no lists and no
  // score cannot be told apart from a miner that ignored the question, so it is unusable.
  // (Observed live, 13 Nov 2026: a routed answer said matched:false for "Lazarus Group" with
  // name, lists and score all null.)
  const extractFor = (name: string) => (a: unknown) => {
    const matched = toBool(findKey(a, ["matched", "match", "on_list", "is_match"]));
    if (matched === undefined) return undefined;
    const echoed = str(a, ["name", "query", "screened_name"]);
    const lists = findKey(a, ["lists", "lists_checked", "sources"]);
    const score = num(a, ["match_score", "score"]);
    const showsWork = (echoed && echoed.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0])) || (Array.isArray(lists) && lists.length > 0) || score !== undefined;
    if (!matched && !showsWork) return undefined;
    return { matched, score, summary: str(a, ["summary"]) };
  };
  const results = await Promise.all(
    names.map(async (name) => {
      const r = await buy(ctx, "sanctions", [
        auto(intent, { name }),
        auto(intent, undefined, `Screen the name "${name}" against the OFAC SDN, UN, EU and UK sanctions lists. Return matched, the lists checked and the best match score.`),
      ], extractFor(name));
      return { name, miner: minerOf(r.evidence), value: r.value, evidence: r.evidence };
    }),
  );
  const evidence = results.flatMap((r) => r.evidence);
  const label = "Sanctions screening";
  const facts = { screened: names, results: results.map((r) => ({ name: r.name, matched: r.value?.matched, miner: r.value ? r.miner : undefined })) };

  const hits = results.filter((r) => r.value?.matched);
  if (hits.length) {
    const summary = (hits[0].value?.summary ?? "sanctions-list match").replace(/\.+$/, "");
    return finding("sanctions", label, "fail",
      `Name alert for ${hits.map((x) => `"${x.name}"`).join(", ")}: ${summary}. A name match needs identity review before any listing.`,
      facts, evidence, ["REVIEW_SANCTIONS_MATCH"]);
  }
  const unscreened = results.filter((r) => !r.value);
  if (unscreened.length === results.length) {
    return finding("sanctions", label, "unknown", "No usable sanctions screening could be bought: answers did not show which name or lists were checked. A human must screen these names.", facts, evidence, ["REVIEW_SANCTIONS_UNSCREENED"]);
  }
  const parts = [`${names.length - unscreened.length}/${names.length} names screened, no list match`];
  if (unscreened.length) parts.push(`${unscreened.map((u) => `"${u.name}"`).join(", ")} could not be screened`);
  return finding("sanctions", label, unscreened.length ? "warn" : "pass", `${parts.join("; ")}. A negative is not sanctions clearance.`, facts, evidence,
    unscreened.length ? ["REVIEW_SANCTIONS_UNSCREENED"] : []);
}

// ---------------------------------------------------------------- social authenticity

export async function checkSocial(ctx: RunCtx): Promise<Finding | undefined> {
  const handle = ctx.app.xHandle?.replace(/^@/, "").trim();
  if (!handle) return undefined;
  const intent = "SOCIAL_BOT_DETECTION_GENERAL";
  const attempts = [auto(intent, { account: `@${handle}` })];
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
