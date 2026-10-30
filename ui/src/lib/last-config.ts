import type { ConfigOption } from "../bindings";
import { readStored, recordOf, stringRecord, writeStored } from "./stored";

// UI-only memory of the config values the user picked per agent (model, effort, mode...), re-applied to its new sessions.
export type SavedConfig = Record<string, string>;

const KEY = "span.agent.lastConfig";

/** Agent id to its saved values. Entries in another shape (null, arrays, numbers) are dropped, never thrown on. */
const readAll = (): Record<string, SavedConfig> => readStored(KEY, recordOf(stringRecord), {});

export function readLastConfig(agentId: string): SavedConfig {
  return readAll()[agentId] ?? {};
}

export function writeLastConfig(agentId: string, configId: string, value: string) {
  const all = readAll();
  all[agentId] = { ...all[agentId], [configId]: value };
  writeStored(KEY, all);
}

/**
 * The [configId, value] pairs to apply to a new session: each saved value whose option and choice still exist and
 * differ from the current one. Options a Span permission mode manages are left out (`managed`, or by default the
 * mode option and Codex's collaboration mode).
 */
export function chooseRestores(options: ConfigOption[], saved: SavedConfig, managed?: readonly string[]): [string, string][] {
  const restores: [string, string][] = [];
  // The thread's Span permission mode sets these (ADR 0015) and is restored on its own, never through the raw option.
  const isManaged = (option: ConfigOption) => (managed ? managed.includes(option.id) : option.category === "mode" || option.id === "mode" || option.id === "collaboration_mode");
  for (const option of options) {
    if (isManaged(option)) continue;
    const value = saved[option.id];
    if (typeof value !== "string" || value === option.currentValue) continue;
    const choice = option.groups.flatMap((group) => group.choices).find((candidate) => candidate.value === value);
    if (!choice) continue;
    restores.push([option.id, value]);
  }
  return restores;
}
