#!/usr/bin/env node
/**
 * Vetted MCP server (stdio). Gives any MCP agent (Claude Code, Cursor, OpenClaw...)
 * budget-guarded access to Telegraph plus the full Vetted diligence desk.
 *
 * What it adds over a raw Telegraph client: hard per-call / per-session / per-day
 * spend caps enforced before signing, an append-only receipt ledger, independent
 * receipt verification, and routed, receipted token diligence.
 *
 *   claude mcp add vetted -- npx tsx /path/to/vetted/src/mcp/index.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bootstrap } from "../app.js";
import { verifySignal } from "../core/verify.js";
import { validateApplication, vet } from "../vet/engine.js";
import { verifyMemo, type Memo } from "../vet/memo.js";
import { CHAINS } from "../vet/types.js";

const { cfg, tg, memos } = await bootstrap();
// One budget for the whole MCP session, nested under the daily cap.
const session = tg.daily.child(Number(process.env.VETTED_MAX_PER_SESSION_USD || 1), "mcp-session");

const server = new McpServer({ name: "vetted", version: "0.1.0" });
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

function memoBrief(m: Memo) {
  return {
    decision: m.verdict.decision,
    score: m.verdict.score,
    reasons: m.verdict.reasons,
    token: m.token,
    findings: m.findings.map((f) => ({ check: f.label, status: f.status, summary: f.summary, receipts: f.evidence.map((e) => e.signalHash).filter(Boolean) })),
    cost: m.cost,
    memoId: m.id,
    signer: m.signer,
    digest: m.digest,
    simulated: m.simulated,
  };
}

server.registerTool(
  "vet_token",
  {
    title: "Token diligence memo",
    description:
      "Run Vetted diligence on an ERC-20 token. Buys contract-security, holder, supply, liquidity, wash-trading and optional sanctions/social/website checks through Telegraph routing (one answer per question) and returns a signed verdict. mode=listing gives LIST/REVIEW/REJECT for an exchange listing; mode=pretrade gives ALLOW/CAUTION/BLOCK plus a max trade size before an agent swaps. Costs roughly $0.05-$0.10 of test USDC on a first check, near zero on repeats.",
    inputSchema: {
      token: z.string().describe("0x-prefixed token contract address"),
      chain: z.enum(Object.keys(CHAINS) as [string, ...string[]]).default("ethereum"),
      mode: z.enum(["listing", "pretrade"]).default("pretrade"),
      tradeUsd: z.number().positive().optional().describe("pretrade: intended trade size in USD"),
      issuer: z.string().optional().describe("listing: legal entity to sanctions-screen"),
      people: z.array(z.string()).max(3).optional().describe("listing: key people to sanctions-screen"),
      xHandle: z.string().optional(),
      website: z.string().optional(),
      fresh: z.boolean().optional().describe("buy every answer fresh instead of reusing answers bought within their freshness window"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => {
    const app = validateApplication(args);
    const memo = await vet(tg, app, undefined, Math.min(cfg.maxPerMemoUsd, session.remainingUsd), { fresh: args.fresh });
    await memos.save(memo);
    return text(memoBrief(memo));
  },
);

server.registerTool(
  "telegraph_ask",
  {
    title: "Budget-guarded Telegraph request",
    description:
      "Buy one answer from the Telegraph intelligence market. Use intent+params for a typed, validated request (check the schema with telegraph_intent first), or query for plain language. Optionally target minerId. Spend is capped per call, per session and per day before anything is signed, and every purchase is written to the receipt ledger.",
    inputSchema: {
      intent: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      query: z.string().optional(),
      minerId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => {
    if (!args.intent && !args.query) return text({ error: "provide intent (+params) or query" });
    const r = await tg.ask(args, { budget: session, check: "mcp" });
    return text({ ...r, sessionRemainingUsd: session.remainingUsd });
  },
);

server.registerTool(
  "telegraph_intent",
  {
    title: "Intent schema and ranked miners",
    description: "Free. Returns an intent's request/response schema and its active miners ordered by protocol rank.",
    inputSchema: { intent: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ intent }) => {
    const [schema, miners] = await Promise.all([tg.intentSchema(intent), tg.rankedMiners(intent)]);
    const { miners: _drop, ...rest } = schema as any;
    return text({ ...rest, ranked: miners.slice(0, 10).map(({ id, slug, rank, score, served }) => ({ id, slug, rank, score, served })) });
  },
);

server.registerTool(
  "verify_receipt",
  {
    title: "Verify a Telegraph receipt",
    description: "Free. Re-derives a signal hash locally (keccak256 over the canonical payload) instead of trusting the node's own flag. Accepts a signal hash, or a Vetted memo id to verify the memo signature and every receipt in it.",
    inputSchema: { signalHash: z.string().optional(), memoId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ signalHash, memoId }) => {
    if (memoId) {
      const m = await memos.get(memoId);
      return text(m ? await verifyMemo(m, cfg.nodeUrl) : { error: "memo not found" });
    }
    if (signalHash) return text(await verifySignal(cfg.nodeUrl, signalHash));
    return text({ error: "provide signalHash or memoId" });
  },
);

server.registerTool(
  "spend_report",
  {
    title: "Spend and receipt ledger",
    description: "Free. Session and daily budget state plus the most recent purchases from the receipt ledger.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) =>
    text({
      simulated: tg.simulated,
      payer: tg.account?.address,
      session: { limitUsd: session.limitUsd, spentUsd: session.spentUsd, remainingUsd: session.remainingUsd },
      dailyRemainingUsd: tg.daily.remainingUsd,
      recent: (await tg.ledger.read(limit)).reverse(),
    }),
);

await server.connect(new StdioServerTransport());
