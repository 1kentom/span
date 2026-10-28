/**
 * The agents involved in the current chat, for the Live agents strip: the lead, the agents it delegated to (from the
 * feed's delegation cards) and the agents of earlier segments of the same thread (from session metadata). Each state
 * comes from facts Span already has: the lead's turn and requests, each task's reported status and open child
 * permission requests. Nothing is guessed.
 */
import { isFinished, type DelegationTaskState } from "./agent-delegation";
import { agentKey, findHealth, type AgentHealth } from "./agent-health";

export type LiveState = "Working" | "Waiting for you" | "Idle" | "Done" | "Starting";

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
};

export type LiveInput = {
  lead?: { id?: string; name: string; state: LiveState };
  tasks: readonly DelegationTaskState[];
  /** True while a child permission request of this task waits for the user. */
  waiting?: (task: DelegationTaskState) => boolean;
  /** Agents of earlier segments of this thread, oldest first. */
  earlier?: ReadonlyArray<{ id?: string; name: string }>;
  health: readonly AgentHealth[];
  /** The installed id and display name for a reported agent name, when Span knows the agent. */
  resolve?: (name: string) => { id?: string; name: string } | undefined;
};

/** Higher wins when one agent has several tasks. */
const WEIGHT: Record<LiveState, number> = { "Waiting for you": 4, Working: 3, Starting: 2, Idle: 1, Done: 0 };

export function taskState(task: DelegationTaskState, waiting: boolean): LiveState {
  if (waiting) return "Waiting for you";
  if (task.status === "starting") return "Starting";
  if (isFinished(task.status)) return "Done";
  return "Working";
}

/** Every agent involved in the chat, the lead first, one entry per agent. */
export function liveAgentsOf(input: LiveInput): LiveAgent[] {
  const found: LiveAgent[] = [];
  const byKey = new Map<string, LiveAgent>();
  const add = (entry: LiveAgent, keyName: string) => {
    const key = agentKey(keyName) || keyName.toLowerCase();
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
    }
  };
  if (input.lead) {
    add({ key: "", id: input.lead.id, name: input.lead.name, state: input.lead.state, lead: true, health: findHealth(input.health, input.lead.id, input.lead.name) }, input.lead.id || input.lead.name);
  }
  for (const task of input.tasks) {
    const reported = task.agentName || task.startingAgentId || "Delegated agent";
    const known = input.resolve?.(task.startingAgentId || reported);
    const id = known?.id ?? task.startingAgentId;
    const name = known?.name ?? reported;
    add({ key: "", id, name, state: taskState(task, input.waiting?.(task) ?? false), taskId: task.taskId, health: findHealth(input.health, id, task.agentName, name) }, id || reported);
  }
  for (const segment of input.earlier ?? []) {
    add({ key: "", id: segment.id, name: segment.name, state: "Done", health: findHealth(input.health, segment.id, segment.name) }, segment.id || segment.name);
  }
  return found;
}
