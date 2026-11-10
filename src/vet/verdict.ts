import type { Finding, Mode } from "./types.js";

export type ListingVerdict = "LIST" | "REVIEW" | "REJECT";
export type TradeVerdict = "ALLOW" | "CAUTION" | "BLOCK";

/** Points deducted per status, weighted by how much the check matters for the decision. */
const WEIGHTS: Record<string, number> = {
  contract: 30,
  liquidity: 20,
  holders: 12,
  wash: 12,
  supply: 8,
  sanctions: 10,
  social: 4,
  website: 4,
};
const PENALTY = { pass: 0, warn: 0.5, fail: 1, unknown: 0.6 } as const;

export interface Verdict {
  decision: ListingVerdict | TradeVerdict;
  score: number;
  flags: string[];
  reasons: string[];
}

export function decide(mode: Mode, findings: Finding[]): Verdict {
  const total = findings.reduce((s, f) => s + (WEIGHTS[f.check] ?? 5), 0) || 1;
  const lost = findings.reduce((s, f) => s + (WEIGHTS[f.check] ?? 5) * PENALTY[f.status], 0);
  const score = Math.round(100 * (1 - lost / total));
  const flags = [...new Set(findings.flatMap((f) => f.flags))];
  const reject = flags.filter((f) => f.startsWith("REJECT_"));
  const review = flags.filter((f) => f.startsWith("REVIEW_"));
  const reasons: string[] = [];

  let level: 0 | 1 | 2; // 0 = go, 1 = review/caution, 2 = reject/block
  if (reject.length) {
    level = 2;
    reasons.push(`Hard stop: ${reject.map(pretty).join(", ")}.`);
  } else if (score < 45) {
    level = 2;
    reasons.push(`Risk score ${score}/100 is below the floor of 45.`);
  } else if (review.length) {
    level = 1;
    reasons.push(`Needs a human decision: ${review.map(pretty).join(", ")}.`);
  } else if (score < 75) {
    level = 1;
    reasons.push(`Risk score ${score}/100 is below the auto-approve bar of 75.`);
  } else {
    level = 0;
    reasons.push(`Risk score ${score}/100 with no blocking flags.`);
  }
  const fails = findings.filter((f) => f.status === "fail").map((f) => f.label);
  if (fails.length) reasons.push(`Failed: ${fails.join(", ")}.`);
  const unknown = findings.filter((f) => f.status === "unknown").map((f) => f.label);
  if (unknown.length) reasons.push(`Not verifiable right now: ${unknown.join(", ")}.`);

  const decision = mode === "listing" ? (["LIST", "REVIEW", "REJECT"] as const)[level] : (["ALLOW", "CAUTION", "BLOCK"] as const)[level];
  return { decision, score, flags, reasons };
}

function pretty(flag: string): string {
  return flag.replace(/^(REJECT|REVIEW)_/, "").toLowerCase().replace(/_/g, " ");
}
