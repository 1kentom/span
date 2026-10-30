/**
 * The side panel's Agents tab as a tree: the lead, then its delegates and the commands it is running as nested rows.
 * Built from what the controller already knows (live agents, delegation tasks and tool calls in the feed); nothing is
 * guessed, so a row without a reported model, usage or budget simply leaves that part out.
 */
import type { FeedItem } from "./agent-session";
import type { DelegationTaskState } from "./agent-delegation";
import { liveStateText, liveTone, type LiveAgent, type LiveTone } from "./live-agents";

export type TreeTone = LiveTone | "running";

export type TreeNode = {
  key: string;
  kind: "agent" | "command";
  /** Nested under the lead. */
  child: boolean;
  /** The last nested row, where the tree line stops. */
  last: boolean;
  id?: string;
  name: string;
  role: string;
  state: string;
  tone: TreeTone;
  model?: string;
  meta?: string;
  note?: string;
  /** Tokens used against a reported budget. Only set when both are known. */
  budget?: { used: number; limit: number };
  taskId?: string;
  toolCallId?: string;
  /** Working or waiting: the avatar carries a pulsing dot. */
  live: boolean;
  canStop: boolean;
};

export type AgentTree = { nodes: TreeNode[]; head: string; sub: string; canStopAll: boolean };

type ToolItem = Extract<FeedItem, { kind: "tool" }>;

const RUNNING_TOOL = new Set(["pending", "in_progress", "running"]);

/** "1.2k", "12k", "980": a compact token count. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** "12k tokens · 3 turns · 1m 20s" from a task's reported usage. Empty parts are left out. */
export function usageMeta(task: DelegationTaskState | undefined): string | undefined {
  const used = task?.budgetUsed;
  if (!used) return undefined;
  const seconds = Math.round(used.elapsedSeconds);
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : seconds > 0 ? `${seconds}s` : "";
  const parts = [used.tokens ? `${compactTokens(used.tokens)} tokens` : "", used.turns ? `${used.turns} ${used.turns === 1 ? "turn" : "turns"}` : "", time];
  return parts.filter(Boolean).join(" · ") || undefined;
}

/** Commands the lead is running now: execute tool calls that have not finished, in feed order. */
export function runningCommands(feed: readonly FeedItem[]): ToolItem[] {
  return feed.filter((item): item is ToolItem => item.kind === "tool" && item.event.toolKind === "execute" && !item.event.internal && (item.event.status == null || RUNNING_TOOL.has(item.event.status)));
}

const busy = (state: string) => state === "Working" || state === "Starting";

export function agentTree(input: { agents: readonly LiveAgent[]; feed: readonly FeedItem[]; showHealth: boolean; leadRunning: boolean }): AgentTree {
  const lead = input.agents.find((entry) => entry.lead);
  if (!lead) return { nodes: [], head: "", sub: "", canStopAll: false };
  const tasks = new Map(input.feed.flatMap((item) => (item.kind === "delegation" ? [[item.task.taskId, item.task] as const] : [])));
  const tools = input.feed.filter((item) => item.kind === "tool").length;
  const delegates = input.agents.filter((entry) => !entry.lead);
  const commands = runningCommands(input.feed);
  const childCount = delegates.length + commands.length;
  const nodes: TreeNode[] = [
    {
      key: `agent:${lead.key || lead.name}`,
      kind: "agent",
      child: false,
      last: childCount === 0,
      id: lead.id,
      name: lead.name,
      role: "Lead",
      state: liveStateText(lead, input.showHealth),
      tone: liveTone(lead, input.showHealth),
      model: lead.detail,
      meta: tools ? `${tools} ${tools === 1 ? "tool call" : "tool calls"}` : undefined,
      live: lead.state === "Working" || lead.state === "Waiting for you",
      canStop: input.leadRunning,
    },
  ];
  delegates.forEach((entry, index) => {
    const task = entry.taskId ? tasks.get(entry.taskId) : undefined;
    nodes.push({
      key: `agent:${entry.key || entry.name}`,
      kind: "agent",
      child: true,
      last: index === childCount - 1,
      id: entry.id,
      name: entry.name,
      role: entry.taskId ? "Delegated" : "Earlier in this thread",
      state: liveStateText(entry, input.showHealth),
      tone: liveTone(entry, input.showHealth),
      model: task?.model,
      meta: usageMeta(task),
      note: entry.detail,
      taskId: entry.taskId,
      live: entry.state === "Working" || entry.state === "Waiting for you",
      canStop: Boolean(entry.taskId) && busy(entry.state),
    });
  });
  commands.forEach((item, index) => {
    nodes.push({
      key: `command:${item.event.toolCallId}`,
      kind: "command",
      child: true,
      last: delegates.length + index === childCount - 1,
      name: item.event.title?.trim() || "Command",
      role: "",
      state: "Running",
      tone: "running",
      meta: "Started by the lead",
      toolCallId: item.event.toolCallId,
      live: false,
      canStop: false,
    });
  });
  const agentStates = input.agents.map((entry) => entry.state);
  const run = agentStates.filter((state) => state === "Working").length + commands.length;
  const wait = agentStates.filter((state) => state === "Waiting for you").length;
  const fail = agentStates.filter((state) => state === "Failed").length;
  const done = delegates.some((entry) => entry.state === "Done");
  const head = run ? `${run} running` : wait ? `${wait} waiting for you` : fail ? `${fail} failed` : done ? "All done" : "Idle";
  const sub = [run && wait ? `${wait} waiting for you` : "", "depth 1 of 1"].filter(Boolean).join(" · ");
  return { nodes, head, sub, canStopAll: input.leadRunning || delegates.some((entry) => busy(entry.state) || entry.state === "Waiting for you") };
}
