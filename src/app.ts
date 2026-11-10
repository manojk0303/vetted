import { loadConfig, type VettedConfig } from "./core/config.js";
import { openStore, type Store } from "./core/store.js";
import { TelegraphClient } from "./core/telegraph.js";
import { MemoStore } from "./vet/memo.js";
import { fixtureSimulator } from "./vet/simulator.js";

export interface AppContext {
  cfg: VettedConfig;
  store: Store;
  tg: TelegraphClient;
  memos: MemoStore;
}

/** Shared startup for every entry point (web, CLI, MCP, bot): config → storage → Telegraph client. */
export async function bootstrap(overrides: Partial<VettedConfig> = {}): Promise<AppContext> {
  const cfg = loadConfig(overrides);
  const store = await openStore(cfg);
  const tg = await new TelegraphClient(cfg, fixtureSimulator(), store).init();
  return { cfg, store, tg, memos: new MemoStore(store) };
}
