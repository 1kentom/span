/**
 * The agents involved in the current chat, for the Active agents bar: the lead, the agents it delegated to (from the
 * feed's delegation cards) and the agents of earlier segments of the same thread (from session metadata). Each state
 * comes from facts Span already has: the lead's turn and requests, each task's reported status and open child
 * permission requests. Nothing is guessed.
 */
import { budgetNote, isFinished, type DelegationTaskState } from "./agent-delegation";
import { agentKey, findHealth, type AgentHealth } from "./agent-health";

export type LiveState = "Working" | "Waiting for you" | "Idle" | "Done" | "Starting" | "Failed";

export type LiveAgent = {
  /** Stable key in the strip. */
  key: string;
  /** Installed agent id when known, for the brand avatar. */
  id?: string;
  name: string;
  state: LiveState;
  health?: AgentHealth;
  /** The delegation card to open when the entry is clicked (children only). */
  taskId?: string;
  lead?: boolean;
  /** What the agent is doing or did: the lead's model, a task's progress or result. */
  detail?: string;
};

export type LiveInput = {
  lead?: { id?: string; name: string; state: LiveState; detail?: string };
  tasks: readonly DelegationTaskState[];
  /** True while a child permission request of this task waits for the user. */
  waiting?: (task: DelegationTaskState) => boolean;
  /** Agents of earlier segments of this thread, oldest first. */
  earlier?: ReadonlyArray<{ id?: string; name: string }>;
  health: readonly AgentHealth[];
  /** The installed id and display name for a reported agent name, when Span knows the agent. */
  resolve?: (name: string) => { id?: string; name: string } | undefined;
};

/** Higher wins when one agent has several tasks: a running task outranks an earlier failed one. */
const WEIGHT: Record<LiveState, number> = { "Waiting for you": 5, Working: 4, Starting: 3, Failed: 2, Idle: 1, Done: 0 };

export function taskState(task: DelegationTaskState, waiting: boolean): LiveState {
  if (waiting) return "Waiting for you";
  if (task.status === "starting") return "Starting";
  if (task.status === "failed") return "Failed";
  if (isFinished(task.status)) return "Done";
  return "Working";
}

/** "@agentclientprotocol/claude-agent-acp@1.2.0" to "claude-agent-acp": the package or binary name without scope, path or version. */
export function bareAgentId(raw: string): string {
  const last = raw.trim().replace(/^@[^/]+\//, "").split(/[\\/]/).pop() ?? "";
  return last.replace(/@[^@]*$/, "").replace(/\.(exe|js|cmd)$/i, "");
}

/** Words that keep their own casing in a cleaned name. */
const CASING: Record<string, string> = { opencode: "OpenCode", github: "GitHub", cli: "CLI", ai: "AI", glm: "GLM", acp: "ACP", vscode: "VS Code" };

/**
 * A readable name for an agent: a display name ("Claude Agent", "OpenCode") is kept as is, while an id or package name
 * ("@agentclientprotocol/claude-agent-acp", "gemini-cli", "opencode") is cleaned into words ("Claude Agent", "Gemini
 * CLI", "OpenCode"). The protocol suffix "acp" is dropped. Never empty.
 */
export function friendlyAgentName(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "Agent";
  const looksLikeId = /[@/\\]/.test(text) || (!/\s/.test(text) && text === text.toLowerCase());
  if (!looksLikeId) return text;
  const words = bareAgentId(text).split(/[-_.\s]+/).filter(Boolean);
  while (words.length > 1 && words[words.length - 1].toLowerCase() === "acp") words.pop();
  if (!words.length) return "Agent";
  return words.map((word) => CASING[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * The installed agent behind a reported name: an exact id match first, then the same agent key ("claude-agent-acp"
 * and "claude-acp" meet), so a delegated agent shows its catalog display name and brand.
 */
export function resolveInstalled(name: string, installed: ReadonlyArray<{ id: string; name?: string }>): { id: string; name: string } | undefined {
  const lower = name.trim().toLowerCase();
  const key = agentKey(bareAgentId(name));
  const entry = installed.find((agent) => agent.id.toLowerCase() === lower) ?? (key ? installed.find((agent) => agentKey(agent.id) === key || (agent.name ? agentKey(agent.name) === key : false)) : undefined);
  return entry ? { id: entry.id, name: entry.name || friendlyAgentName(entry.id) } : undefined;
}

/** Every agent involved in the chat, the lead first, one entry per agent. */
export function liveAgentsOf(input: LiveInput): LiveAgent[] {
  const found: LiveAgent[] = [];
  const byKey = new Map<string, LiveAgent>();
  const add = (entry: LiveAgent, keyName: string) => {
    const key = agentKey(bareAgentId(keyName)) || keyName.toLowerCase();
    const known = byKey.get(key);
    if (!known) {
      const next = { ...entry, key };
      byKey.set(key, next);
      found.push(next);
      return;
    }
    // The lead keeps its own state; among tasks the most active one, and the newest task, win.
    if (known.lead) return;
    if (WEIGHT[entry.state] >= WEIGHT[known.state]) {
      known.state = entry.state;
      if (entry.taskId) known.taskId = entry.taskId;
      if (entry.detail) known.detail = entry.detail;
    }
  };
  if (input.lead) {
    const { id, name, state, detail } = input.lead;
    add({ key: "", id, name: friendlyAgentName(name), state, detail, lead: true, health: findHealth(input.health, id, name) }, id || name);
  }
  for (const task of input.tasks) {
    const reported = task.agentName || task.startingAgentId || "Delegated agent";
    const known = input.resolve?.(task.startingAgentId || reported) ?? (task.startingAgentId ? input.resolve?.(reported) : undefined);
    const id = known?.id ?? task.startingAgentId;
    const name = friendlyAgentName(known?.name ?? reported);
    // Only a real failure reads as failed; a completed task over its token budget keeps "Done" with a quiet note first.
    const detail = task.status === "failed" ? task.detail || task.progressText : isFinished(task.status) ? [budgetNote(task), task.resultSummary].filter(Boolean).join(". ") : task.progressText;
    add({ key: "", id, name, state: taskState(task, input.waiting?.(task) ?? false), taskId: task.taskId, detail: detail || undefined, health: findHealth(input.health, id, task.agentName, name) }, id || reported);
  }
  for (const segment of input.earlier ?? []) {
    add({ key: "", id: segment.id, name: friendlyAgentName(segment.name), state: "Done", health: findHealth(input.health, segment.id, segment.name) }, segment.id || segment.name);
  }
  return found;
}

/**
 * What an avatar's state badge says, most urgent first: an error (a failed task, or a health check with no reply),
 * waiting for the user (a question, a permission, or a sign-in), working, starting, idle, done. A health result only
 * colours an agent that is not busy: an agent that is working or asking has fresher evidence than the last check.
 */
export type LiveTone = "error" | "waiting" | "working" | "starting" | "idle" | "done";

export const TONE_URGENCY: Record<LiveTone, number> = { error: 5, waiting: 4, working: 3, starting: 2, idle: 1, done: 0 };

export function liveTone(agent: LiveAgent, showHealth = true): LiveTone {
  if (agent.state === "Failed") return "error";
  if (agent.state === "Waiting for you") return "waiting";
  if (agent.state === "Working") return "working";
  if (agent.state === "Starting") return "starting";
  if (showHealth && agent.health?.state === "unreachable") return "error";
  if (showHealth && agent.health?.state === "signedOut") return "waiting";
  return agent.state === "Done" ? "done" : "idle";
}

/** The state word in the tooltip and accessible name. */
export function liveStateText(agent: LiveAgent, showHealth = true): string {
  const tone = liveTone(agent, showHealth);
  if (tone === "error" && agent.state !== "Failed") return "Unreachable";
  if (tone === "waiting" && agent.state !== "Waiting for you") return "Signed out";
  return agent.state;
}

/** The agents in stack order: most urgent first, the original order (lead first) among equals. */
export function orderByUrgency(agents: readonly LiveAgent[], showHealth = true): LiveAgent[] {
  return agents
    .map((agent, index) => ({ agent, index, urgency: TONE_URGENCY[liveTone(agent, showHealth)] }))
    .sort((a, b) => b.urgency - a.urgency || a.index - b.index)
    .map((entry) => entry.agent);
}

/**
 * The avatars that fit and the rest behind a "+N" chip. Up to `max` agents show whole (so the chip never says "+1");
 * past that, `max - 1` show and the chip counts the others.
 */
export function stackOf<T>(agents: readonly T[], max = 5): { visible: T[]; hidden: T[] } {
  const limit = Math.max(1, max);
  if (agents.length <= limit) return { visible: [...agents], hidden: [] };
  const shown = Math.max(1, limit - 1);
  return { visible: agents.slice(0, shown), hidden: agents.slice(shown) };
}

const SUMMARY: Record<Exclude<LiveTone, "idle" | "done">, string> = { error: "need attention", waiting: "waiting", working: "working", starting: "starting" };

/**
 * One short phrase for the whole group, the most urgent state winning: "1 failed", "2 unreachable", "1 waiting",
 * "2 working", "1 starting", else "All done" when every agent finished and "All idle" otherwise.
 */
export function liveSummary(agents: readonly LiveAgent[], showHealth = true): { tone: LiveTone; text: string } {
  const tones = agents.map((agent) => liveTone(agent, showHealth));
  const top = tones.reduce<LiveTone>((best, tone) => (TONE_URGENCY[tone] > TONE_URGENCY[best] ? tone : best), "done");
  const count = tones.filter((tone) => tone === top).length;
  if (top === "error") {
    const failed = agents.filter((agent) => agent.state === "Failed").length;
    if (failed === count) return { tone: top, text: `${count} failed` };
    if (failed === 0) return { tone: top, text: `${count} unreachable` };
    return { tone: top, text: `${count} ${SUMMARY.error}` };
  }
  if (top === "waiting") {
    const asking = agents.filter((agent) => agent.state === "Waiting for you").length;
    return { tone: top, text: asking === 0 ? `${count} signed out` : `${count} ${SUMMARY.waiting}` };
  }
  if (top === "working" || top === "starting") return { tone: top, text: `${count} ${SUMMARY[top]}` };
  return { tone: top, text: tones.length && tones.every((tone) => tone === "done") ? "All done" : "All idle" };
}
