import { keccak256, recoverMessageAddress, toBytes } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { canonicalPayload, verifySignal, type SignalVerification } from "../core/verify.js";
import type { Application, Finding } from "./types.js";
import type { Verdict } from "./verdict.js";
import type { MemoSummary, Store } from "../core/store.js";

export const MEMO_VERSION = "vetted.memo/1";

export interface Memo {
  version: typeof MEMO_VERSION;
  id: string;
  createdAt: string;
  network: string;
  simulated: boolean;
  application: Application;
  token: { name?: string; symbol?: string };
  verdict: Verdict;
  findings: Finding[];
  cost: {
    totalUsd: number;
    /** New paid purchases made for this memo. */
    purchases: number;
    /** Answers reused from earlier purchases (no new payment; original receipts still verify). Absent on older memos. */
    reused?: number;
    usable: number;
    unusable: number;
    failed: number;
    budgetUsd: number;
  };
  durationMs: number;
  payer?: string;
  /** keccak256 of the canonical memo body (everything except `digest`, `signer`, `signature`). */
  digest?: string;
  signer?: string;
  signature?: string;
}

function body(m: Memo): Omit<Memo, "digest" | "signer" | "signature"> {
  const { digest: _d, signer: _s, signature: _g, ...rest } = m;
  return rest;
}

export function memoDigest(m: Memo): `0x${string}` {
  return keccak256(toBytes(canonicalPayload(body(m))));
}

const signedMessage = (digest: string) => `${MEMO_VERSION}:${digest}`;

export async function signMemo(m: Memo, account?: PrivateKeyAccount): Promise<Memo> {
  const digest = memoDigest(m);
  if (!account) return { ...m, digest };
  const signature = await account.signMessage({ message: signedMessage(digest) });
  return { ...m, digest, signer: account.address, signature };
}

export interface MemoVerification {
  digestMatches: boolean;
  signatureValid: boolean;
  recoveredSigner?: string;
  signals: SignalVerification[];
  allSignalsVerified: boolean;
  simulated: boolean;
}

/** Anyone can run this: recompute the memo digest, recover its signer, and re-verify every receipt against the node. */
export async function verifyMemo(m: Memo, nodeUrl: string): Promise<MemoVerification> {
  const digest = memoDigest(m);
  const digestMatches = digest === m.digest;
  let recoveredSigner: string | undefined;
  let signatureValid = false;
  if (m.signature && m.digest) {
    try {
      recoveredSigner = await recoverMessageAddress({ message: signedMessage(m.digest), signature: m.signature as `0x${string}` });
      signatureValid = recoveredSigner.toLowerCase() === m.signer?.toLowerCase();
    } catch { /* invalid signature */ }
  }
  const hashes = [...new Set(m.findings.flatMap((f) => f.evidence.map((e) => e.signalHash)).filter((h): h is string => !!h))];
  const signals = await Promise.all(hashes.map((h) => verifySignal(nodeUrl, h)));
  return {
    digestMatches,
    signatureValid,
    recoveredSigner,
    signals,
    allSignalsVerified: signals.length > 0 && signals.every((s) => s.matches),
    simulated: m.simulated,
  };
}

/** Signed memos, persisted through the shared Store (files locally, Postgres when DATABASE_URL is set). */
export class MemoStore {
  constructor(private readonly store: Store) {}
  save(m: Memo): Promise<void> {
    return this.store.saveMemo(m);
  }
  get(id: string): Promise<Memo | undefined> {
    return this.store.getMemo(id);
  }
  list(limit = 50): Promise<MemoSummary[]> {
    return this.store.listMemos(limit);
  }
}
