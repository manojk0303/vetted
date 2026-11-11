import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AskRequest, Simulator } from "../core/telegraph.js";

/**
 * Offline simulator for tests and for trying the UI without a funded wallet.
 * Answers come from recorded miner responses in /fixtures (real PEPE data, plus
 * one clearly synthetic risky token). Every memo produced this way is marked
 * `simulated: true`, carries no receipts and is never presented as a Telegraph purchase.
 */
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

export const SIM_RISKY_TOKEN = "0xbad0000000000000000000000000000000000bad";

export function fixtureSimulator(): Simulator {
  const pepe = load("goplus-pepe.json");
  const rug = load("goplus-synthetic-rug.json");
  const wash = load("wash-pepe.json");
  const holders = load("holders-pepe.json");
  const lazarus = load("sanctions-lazarus.json");

  return async (req: AskRequest) => {
    const blob = JSON.stringify(req).toLowerCase();
    const risky = blob.includes(SIM_RISKY_TOKEN) || blob.includes("0x2222222222222222222222222222222222222222");
    // Direct asks are labelled with the miner actually asked, so cross-miner logic can be exercised offline.
    const sim = (result: unknown, slug: string) => ({
      result,
      minerId: req.minerId ?? "sim",
      minerSlug: `${req.minerId ? `miner-${req.minerId}` : slug} (simulated)`,
    });
    switch (req.intent) {
      case "SMART_CONTRACT_AUDIT_GENERAL":
        return sim(risky ? rug : pepe, "goplus-security");
      case "TOKEN_HOLDER_COUNT_GENERAL":
        return sim(risky ? { holders_count: 212 } : { holders_count: holders.holders }, "chainwire-holder-count");
      case "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL":
        return sim({ total_supply: risky ? 1_000_000_000 : 420689899644011.34 }, "supply-oracle");
      case "LIQUIDITY_DEPTH_VERIFY_GENERAL":
        return sim({ liquidity_usd: risky ? 8100 : 15_900_000 }, "liquidity-oracle");
      case "WASH_TRADING_DETECTION_GENERAL":
        return sim(risky ? { ...wash, risk_label: "HIGH", round_trip_volume_share_percent: 64.2, risk_score: 0.81 } : wash, "verifywire-wash-trading");
      case "SANCTIONS_SCREENING_MATCH_GENERAL": {
        const name = String((req.payload as any)?.name ?? (req.params as any)?.name ?? "");
        return sim(/lazarus/i.test(name) ? lazarus : { name, matched: false, match_score: 0.12, summary: `${name}: no sanctions-list name match.` }, "zk-sanctions");
      }
      case "SOCIAL_BOT_DETECTION_GENERAL":
        return sim({ verdict: risky ? "likely_bot" : "likely_human", bot_score: risky ? 0.82 : 0.18 }, "bot-detector");
      case "URL_SAFE_GENERAL":
      case "URL_SCAN_VERDICT":
        return sim({ verdict: risky ? "Suspicious" : "Safe", detections: risky ? 3 : 0 }, "url-scanner");
      case "SSL_VERIFICATION_CERT":
        return sim({ certificate_valid: !risky }, "tls-check");
      default:
        throw new Error(`no fixture for ${req.intent}`);
    }
  };
}
