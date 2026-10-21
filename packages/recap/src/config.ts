/**
 * pi-recap settings. A tiny JSON file in the agent dir — deliberately NOT a
 * session entry, so configuration survives reloads and never touches context.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RecapModelRef {
  provider: string;
  id: string;
}

export interface RecapConfig {
  /** Explicit model choice. Null = automatic (cheapest fast chat model). */
  model: RecapModelRef | null;
  /** Recap automatically after every settled run. */
  auto: boolean;
  /** Spend tally for honesty: the recap calls bypass session accounting. */
  spendDay: string;
  spendUsd: number;
}

export const CONFIG_FILE = "recap.json";

export function defaultConfig(): RecapConfig {
  return { model: null, auto: true, spendDay: "", spendUsd: 0 };
}

export function configPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE);
}

export function loadConfig(agentDir: string): RecapConfig {
  const base = defaultConfig();
  // A new day resets the spend tally; a missing or corrupt file resets everything.
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!existsSync(configPath(agentDir))) return { ...base, spendDay: today };
    const raw = JSON.parse(readFileSync(configPath(agentDir), "utf8")) as Partial<RecapConfig>;
    const model =
      raw.model && typeof raw.model.provider === "string" && typeof raw.model.id === "string"
        ? { provider: raw.model.provider, id: raw.model.id }
        : null;
    const spendDay = typeof raw.spendDay === "string" ? raw.spendDay : "";
    const spendUsd = spendDay === today && typeof raw.spendUsd === "number" && raw.spendUsd >= 0 ? raw.spendUsd : 0;
    return { model, auto: raw.auto !== false, spendDay: spendDay === today ? spendDay : today, spendUsd };
  } catch {
    return { ...base, spendDay: today };
  }
}

export function saveConfig(agentDir: string, config: RecapConfig): void {
  try {
    mkdirSync(dirname(configPath(agentDir)), { recursive: true });
    writeFileSync(configPath(agentDir), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Config is a convenience; a read-only agent dir must never break recaps.
  }
}

/** Add one recap's cost to today's tally, returning the updated config. */
export function addSpend(config: RecapConfig, costUsd: number): RecapConfig {
  const today = new Date().toISOString().slice(0, 10);
  const base = config.spendDay === today ? config.spendUsd : 0;
  return { ...config, spendDay: today, spendUsd: base + Math.max(0, costUsd) };
}
