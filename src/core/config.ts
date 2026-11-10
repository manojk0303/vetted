import "dotenv/config";

export const SEPOLIA = {
  chainId: 11155111,
  network: "eip155:11155111" as const,
  usdc: "0xcc194e1a843B658526D0D5C431f670028582Ae17" as const,
  diamond: "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b" as const,
};

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

export interface VettedConfig {
  nodeUrl: string;
  rpcUrl: string;
  privateKey?: `0x${string}`;
  simulate: boolean;
  maxPerCallUsd: number;
  maxPerMemoUsd: number;
  maxPerDayUsd: number;
  dataDir: string;
  /** Postgres connection string. When set, memos and the ledger live in Postgres instead of data/. */
  databaseUrl?: string;
  port: number;
}

export function loadConfig(overrides: Partial<VettedConfig> = {}): VettedConfig {
  const pk = process.env.EVM_PRIVATE_KEY?.trim();
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }
  return {
    nodeUrl: (process.env.TELEGRAPH_NODE_URL || "https://devnode.telegraphprotocol.com").replace(/\/$/, ""),
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    privateKey: pk ? (pk as `0x${string}`) : undefined,
    simulate: process.env.VETTED_SIMULATE === "1",
    maxPerCallUsd: num("VETTED_MAX_PER_CALL_USD", 0.05),
    maxPerMemoUsd: num("VETTED_MAX_PER_MEMO_USD", 0.4),
    maxPerDayUsd: num("VETTED_MAX_PER_DAY_USD", 5),
    dataDir: process.env.VETTED_DATA_DIR || "data",
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    port: num("PORT", 8787),
    ...overrides,
  };
}
