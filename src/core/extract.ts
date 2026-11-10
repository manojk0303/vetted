/**
 * Miner answers are Provider-native: the same fact can sit at different paths
 * (`holders`, `holders_count`, `result.0xabc.holder_count`...). These helpers
 * find a value by candidate key names anywhere in the tree, deterministically
 * (breadth-first, first match wins), and coerce common string encodings.
 */
export function findKey(obj: unknown, keys: string[], maxDepth = 6): unknown {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  let frontier: unknown[] = [obj];
  for (let d = 0; d <= maxDepth && frontier.length; d++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        next.push(...node);
        continue;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (want.has(k.toLowerCase()) && v !== null && v !== undefined && v !== "") return v;
      }
      next.push(...Object.values(node as Record<string, unknown>));
    }
    frontier = next;
  }
  return undefined;
}

export function toNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,_\s$%]/g, ""));
    return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "match", "matched", "safe", "valid"].includes(s)) return true;
    if (["0", "false", "no", "n", "clear", "no match", "not matched"].includes(s)) return false;
  }
  return undefined;
}

export const num = (obj: unknown, keys: string[]) => toNum(findKey(obj, keys));
export const bool = (obj: unknown, keys: string[]) => toBool(findKey(obj, keys));
export const str = (obj: unknown, keys: string[]) => {
  const v = findKey(obj, keys);
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
};

/** Tax fields come as fractions ("0.05") or percents ("5"). Normalise to percent. */
export function taxPct(v: unknown): number | undefined {
  const n = toNum(v);
  if (n === undefined) return undefined;
  return n <= 1 ? n * 100 : n;
}
