import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Budget, BudgetExceededError } from "./budget.js";
import { SEPOLIA, type VettedConfig } from "./config.js";
import { Ledger, type LedgerEntry } from "./ledger.js";
import { FileStore, type Store } from "./store.js";

export interface AskRequest {
  intent?: string;
  params?: Record<string, unknown>;
  query?: string;
  /** Direct ask to one miner. */
  minerId?: string;
  /** Native passthrough for a direct ask. */
  method?: "GET" | "POST";
  endpoint?: string;
  payload?: Record<string, unknown>;
}

export interface AskContext {
  budget: Budget;
  runId?: string;
  check?: string;
  timeoutMs?: number;
}

export interface Receipt {
  signalHash?: string;
  receiptHash?: string;
  txHash?: string;
  payer?: string;
  payTo?: string;
  amountAtomic?: string;
  raw?: unknown;
}

export interface AskResult {
  ok: boolean;
  status: number;
  simulated: boolean;
  intent?: string;
  minerId?: string;
  minerSlug?: string;
  result: unknown;
  resultShape?: "intent" | "raw";
  fieldStatus?: unknown;
  costUsd: number;
  durationMs: number;
  receipt: Receipt;
  error?: string;
  errorCode?: "budget" | "invalid_params" | "rate_limited" | "no_miner" | "not_found" | "warning" | "miner_failed" | "network" | "payment";
}

export interface MinerInfo {
  id: string;
  slug: string;
  name: string;
  rank?: number;
  score?: number;
  served: number;
  minPriceAtomic?: number;
  intents: string[];
  endpoints: { method: string; path: string; description: string }[];
}

export interface IntentSchema {
  intent_id: string;
  class?: string;
  miner_count?: number;
  request?: { params: { name: string; type: string; required?: boolean; allowed?: string[] }[] } | null;
  response?: { fields: { name: string; type: string }[] } | null;
}

/** Simulation hook so the full app can be exercised without a funded wallet. Output is always labelled. */
export type Simulator = (req: AskRequest) => Promise<{ result: unknown; minerId: string; minerSlug: string }>;

const USD_PER_ATOMIC = 1e-6;

export class TelegraphClient {
  readonly account?: PrivateKeyAccount;
  private scheme?: ExactEvmScheme;
  private minerCache = new Map<string, { at: number; miners: MinerInfo[] }>();
  private schemaCache = new Map<string, IntentSchema>();
  readonly ledger: Ledger;
  readonly store: Store;
  /** Daily spend cap. Starts at the full limit; init() subtracts what the ledger says was spent in the last 24h. */
  daily: Budget;

  constructor(
    readonly cfg: VettedConfig,
    private readonly simulator?: Simulator,
    store?: Store,
  ) {
    if (cfg.privateKey) {
      this.account = privateKeyToAccount(cfg.privateKey);
      this.scheme = new ExactEvmScheme(this.account);
    }
    this.store = store ?? new FileStore(cfg.dataDir);
    this.ledger = new Ledger(this.store);
    this.daily = new Budget(cfg.maxPerDayUsd, "daily");
  }

  /** Load the trailing-24h spend from the ledger so the daily cap survives restarts. Call once before use. */
  async init(): Promise<this> {
    await this.store.init();
    const spentToday = await this.ledger.spentLast24hUsd();
    this.daily = new Budget(Math.max(0, this.cfg.maxPerDayUsd - spentToday), "daily");
    return this;
  }

  get simulated(): boolean {
    return this.cfg.simulate || !this.account;
  }

  /** Budget for one diligence run, nested under the daily cap. */
  runBudget(limitUsd = this.cfg.maxPerMemoUsd): Budget {
    return this.daily.child(Math.min(limitUsd, this.daily.remainingUsd), "memo");
  }

  // ---------- free discovery ----------

  async intentSchema(intent: string): Promise<IntentSchema> {
    const hit = this.schemaCache.get(intent);
    if (hit) return hit;
    const s = (await this.getJson(`/engine/v1/intents/${encodeURIComponent(intent)}`)) as IntentSchema;
    this.schemaCache.set(intent, s);
    return s;
  }

  /** Active miners for an intent, best protocol rank first. Cached for 5 minutes. */
  async rankedMiners(intent: string): Promise<MinerInfo[]> {
    const hit = this.minerCache.get(intent);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.miners;
    const raw = (await this.getJson(`/api/miners?intent=${encodeURIComponent(intent)}&limit=200`)) as any[];
    const miners: MinerInfo[] = raw
      .filter((m) => (m.activation_status ?? "active") === "active")
      .map((m) => {
        const s = (m.scores || []).find((x: any) => x.intent_id === intent);
        return {
          id: String(m.id),
          slug: m.slug,
          name: m.name,
          rank: s?.rank,
          score: s?.score,
          served: m.total_requests_served || 0,
          minPriceAtomic: m.min_price_usdc,
          intents: m.supported_intents || [],
          endpoints: (m.endpoints || []).map((e: any) => ({ method: e.method, path: e.path, description: e.description })),
        };
      })
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.score ?? 0) - (a.score ?? 0) || b.served - a.served);
    this.minerCache.set(intent, { at: Date.now(), miners });
    return miners;
  }

  async usdcBalance(): Promise<number | undefined> {
    if (!this.account) return undefined;
    const data = "0x70a08231" + this.account.address.slice(2).toLowerCase().padStart(64, "0");
    const r = await fetch(this.cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: SEPOLIA.usdc, data }, "latest"] }),
    });
    const j = (await r.json()) as any;
    return j.result ? Number(BigInt(j.result)) / 1e6 : undefined;
  }

  // ---------- paid ask ----------

  async ask(req: AskRequest, ctx: AskContext): Promise<AskResult> {
    const started = Date.now();
    const base = { intent: req.intent, minerId: req.minerId };
    const ledgerBase: Partial<LedgerEntry> = { runId: ctx.runId, check: ctx.check, intent: req.intent, minerId: req.minerId };

    let reservation;
    try {
      reservation = ctx.budget.reserve(this.cfg.maxPerCallUsd);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        await this.ledger.append({ ...ledgerBase, at: new Date().toISOString(), status: "budget_blocked", costUsd: 0, error: e.message });
        return this.fail(base, 0, started, e.message, "budget");
      }
      throw e;
    }

    if (this.simulated) {
      try {
        const sim = await this.simulate(req);
        const cost = 0.01;
        ctx.budget.settle(reservation, 0); // simulated spend never counts against real budgets
        await this.ledger.append({ ...ledgerBase, at: new Date().toISOString(), status: "simulated", costUsd: 0, minerId: sim.minerId, minerSlug: sim.minerSlug });
        return {
          ok: true, status: 200, simulated: true, ...base, minerId: sim.minerId, minerSlug: sim.minerSlug,
          result: sim.result, resultShape: "intent", costUsd: cost, durationMs: Date.now() - started, receipt: {},
        };
      } catch (e) {
        ctx.budget.release(reservation);
        return this.fail(base, 0, started, (e as Error).message, "miner_failed", true);
      }
    }

    const capAtomic = Math.floor(this.cfg.maxPerCallUsd / USD_PER_ATOMIC);
    let paidAtomic: string | undefined;
    let payTo: string | undefined;
    const client = new x402Client()
      .register(SEPOLIA.network, this.scheme!)
      .setSpendControls({ allowedAssets: [{ network: SEPOLIA.network, asset: SEPOLIA.usdc, maxAmountPerPayment: String(capAtomic) }] })
      // Only the per-request "exact" scheme; never sign escrow messages implicitly.
      .registerPolicy((_v, reqs) => reqs.filter((r) => r.scheme === "exact" && BigInt(r.amount) <= BigInt(capAtomic)))
      .onAfterPaymentCreation(async (c) => {
        paidAtomic = c.selectedRequirements.amount;
        payTo = c.selectedRequirements.payTo;
      });
    const payFetch = wrapFetchWithPayment(fetch, client);

    const path = req.minerId ? `/engine/v1/ask/${encodeURIComponent(req.minerId)}` : `/engine/v1/ask`;
    const body: Record<string, unknown> = {};
    if (req.intent) body.intent = req.intent;
    if (req.params) body.params = req.params;
    if (req.query) body.query = req.query;
    if (req.method) body.method = req.method;
    if (req.endpoint) body.endpoint = req.endpoint;
    if (req.payload) body.payload = req.payload;

    let res: Response;
    try {
      res = await payFetch(`${this.cfg.nodeUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ctx.timeoutMs ?? 75_000),
      });
    } catch (e) {
      const msg = (e as Error).message;
      ctx.budget.release(reservation);
      const code = /payment|requirement|spend/i.test(msg) ? "payment" : "network";
      await this.ledger.append({ ...ledgerBase, at: new Date().toISOString(), status: paidAtomic ? "failed_after_payment" : "rejected_before_payment", costUsd: 0, error: msg });
      return this.fail(base, 0, started, msg, code);
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    const receipt = this.readReceipt(res, json, paidAtomic, payTo);
    const paidUsd = paidAtomic ? Number(paidAtomic) * USD_PER_ATOMIC : 0;

    if (!res.ok) {
      // Pre-payment rejections are free. If payment settled and the miner failed, Telegraph credits escrow.
      ctx.budget.release(reservation);
      const code = res.status === 400 ? "invalid_params" : res.status === 429 ? "rate_limited" : res.status === 503 ? "no_miner"
        : res.status === 404 ? "not_found" : res.status === 422 ? "warning" : paidAtomic ? "miner_failed" : "payment";
      const msg = json?.message || json?.error || `HTTP ${res.status}`;
      await this.ledger.append({ ...ledgerBase, at: new Date().toISOString(), status: paidAtomic ? "failed_after_payment" : "rejected_before_payment", costUsd: 0, signalHash: receipt.signalHash, error: msg });
      return { ...this.fail(base, 0, started, msg, code), status: res.status, receipt };
    }

    const cost = typeof json.cost_usd === "number" ? json.cost_usd : paidUsd;
    ctx.budget.settle(reservation, cost);
    const out: AskResult = {
      ok: true,
      status: res.status,
      simulated: false,
      intent: json.intent ?? req.intent,
      minerId: json.miner_id != null ? String(json.miner_id) : req.minerId,
      minerSlug: json.miner_slug ?? json.routing?.miner_slug,
      result: json.result ?? json,
      resultShape: json.result_shape,
      fieldStatus: json.field_status,
      costUsd: cost,
      durationMs: Date.now() - started,
      receipt,
    };
    if (!out.minerSlug && out.minerId && out.intent) {
      // The Engine response carries the numeric miner_id only; resolve its slug from (cached) discovery.
      try {
        out.minerSlug = (await this.rankedMiners(out.intent)).find((m) => m.id === out.minerId)?.slug;
      } catch { /* discovery hiccup: leave the slug unset */ }
    }
    await this.ledger.append({
      ...ledgerBase, at: new Date().toISOString(), status: "paid", costUsd: cost, intent: out.intent, minerId: out.minerId,
      minerSlug: out.minerSlug, signalHash: receipt.signalHash, receiptHash: receipt.receiptHash, txHash: receipt.txHash,
      payer: this.account?.address, durationMs: out.durationMs,
    });
    return out;
  }

  private readReceipt(res: Response, json: any, paidAtomic?: string, payTo?: string): Receipt {
    const r: Receipt = { signalHash: json?.signal_hash, payer: this.account?.address, payTo, amountAtomic: paidAtomic };
    const tg = res.headers.get("x-telegraph-receipt");
    if (tg) {
      try {
        const d = JSON.parse(Buffer.from(tg, "base64").toString("utf8"));
        r.raw = d;
        r.receiptHash = d.receipt_hash ?? d.receiptHash;
        r.txHash = d.tx_hash ?? d.txHash ?? r.txHash;
        r.signalHash = r.signalHash ?? d.signal_hash;
      } catch { /* ignore malformed receipt header */ }
    }
    const pr = res.headers.get("payment-response");
    if (pr) {
      try {
        const d = decodePaymentResponseHeader(pr) as any;
        r.txHash = r.txHash ?? d.transaction;
        r.payer = d.payer ?? r.payer;
      } catch { /* ignore */ }
    }
    return r;
  }

  private async simulate(req: AskRequest) {
    if (!this.simulator) throw new Error("no simulator configured");
    return this.simulator(req);
  }

  private fail(base: { intent?: string; minerId?: string }, cost: number, started: number, error: string, code: AskResult["errorCode"], simulated = false): AskResult {
    return { ok: false, status: 0, simulated, ...base, result: null, costUsd: cost, durationMs: Date.now() - started, receipt: {}, error, errorCode: code };
  }

  private async getJson(path: string): Promise<unknown> {
    const r = await fetch(`${this.cfg.nodeUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
    return r.json();
  }
}
