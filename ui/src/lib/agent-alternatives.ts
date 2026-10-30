/**
 * Which other agents can take a refused turn right now. Ranked from the installed agents and the health check
 * (ADR 0010), which only reports agents that are running: a Live or Slow result means the agent is started and
 * signed in. Nothing here guesses health from anything else.
 */
import { agentKey, findHealth, type AgentHealth } from "./agent-health";
import { friendlyAgentName } from "./live-agents";

export type AgentAlternative = {
  id: string;
  name: string;
  /** live and slow: running and answered the last check. idle: installed, not started or not checked. */
  readiness: "live" | "slow" | "idle" | "signedOut" | "unreachable";
  /** Said beside the agent when it may not take the turn: never offered silently. */
  note?: string;
};

const ORDER: Record<AgentAlternative["readiness"], number> = { live: 0, slow: 1, idle: 2, signedOut: 3, unreachable: 4 };
const NOTES: Partial<Record<AgentAlternative["readiness"], string>> = { signedOut: "Signed out", unreachable: "Not responding" };

/**
 * Installed agents other than the one that failed, best first: Live, then Slow, then installed but not running,
 * then Signed out and Unreachable with a note saying so. Ties keep the installed order (most recently used first
 * when the caller passes it that way).
 */
export function rankAlternatives(agents: readonly { id: string; name: string }[], health: readonly AgentHealth[], failed: { id?: string; name?: string }): AgentAlternative[] {
  const failedKeys = [failed.id, failed.name].filter((value): value is string => Boolean(value)).map(agentKey);
  return agents
    .filter((agent) => !failedKeys.includes(agentKey(agent.id)) && !failedKeys.includes(agentKey(agent.name)))
    .map((agent, index) => {
      const state = findHealth(health, agent.id, agent.name)?.state;
      const readiness: AgentAlternative["readiness"] = state ?? "idle";
      const note = NOTES[readiness];
      return { alternative: { id: agent.id, name: agent.name, readiness, ...(note ? { note } : {}) }, index };
    })
    .sort((left, right) => ORDER[left.alternative.readiness] - ORDER[right.alternative.readiness] || left.index - right.index)
    .map((entry) => entry.alternative);
}

/** Free models of the current model list other than `current`, for "free models remain" wording. */
export function otherFreeModels(choices: readonly { value: string; name: string }[], current: string | undefined, isFree: (choice: { value: string; name: string }) => boolean, limited: ReadonlySet<string> = new Set()): { value: string; name: string }[] {
  return choices.filter((choice) => choice.value !== current && !limited.has(choice.value) && isFree(choice));
}

/** Trailing words that only say what kind of program it is ("Claude Agent", "Gemini CLI", "Qwen Code"). */
const KIND_WORDS = new Set(["agent", "acp", "cli", "code"]);

/**
 * The short name an agent goes by in a sentence: "Claude", "Codex", "Gemini", "OpenCode". A catalog name or id
 * is cleaned first (friendlyAgentName), then trailing kind words are dropped, never down to nothing.
 */
export function shortAgentName(raw: string): string {
  const words = friendlyAgentName(raw).split(/\s+/);
  while (words.length > 1 && KIND_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(" ");
}

/** A model's display name without its provider prefix: "opencode/Beam Free" reads "Beam Free". */
export function shortModelName(name: string): string {
  const bare = name.replace(/^[\w.-]+\//, "").trim();
  return bare || name;
}
