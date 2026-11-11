import type { AskRequest } from "../core/telegraph.js";

export const CHAINS = {
  ethereum: { id: 1, label: "Ethereum" },
  base: { id: 8453, label: "Base" },
  arbitrum: { id: 42161, label: "Arbitrum" },
  polygon: { id: 137, label: "Polygon" },
  optimism: { id: 10, label: "Optimism" },
  bsc: { id: 56, label: "BNB Chain" },
} as const;
export type Chain = keyof typeof CHAINS;

export type Mode = "listing" | "pretrade";

/** What an exchange listing team (or a trading agent) hands Vetted. */
export interface Application {
  chain: Chain;
  token: `0x${string}`;
  mode: Mode;
  projectName?: string;
  /** Legal entity behind the token, screened against sanctions lists. */
  issuer?: string;
  /** Named founders / key people, screened against sanctions lists (max 3). */
  people?: string[];
  xHandle?: string;
  website?: string;
  /** Intended trade size in USD (pretrade mode) for the slippage/size gate. */
  tradeUsd?: number;
}

export type Status = "pass" | "warn" | "fail" | "unknown";

export interface Evidence {
  intent?: string;
  minerId?: string;
  minerSlug?: string;
  ok: boolean;
  usable: boolean;
  costUsd: number;
  durationMs: number;
  signalHash?: string;
  receiptHash?: string;
  txHash?: string;
  simulated: boolean;
  /** True when this answer was bought earlier (by any user) and reused while still fresh: no new payment. */
  reused?: boolean;
  /** When a reused answer was originally bought. */
  boughtAt?: string;
  error?: string;
  /** Trimmed copy of the miner answer, kept in the memo for audit. */
  answer?: unknown;
}

export interface Finding {
  check: string;
  label: string;
  status: Status;
  summary: string;
  /** Normalised facts the verdict engine reads. */
  facts: Record<string, unknown>;
  /** Hard flags: REJECT_* forces reject, REVIEW_* forces manual review. */
  flags: string[];
  evidence: Evidence[];
}

/** One purchase attempt plan. Attempts run in order until one returns a usable answer. */
export interface Attempt {
  req: AskRequest;
  why: string;
}
