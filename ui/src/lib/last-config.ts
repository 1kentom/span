import type { ConfigOption } from "../bindings";

// UI-only memory of the config values the user picked per agent (model, effort, mode...), re-applied to its new sessions.
export type SavedConfig = Record<string, string>;

const KEY = "span.agent.lastConfig";

function readAll(): Record<string, SavedConfig> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readLastConfig(agentId: string): SavedConfig {
  const found = readAll()[agentId];
  if (!found || typeof found !== "object") return {};
  return Object.fromEntries(Object.entries(found).filter(([, value]) => typeof value === "string"));
}

export function writeLastConfig(agentId: string, configId: string, value: string) {
  const all = readAll();
  const mine = all[agentId] && typeof all[agentId] === "object" ? all[agentId] : {};
  all[agentId] = { ...mine, [configId]: value };
  try { window.localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage can be unavailable */ }
}

/**
 * The [configId, value] pairs to apply to a new session: each saved value whose option and choice still exist and
 * differ from the current one.
 */
export function chooseRestores(options: ConfigOption[], saved: SavedConfig): [string, string][] {
  const restores: [string, string][] = [];
  for (const option of options) {
    const value = saved[option.id];
    if (typeof value !== "string" || value === option.currentValue) continue;
    const choice = option.groups.flatMap((group) => group.choices).find((candidate) => candidate.value === value);
    if (!choice) continue;
    restores.push([option.id, value]);
  }
  return restores;
}
