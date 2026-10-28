import type {
  AgentEvent,
  AgentFeatures,
  AuthMethodInfo,
  ConfigOption_Deserialize as ConfigOption,
  EditProposal,
  PlanEntry,
  SlashCommand,
} from "../bindings";
import type { Attachment } from "./attachments";

/** Agent session state built from ACP events. Pure data: the panel derives every view from it. */
export type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;
export type PermissionEvent = Extract<AgentEvent, { kind: "permission" }>;
export type ElicitationEvent = Extract<AgentEvent, { kind: "elicitation" }>;

export type FeedItem =
  | { id: number; kind: "user"; text: string; attachments?: Attachment[]; /** Sent by interrupting the running turn. */ steered?: boolean }
  | { id: number; kind: "text" | "thought" | "note"; text: string }
  | { id: number; kind: "notice"; severity: string; title: string; description?: string }
  | { id: number; kind: "compaction"; compactionId: string; status: string; summary: string; error?: string }
  | { id: number; kind: "tool"; event: ToolEvent }
  | { id: number; kind: "permission"; event: PermissionEvent; resolved: boolean }
  | { id: number; kind: "proposal"; proposal: EditProposal; resolution?: "accepted" | "rejected" }
  | { id: number; kind: "stop"; reason: string };

export type AgentInfo = { name?: string; title?: string; version?: string; features: AgentFeatures };
export type Usage = { used: number; size: number; cost?: { amount: number; currency: string } };
/** A failure the panel shows as an error card. `phase` says where it happened. */
export type Failure = { phase: "connect" | "auth" | "session" | "prompt" | "exit"; message: string; log?: string[] };

export type AgentState = {
  status: string;
  statusMessage: string;
  sessionId?: string;
  agent?: AgentInfo;
  auth?: { message: string; methods: AuthMethodInfo[] };
  canLoad: boolean;
  canList: boolean;
  commands: SlashCommand[];
  config: ConfigOption[];
  usage?: Usage;
  sessionTitle?: string;
  plan: PlanEntry[];
  elicitations: ElicitationEvent[];
  feed: FeedItem[];
  logs: string[];
  logCount: number;
  /** Recent stderr lines, shown in the process exit card. */
  stderr: string[];
  running: boolean;
  stopRequested: boolean;
  lastError?: string;
  failure?: Failure;
  nextId: number;
};

export const LOG_LIMIT = 240;
export const FEED_LIMIT = 400;
const STDERR_LIMIT = 12;
/** Stop reasons that get a card with a Continue action. */
export const CARD_STOP_REASONS = ["max_tokens", "max_turn_requests", "refusal"];

export function initialAgentState(desktop: boolean): AgentState {
  return {
    status: desktop ? "disconnected" : "unavailable",
    statusMessage: desktop ? "No agent connected" : "Agents require the desktop app",
    canLoad: false,
    canList: false,
    commands: [],
    config: [],
    plan: [],
    elicitations: [],
    feed: [],
    logs: [],
    logCount: 0,
    stderr: [],
    running: false,
    stopRequested: false,
    nextId: 0,
  };
}

/** Clears everything tied to one conversation, keeping the agent identity and logs. */
export function resetConversation(state: AgentState): AgentState {
  return { ...state, feed: [], plan: [], elicitations: [], usage: undefined, sessionTitle: undefined, commands: [], running: false, stopRequested: false };
}

export function addFeedItem(state: AgentState, item: DistributiveOmit<FeedItem, "id">): AgentState {
  const id = state.nextId + 1;
  return { ...state, nextId: id, feed: [...state.feed, { ...item, id } as FeedItem].slice(-FEED_LIMIT) };
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function mapFeed(state: AgentState, update: (item: FeedItem) => FeedItem): AgentState {
  return { ...state, feed: state.feed.map(update) };
}

function appendText(state: AgentState, kind: "user" | "text" | "thought", text: string): AgentState {
  const last = state.feed[state.feed.length - 1];
  if (last && last.kind === kind) return { ...state, feed: [...state.feed.slice(0, -1), { ...last, text: last.text + text }] };
  return addFeedItem(state, { kind, text });
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Tool updates are partial: keep earlier fields the update leaves out. */
export function mergeTool(previous: ToolEvent, next: ToolEvent): ToolEvent {
  const before = parseObject(previous.contentJson);
  const after = parseObject(next.contentJson);
  const merged = before && after ? { ...before, ...Object.fromEntries(Object.entries(after).filter(([, value]) => value !== null && value !== undefined)) } : undefined;
  return {
    ...previous,
    ...next,
    title: next.title ?? previous.title,
    status: next.status ?? previous.status,
    toolKind: next.toolKind ?? previous.toolKind,
    parentToolCallId: next.parentToolCallId ?? previous.parentToolCallId,
    contentJson: merged ? JSON.stringify(merged) : next.contentJson || previous.contentJson,
  };
}

function eventSession(event: AgentEvent): string | undefined {
  const value = (event as { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value ? value : undefined;
}

/** Applies one ACP event. Events for another session are ignored. */
export function reduceAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  const session = eventSession(event);
  if (event.kind !== "session" && session && state.sessionId && session !== state.sessionId) return state;
  switch (event.kind) {
    case "log": {
      const line = `[${event.direction}] ${event.line.slice(0, 6000)}${event.line.length > 6000 ? " [line truncated]" : ""}`;
      const stderr = event.direction === "Stderr" && event.line.trim() ? [...state.stderr, event.line.slice(0, 400)].slice(-STDERR_LIMIT) : state.stderr;
      return { ...state, logCount: state.logCount + 1, logs: [...state.logs, line].slice(-LOG_LIMIT), stderr };
    }
    case "status": {
      const next = { ...state, status: event.state, statusMessage: event.message };
      if (!["error", "disconnected"].includes(event.state)) return next;
      const exited = event.state === "disconnected";
      return {
        ...next,
        running: false,
        stopRequested: false,
        sessionId: undefined,
        auth: undefined,
        elicitations: [],
        feed: next.feed.map((item) => (item.kind === "permission" && !item.resolved ? { ...item, resolved: true } : item)),
        failure: exited ? { phase: "exit", message: state.lastError || event.message, log: state.stderr } : state.failure,
      };
    }
    case "session":
      return { ...state, sessionId: event.sessionId, status: "ready", auth: undefined };
    case "capabilities":
      return { ...state, canLoad: event.canLoadSession, canList: event.canListSessions };
    case "ready":
      return {
        ...state,
        agent: { name: event.agentName ?? undefined, title: event.agentTitle ?? undefined, version: event.agentVersion ?? undefined, features: event.features },
        canLoad: event.features.loadSession,
        canList: event.features.canListSessions,
      };
    case "authRequired":
      return { ...state, auth: { message: event.message, methods: event.authMethods } };
    case "availableCommands":
      return { ...state, commands: event.commands };
    case "currentMode":
      return {
        ...state,
        config: state.config.map((option) =>
          option.category === "mode" && option.groups.some((group) => group.choices.some((choice) => choice.value === event.modeId))
            ? { ...option, currentValue: event.modeId }
            : option,
        ),
      };
    case "sessionInfo":
      return event.title ? { ...state, sessionTitle: event.title } : state;
    case "usage":
      return {
        ...state,
        usage: {
          used: event.used,
          size: event.size,
          cost: event.costAmount !== null && event.costAmount !== undefined && event.costCurrency ? { amount: event.costAmount, currency: event.costCurrency } : undefined,
        },
      };
    case "notice":
      return addFeedItem(state, { kind: "notice", severity: event.severity, title: event.title, description: event.description ?? undefined });
    case "compaction": {
      const found = state.feed.some((item) => item.kind === "compaction" && item.compactionId === event.compactionId);
      if (!found)
        return addFeedItem(state, { kind: "compaction", compactionId: event.compactionId, status: event.status, summary: event.summary ?? "", error: event.error ?? undefined });
      return mapFeed(state, (item) =>
        item.kind === "compaction" && item.compactionId === event.compactionId
          ? { ...item, status: event.status, summary: event.summary ?? item.summary, error: event.error ?? item.error }
          : item,
      );
    }
    case "compactionSummary": {
      const found = state.feed.some((item) => item.kind === "compaction" && item.compactionId === event.compactionId);
      if (!found) return addFeedItem(state, { kind: "compaction", compactionId: event.compactionId, status: "in_progress", summary: event.text });
      return mapFeed(state, (item) => (item.kind === "compaction" && item.compactionId === event.compactionId ? { ...item, summary: item.summary + event.text } : item));
    }
    case "elicitation":
      return state.elicitations.some((pending) => pending.requestId === event.requestId) ? state : { ...state, elicitations: [...state.elicitations, event] };
    case "elicitationResolved":
      return { ...state, elicitations: state.elicitations.filter((pending) => pending.requestId !== event.requestId) };
    case "elicitationComplete":
      return addFeedItem(state, { kind: "note", text: "The agent finished the browser step" });
    case "user":
      return appendText(state, "user", event.text);
    case "text":
    case "thought":
      return appendText(state, event.kind, event.text);
    case "plan":
      return { ...state, plan: event.entries };
    case "config":
      return { ...state, config: event.options };
    case "tool": {
      const existing = state.feed.some((item) => item.kind === "tool" && item.event.toolCallId === event.toolCallId);
      if (!existing) return addFeedItem(state, { kind: "tool", event });
      return mapFeed(state, (item) => (item.kind === "tool" && item.event.toolCallId === event.toolCallId ? { ...item, event: mergeTool(item.event, event) } : item));
    }
    case "permission":
      return addFeedItem(state, { kind: "permission", event, resolved: false });
    case "permissionResolved":
      return resolvePermission(state, event.requestId);
    case "proposal":
      return addFeedItem(state, { kind: "proposal", proposal: event.proposal });
    case "proposalResolved":
      return resolveProposal(state, event.proposalId, event.accepted);
    case "complete": {
      const next: AgentState = { ...state, running: false, stopRequested: false, status: "ready", statusMessage: `Ready · ${event.stopReason.replaceAll("_", " ")}` };
      if (CARD_STOP_REASONS.includes(event.stopReason)) return addFeedItem(next, { kind: "stop", reason: event.stopReason });
      if (event.stopReason === "cancelled") return addFeedItem(next, { kind: "note", text: "Stopped" });
      return next;
    }
    case "error":
      return {
        ...state,
        running: false,
        stopRequested: false,
        lastError: event.message,
        failure: { phase: state.sessionId ? "prompt" : "connect", message: event.message },
        ...(state.sessionId ? { status: "ready", statusMessage: "The last agent operation failed" } : {}),
      };
  }
  return state;
}

export function resolvePermission(state: AgentState, requestId: string): AgentState {
  return mapFeed(state, (item) => (item.kind === "permission" && item.event.requestId === requestId ? { ...item, resolved: true } : item));
}

export function resolveProposal(state: AgentState, proposalId: string, accepted: boolean): AgentState {
  return mapFeed(state, (item) => (item.kind === "proposal" && item.proposal.id === proposalId ? { ...item, resolution: accepted ? "accepted" : "rejected" } : item));
}

export function unresolvedProposals(feed: readonly FeedItem[]): EditProposal[] {
  return feed.flatMap((item) => (item.kind === "proposal" && !item.resolution ? [item.proposal] : []));
}

/** The oldest permission request that is still open. */
export function openPermission(feed: readonly FeedItem[]): Extract<FeedItem, { kind: "permission" }> | undefined {
  return feed.find((item): item is Extract<FeedItem, { kind: "permission" }> => item.kind === "permission" && !item.resolved);
}

/** True when the agent advertised a compact slash command. */
export const canCompact = (commands: readonly SlashCommand[]) => commands.some((command) => command.name.replace(/^\//, "") === "compact");
