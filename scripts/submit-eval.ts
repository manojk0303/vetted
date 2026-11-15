/**
 * Submit evaluation material (JSONL) to the Telegraph eval pool, signed by the wallet in .env.
 * Follows anjoman.ai/docs/scoring/contribute-evaluation-data (EIP-191 over a five-line message).
 *
 *   npx tsx scripts/submit-eval.ts <INTENT_ID> <file.jsonl>           # dry run: validates and prints what would be sent
 *   npx tsx scripts/submit-eval.ts <INTENT_ID> <file.jsonl> --send    # actually submits
 *   npx tsx scripts/submit-eval.ts <INTENT_ID> --status               # pool status for the intent (free)
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const NODE = process.env.TELEGRAPH_NODE_URL ?? "https://devnode.telegraphprotocol.com";
const CHAIN_ID = 11155111;
const [intent, file] = process.argv.slice(2);
if (!intent) throw new Error("usage: submit-eval.ts <INTENT_ID> <file.jsonl> [--send] | <INTENT_ID> --status");

if (process.argv.includes("--status")) {
  console.log(JSON.stringify(await (await fetch(`${NODE}/api/evalpool/status?intent_id=${intent}`)).json(), null, 2));
  process.exit(0);
}

const key = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("EVM_PRIVATE_KEY missing");
const account = privateKeyToAccount(key);
const body = fs.readFileSync(file);

// Validate rows locally against the documented limits before signing anything.
const lines = body.toString("utf8").split("\n").filter(Boolean);
for (const [i, l] of lines.entries()) {
  const r = JSON.parse(l);
  const len = (s: unknown) => (typeof s === "string" ? s.length : -1);
  if (len(r.prompt) < 16 || len(r.prompt) > 16000) throw new Error(`row ${i}: prompt length`);
  if ((r.label_kind ?? "preference_pair") === "preference_pair") {
    if (len(r.chosen) < 8 || len(r.rejected) < 8 || r.chosen === r.rejected) throw new Error(`row ${i}: chosen/rejected`);
  }
  if (r.intent_id && r.intent_id !== intent) throw new Error(`row ${i}: intent_id mismatch`);
  if (Buffer.byteLength(l) > 64 * 1024) throw new Error(`row ${i}: over 64 KiB`);
}

const nonce = randomBytes(16).toString("hex");
const message = ["Telegraph eval-pool submission v1", `intent_id: ${intent}`, `body_sha256: ${createHash("sha256").update(body).digest("hex")}`, `nonce: ${nonce}`, `chain_id: ${CHAIN_ID}`].join("\n");
const signature = await account.signMessage({ message });
const url = `${NODE}/api/evalpool/submissions?intent_id=${encodeURIComponent(intent)}&submitter=${account.address}`;

console.log(`${lines.length} rows · ${body.length} bytes · submitter ${account.address}`);
if (!process.argv.includes("--send")) {
  console.log("dry run OK. Add --send to submit.");
  process.exit(0);
}
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/x-ndjson", "x-evalpool-signature": signature, "x-evalpool-nonce": nonce },
  body,
});
console.log(res.status, await res.text());
