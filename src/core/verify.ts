import { keccak256, toBytes } from "viem";

/**
 * Recompute a Telegraph signal hash locally, without trusting the node's own
 * `verification.verified` flag. Rule (per Telegraph docs): keccak256 over the
 * signal `payload` as compact JSON with keys sorted recursively, wallet_address
 * lowercased, and `<`, `>`, `&` escaped as <, >, &.
 */
export function canonicalPayload(payload: unknown): string {
  const p = structuredClone(payload) as Record<string, unknown>;
  if (p && typeof p === "object" && typeof p.wallet_address === "string") {
    p.wallet_address = p.wallet_address.toLowerCase();
  }
  return JSON.stringify(sortKeys(p))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function signalHashOf(payload: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalPayload(payload)));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export interface SignalVerification {
  signalHash: string;
  recomputed: string;
  matches: boolean;
  nodeVerified?: boolean;
  minerSlug?: string;
  intent?: string;
  wallet?: string;
  txHash?: string;
  createdAt?: string;
  error?: string;
}

/** Fetch a signal from the node and independently verify its commitment. */
export async function verifySignal(nodeUrl: string, signalHash: string): Promise<SignalVerification> {
  try {
    const res = await fetch(`${nodeUrl}/engine/v1/signal/${signalHash}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { signalHash, recomputed: "", matches: false, error: `node returned ${res.status}` };
    const s = (await res.json()) as any;
    const recomputed = signalHashOf(s.payload);
    return {
      signalHash,
      recomputed,
      matches: recomputed.toLowerCase() === signalHash.toLowerCase(),
      nodeVerified: s.verification?.verified,
      minerSlug: s.signal?.miner_slug,
      intent: s.signal?.intent_id,
      wallet: s.signal?.wallet_address,
      txHash: s.signal?.tx_hash,
      createdAt: s.signal?.created_at,
    };
  } catch (e) {
    return { signalHash, recomputed: "", matches: false, error: (e as Error).message };
  }
}
