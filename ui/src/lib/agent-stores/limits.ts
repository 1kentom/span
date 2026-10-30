import { createSignal, onCleanup } from "solid-js";
import { setAgentLimit, type AgentErrorInfo } from "../agent-errors";
import { sharedStore } from "./shared";

/**
 * Usage limits (app-wide, ADR 0011 phase 2): models that hit a limit, keyed by agent id and model value, with the
 * time the limit lifts (0 when unknown), and the app's limit signal. The picker marks them so the user is not
 * surprised twice. Cleared on the next successful turn or at the reset time.
 */
export function createAgentLimits() {
  const [limitedModels, setLimitedModels] = createSignal<Record<string, number>>({});
  const limitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of limitTimers.values()) clearTimeout(timer);
  });
  function clearLimited(key: string) {
    clearTimeout(limitTimers.get(key));
    limitTimers.delete(key);
    setLimitedModels((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }
  /** Marks `model` of `agent` as limited until `resetAt` (or the next successful turn). */
  function markLimited(info: AgentErrorInfo, agent: string, model: string | undefined) {
    setAgentLimit({ kind: info.kind, provider: info.provider, resetAt: info.resetAt, freeTier: info.freeTier, agentId: agent, model });
    if (info.kind !== "quota" || !model) return;
    const key = `${agent}\n${model}`;
    clearTimeout(limitTimers.get(key));
    setLimitedModels((previous) => ({ ...previous, [key]: info.resetAt ?? 0 }));
    const wait = info.resetAt !== undefined ? info.resetAt - Date.now() : undefined;
    // Timers beyond a day are not kept: the next successful turn clears the mark.
    if (wait !== undefined && wait < 86_400_000) limitTimers.set(key, setTimeout(() => clearLimited(key), Math.max(0, wait)));
  }
  /** A turn completed on `model` of `agent`: that model works again. */
  function clearAfterSuccess(agent: string, model: string | undefined) {
    if (model) clearLimited(`${agent}\n${model}`);
    setAgentLimit(undefined);
  }
  /** Model values of `agent` marked "Limit reached". */
  function limitedValues(agent: string): ReadonlySet<string> {
    const prefix = `${agent}\n`;
    return new Set(Object.keys(limitedModels()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
  }
  return { limitedModels, markLimited, clearAfterSuccess, limitedValues };
}

export type AgentLimits = ReturnType<typeof createAgentLimits>;

/** The app's one record of limited models. */
export const agentLimits = sharedStore(createAgentLimits);
