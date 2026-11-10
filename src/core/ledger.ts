import type { Store } from "./store.js";

/** One line per paid (or attempted) Telegraph purchase. Append-only accounting record. */
export interface LedgerEntry {
  at: string;
  runId?: string;
  check?: string;
  intent?: string;
  minerId?: string;
  minerSlug?: string;
  status: "paid" | "failed_after_payment" | "rejected_before_payment" | "budget_blocked" | "simulated";
  costUsd: number;
  signalHash?: string;
  receiptHash?: string;
  txHash?: string;
  payer?: string;
  durationMs?: number;
  error?: string;
}

export class Ledger {
  constructor(private readonly store: Store) {}

  /** Never throws: a storage hiccup must not turn a successful purchase into a failure. */
  async append(e: LedgerEntry): Promise<void> {
    try {
      await this.store.appendLedger(e);
    } catch (err) {
      console.error(`ledger write failed (${(err as Error).message}):`, JSON.stringify(e));
    }
  }

  read(limit = 500): Promise<LedgerEntry[]> {
    return this.store.readLedger(limit);
  }

  /** Real spend in the trailing 24h, used by the daily cap. Simulated rows never count. */
  spentLast24hUsd(): Promise<number> {
    return this.store.spentSinceUsd(Date.now() - 24 * 3600 * 1000);
  }
}
