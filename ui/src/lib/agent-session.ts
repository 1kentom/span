import { classifyAgentError, isLimitKind, limitStatus } from "./agent-errors";
import type {
  AgentEvent,
  AgentFeatures,
  AgentHint,
  AuthMethodInfo,
  ConfigOption_Deserialize as ConfigOption,
  DecisionRecord,
  DelegationEvent,
  DelegationStatus,
  EditProposal,
  PlanEntry,
  SessionKey,
  SlashCommand,
} from "../bindings";
import type { Attachment } from "./attachments";
import type { BranchMode } from "./agent-rewind";
import { hintText, PERMISSION_BYPASS_NOTICE } from "./agent-hint-text";
import { parseUrlRequest, type UrlRecord } from "./agent-url-request";
import { isFinished, knownDelegation, mergeTask, type ChildRequest, type DelegationNote, type DelegationTaskState } from "./agent-delegation";

/** Agent session state built from ACP events. Pure data: the panel derives every view from it. */
export type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;
export type PermissionEvent = Extract<AgentEvent, { kind: "permission" }>;
export type ElicitationEvent = Extract<AgentEvent, { kind: "elicitation" }>;

export type FeedItem =
  | { id: number; kind: "user"; text: string; attachments?: Attachment[]; /** Sent by interrupting the running turn. */ steered?: boolean; /** Sent with Send now from the queue. */ sentNow?: boolean; /** Carried context sent ahead of this message after an agent switch, shown as a card. */ context?: string; /** Where the carried context came from, shown on the card. */ contextNote?: string }
  | { id: number; kind: "text" | "thought"; text: string; /** The agent's id for this message, when it sent one. */ messageId?: string }
  | { id: number; kind: "note"; text: string }
  /** Divider after the open chat switched agent: the feed above came from the previous agent's session. */
  | { id: number; kind: "handoff"; from: string; to: string; carried: boolean }
  /** Divider where a new session started from an earlier message (edit, resend or fork): the feed above is carried. */
  | { id: number; kind: "branch"; mode: BranchMode; carried: boolean }
  | ({ id: number; kind: "signin" } & UrlRecord)
  | { id: number; kind: "notice"; severity: string; title: string; description?: string; /** Set for a notice the agent later clears. */ noticeId?: string; hint?: AgentHint }
  | { id: number; kind: "compaction"; compactionId: string; status: string; summary: string; error?: string }
  | { id: number; kind: "tool"; event: ToolEvent; /** A status held back while a permission for this call is open; the step shows as waiting until then. */ deferredStatus?: string }
  | { id: number; kind: "permission"; event: PermissionEvent; resolved: boolean }
  | { id: number; kind: "proposal"; proposal: EditProposal; resolution?: "accepted" | "rejected" }
  | { id: number; kind: "stop"; reason: string; hint?: AgentHint }
  | { id: number; kind: "decision"; decision: DecisionRecord }
  | { id: number; kind: "delegation"; task: DelegationTaskState };

export type AgentInfo = { name?: string; title?: string; version?: string; features: AgentFeatures };
export type Usage = { used: number; size: number; cost?: { amount: number; currency: string } };
/** Tokens the prompt response reported, shown only when the agent never sent a context usage update. */
export type TurnUsage = { tokens: number };
/** A failure the panel shows as an error card. `phase` says where it happened. */
export type Failure = { phase: "connect" | "auth" | "session" | "prompt" | "exit"; message: string; log?: string[] };

export type AgentState = {
  status: string;
  statusMessage: string;
  sessionId?: string;
  agent?: AgentInfo;
  auth?: { message: string; methods: AuthMethodInfo[]; hint?: AgentHint; /** The agent's own text when it is not a sign-in request. Shown first; sign-in is secondary. */ agentMessage?: string };
  /** The session's mode lets the agent run tools without asking. `mode` is the mode's name. */
  permissionBypass?: { mode: string };
  canLoad: boolean;
  canList: boolean;
  commands: SlashCommand[];
  config: ConfigOption[];
  usage?: Usage;
  turnUsage?: TurnUsage;
  sessionTitle?: string;
  plan: PlanEntry[];
  elicitations: ElicitationEvent[];
  /** Permission requests from sessions other than the open chat. Only those from a known delegated child are ever shown. */
  strayPermissions: PermissionEvent[];
  /** Typed `childPermission` delegation events: which request belongs to which delegated child and task. */
  childRequests: ChildRequest[];
  delegation: DelegationNote;
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
const STRAY_LIMIT = 24;
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
    strayPermissions: [],
    childRequests: [],
    delegation: {},
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
  return { ...state, feed: [], plan: [], elicitations: [], strayPermissions: [], childRequests: [], usage: undefined, turnUsage: undefined, sessionTitle: undefined, commands: [], running: false, stopRequested: false, permissionBypass: undefined };
}

export function addFeedItem(state: AgentState, item: DistributiveOmit<FeedItem, "id">): AgentState {
  const id = state.nextId + 1;
  return { ...state, nextId: id, feed: [...state.feed, { ...item, id } as FeedItem].slice(-FEED_LIMIT) };
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function mapFeed(state: AgentState, update: (item: FeedItem) => FeedItem): AgentState {
  return { ...state, feed: state.feed.map(update) };
}

/** Replayed non-text user blocks become chips without bytes or a path: an agent supplied uri is never read. */
let replayCounter = 0;
export function replayAttachments(markers: readonly { kind: string; uri?: string | null; name?: string | null; mimeType?: string | null }[] | undefined): Attachment[] {
  return (markers ?? []).map((marker) => {
    const fromUri = marker.uri ? decodeUri(marker.uri.split(/[\\/]/).filter(Boolean).pop() ?? "") : "";
    const image = marker.kind === "image" || Boolean(marker.mimeType?.startsWith("image/"));
    return {
      id: `replay-${++replayCounter}`,
      kind: image ? "image" : "file",
      name: marker.name || fromUri || (image ? "Image" : "Attachment"),
      mime: marker.mimeType ?? "",
      size: 0,
      source: "workspace-file",
      status: "ready",
    } satisfies Attachment;
  });
}
function decodeUri(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type Block = { messageId?: string | null; newBlock?: boolean | null };
function appendText(state: AgentState, kind: "user" | "text" | "thought", text: string, block: Block = {}, attachments: Attachment[] = []): AgentState {
  const last = state.feed[state.feed.length - 1];
  const messageId = block.messageId ?? undefined;
  const sameMessage = !(messageId && last && "messageId" in last && last.messageId && last.messageId !== messageId);
  if (last && last.kind === kind && !block.newBlock && sameMessage) {
    const merged = { ...last, text: last.text + text } as FeedItem;
    if (merged.kind === "user" && attachments.length) merged.attachments = [...(merged.attachments ?? []), ...attachments];
    if ((merged.kind === "text" || merged.kind === "thought") && messageId && !merged.messageId) merged.messageId = messageId;
    return { ...state, feed: [...state.feed.slice(0, -1), merged] };
  }
  if (kind === "user") return addFeedItem(state, { kind, text, ...(attachments.length ? { attachments } : {}) });
  return addFeedItem(state, { kind, text, ...(messageId ? { messageId } : {}) });
}

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Total tokens from a prompt response `usage` value. Reads camelCase and snake_case; never guesses a window size. */
export function turnTokens(usage: unknown): number | undefined {
  const record = usage && typeof usage === "object" && !Array.isArray(usage) ? (usage as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const total = count(record.totalTokens) ?? count(record.total_tokens);
  if (total !== undefined) return total;
  const input = count(record.inputTokens) ?? count(record.input_tokens);
  const output = count(record.outputTokens) ?? count(record.output_tokens);
  return input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
}

/** Tool updates are partial: keep earlier fields the update leaves out. */
export function mergeTool(previous: ToolEvent, next: ToolEvent): ToolEvent {
  const before = parseObject(previous.contentJson);
  const after = parseObject(next.contentJson);
  const merged = before && after ? { ...before, ...Object.fromEntries(Object.entries(after).filter(([, value]) => value !== null && value !== undefined)) } : undefined;
  const list = <T,>(value: T[] | undefined, fallback: T[] | undefined) => (value && value.length ? value : fallback);
  const present = <T,>(value: T | null | undefined, fallback: T | null | undefined) => (value === null || value === undefined ? fallback : value);
  const result: ToolEvent = {
    ...previous,
    ...next,
    title: next.title ?? previous.title,
    status: next.status ?? previous.status,
    toolKind: next.toolKind ?? previous.toolKind,
    parentToolCallId: next.parentToolCallId ?? previous.parentToolCallId,
    contentJson: merged ? JSON.stringify(merged) : next.contentJson || previous.contentJson,
    rawInput: present(next.rawInput, previous.rawInput),
    rawOutput: present(next.rawOutput, previous.rawOutput),
    locations: list(next.locations, previous.locations),
    diffs: list(next.diffs, previous.diffs),
    images: list(next.images, previous.images),
    savedPath: present(next.savedPath, previous.savedPath),
    internal: present(next.internal, previous.internal),
    // The "preparing" hint ends as soon as the agent names the call; any other hint stays.
    hint: next.hint ?? (previous.hint === "toolPending" ? undefined : previous.hint),
  };
  for (const key of ["rawInput", "rawOutput", "locations", "diffs", "images", "savedPath", "internal", "hint"] as const) if (result[key] === undefined) delete result[key];
  return result;
}

function eventSession(event: AgentEvent): string | undefined {
  const value = (event as { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value ? value : undefined;
}

/** Applies one ACP event. Events for another session are ignored. */
export function reduceAgentEvent(state: AgentState, event: AgentEvent): AgentState {
  const session = eventSession(event);
  // Names the deleted session, not the open one, so it is noted before the session filter.
  if (event.kind === "notice" && event.hint === "deletedStillListed") return addFeedItem(state, { kind: "note", text: hintText(event.hint)! });
  if (session && state.sessionId && session !== state.sessionId) {
    // Another session on this connection. Delegated children ask permission here; the view decides which are theirs.
    if (event.kind === "permission") return { ...state, strayPermissions: [...state.strayPermissions.filter((item) => item.requestId !== event.requestId), event].slice(-STRAY_LIMIT) };
    if (event.kind === "permissionResolved") return dropRequest(state, event.requestId);
  }
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
        permissionBypass: undefined,
        elicitations: [],
        strayPermissions: [],
        childRequests: [],
        delegation: {},
        feed: next.feed.map((item) =>
          item.kind === "permission" && !item.resolved ? { ...item, resolved: true } : item.kind === "signin" && item.status === "waiting" ? { ...item, status: "cancelled" } : item,
        ),
        failure: exited ? { phase: "exit", message: state.lastError || event.message, log: state.stderr } : state.failure,
      };
    }
    case "session":
      return { ...state, sessionId: event.sessionId, status: "ready", auth: undefined, permissionBypass: event.sessionId === state.sessionId ? state.permissionBypass : undefined };
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
      return { ...state, auth: { message: event.message, methods: event.authMethods, ...(event.hint ? { hint: event.hint } : {}), ...(event.agentMessage ? { agentMessage: event.agentMessage } : {}) } };
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
    case "notice": {
      if (event.hint === "permissionsBypassed") return { ...state, permissionBypass: { mode: event.title } };
      if (event.hint === "interruptedByUser") return addFeedItem(state, { kind: "note", text: hintText(event.hint)! });
      const notice = { kind: "notice" as const, severity: event.severity, title: event.title, description: event.description ?? undefined, ...(event.noticeId ? { noticeId: event.noticeId } : {}), ...(event.hint ? { hint: event.hint } : {}) };
      const id = event.noticeId;
      if (id && state.feed.some((item) => item.kind === "notice" && item.noticeId === id)) return mapFeed(state, (item) => (item.kind === "notice" && item.noticeId === id ? { ...notice, id: item.id } : item));
      return addFeedItem(state, notice);
    }
    case "noticeCleared":
      if (event.noticeId === PERMISSION_BYPASS_NOTICE) return { ...state, permissionBypass: undefined };
      return { ...state, feed: state.feed.filter((item) => !(item.kind === "notice" && item.noticeId === event.noticeId)) };
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
    case "elicitation": {
      if (state.elicitations.some((pending) => pending.requestId === event.requestId)) return state;
      const next = { ...state, elicitations: [...state.elicitations, event] };
      return event.mode === "url" ? addFeedItem(next, urlRecordFor(event)) : next;
    }
    case "elicitationResolved":
      // Resolved without the user opening the page (declined, stopped, agent gone) reads as cancelled.
      return mapUrlRecords({ ...state, elicitations: state.elicitations.filter((pending) => pending.requestId !== event.requestId) }, (item) =>
        item.requestId === event.requestId && item.status === "waiting" ? { ...item, status: "cancelled" } : item,
      );
    case "elicitationComplete": {
      if (!state.feed.some((item) => item.kind === "signin" && item.elicitationId === event.elicitationId)) return addFeedItem(state, { kind: "note", text: "The agent finished the browser step" });
      return mapUrlRecords(state, (item) => (item.elicitationId === event.elicitationId && item.status !== "cancelled" ? { ...item, status: "completed" } : item));
    }
    case "user":
      return appendText(state, "user", event.text, {}, replayAttachments(event.attachments));
    case "text":
    case "thought":
      return appendText(state, event.kind, event.text, event);
    case "plan":
      return { ...state, plan: event.entries };
    case "config":
      return { ...state, config: event.options };
    case "tool": {
      const asking = awaitsPermission(state.feed, event.toolCallId);
      const existing = state.feed.some((item) => item.kind === "tool" && item.event.toolCallId === event.toolCallId);
      if (!existing) return addFeedItem(state, holdWhileAsking({ kind: "tool", event }, asking));
      return mapFeed(state, (item) => (item.kind === "tool" && item.event.toolCallId === event.toolCallId ? holdWhileAsking({ ...item, event: mergeTool(item.event, event) }, asking) : item));
    }
    case "permission":
      // OpenCode reports in_progress before it asks: the step waits until the user answers.
      return addFeedItem(
        mapFeed(state, (item) => (item.kind === "tool" && item.event.toolCallId === event.toolCallId ? holdWhileAsking(item, true) : item)),
        { kind: "permission", event, resolved: false },
      );
    case "permissionResolved": {
      const asked = state.feed.find((item) => item.kind === "permission" && item.event.requestId === event.requestId);
      const resolved = resolvePermission(dropRequest(state, event.requestId), event.requestId);
      const toolCallId = asked?.kind === "permission" ? asked.event.toolCallId : undefined;
      if (!toolCallId || awaitsPermission(resolved.feed, toolCallId)) return resolved;
      return mapFeed(resolved, (item) => (item.kind === "tool" && item.event.toolCallId === toolCallId ? releaseHeld(item) : item));
    }
    case "delegation":
      return reduceDelegation(state, event.event);
    case "proposal":
      return addFeedItem(state, { kind: "proposal", proposal: event.proposal });
    case "proposalResolved":
      return resolveProposal(state, event.proposalId, event.accepted);
    case "complete": {
      const tokens = state.usage ? undefined : turnTokens(event.usage);
      const next: AgentState = {
        ...state,
        running: false,
        stopRequested: false,
        status: "ready",
        statusMessage: `Ready · ${event.stopReason.replaceAll("_", " ")}`,
        ...(tokens !== undefined ? { turnUsage: { tokens } } : {}),
      };
      if (CARD_STOP_REASONS.includes(event.stopReason)) return addFeedItem(next, { kind: "stop", reason: event.stopReason, ...(event.hint ? { hint: event.hint } : {}) });
      if (event.stopReason === "cancelled") return addFeedItem(next, { kind: "note", text: (event.hint === "rejectedByUser" && hintText(event.hint)) || "Stopped" });
      const quiet = event.hint === "noOutputStreamed" ? hintText(event.hint) : undefined;
      return quiet ? addFeedItem(next, { kind: "note", text: quiet }) : next;
    }
    case "error":
      return {
        ...state,
        running: false,
        stopRequested: false,
        lastError: event.message,
        failure: { phase: state.sessionId ? "prompt" : "connect", message: event.message },
        ...(state.sessionId ? { status: "ready", statusMessage: errorStatus(event.message) } : {}),
      };
  }
  return state;
}

/** The status line after an error event: a limit says which, anything else stays generic. */
function errorStatus(message: string): string {
  const info = classifyAgentError({ message });
  return isLimitKind(info.kind) ? limitStatus(info) : "The last agent operation failed";
}

type ToolItem = Extract<FeedItem, { kind: "tool" }>;

/** True while a permission request for this tool call is open. */
const awaitsPermission = (feed: readonly FeedItem[], toolCallId: string) => feed.some((item) => item.kind === "permission" && !item.resolved && item.event.toolCallId === toolCallId);

/** While the user is asked, a running status is held back and the step stays pending (waiting). A final status always shows. */
function holdWhileAsking(item: DistributiveOmit<ToolItem, "id">, asking: boolean): ToolItem {
  const { deferredStatus, ...rest } = item as ToolItem;
  const status = rest.event.status;
  if (asking && status === "in_progress") return { ...rest, event: { ...rest.event, status: "pending" }, deferredStatus: status } as ToolItem;
  if (status === "pending" && deferredStatus) return { ...rest, deferredStatus } as ToolItem;
  return rest as ToolItem;
}

/** Shows the status held back while the permission was open, unless a newer one replaced it. */
function releaseHeld(item: ToolItem): ToolItem {
  const { deferredStatus, ...rest } = item;
  if (!deferredStatus) return item;
  return rest.event.status === "pending" ? { ...rest, event: { ...rest.event, status: deferredStatus } } : rest;
}

/** Forgets a child's open request, and the typed event that named it. */
export const dropRequest = (state: AgentState, requestId: string): AgentState => ({
  ...state,
  strayPermissions: state.strayPermissions.filter((item) => item.requestId !== requestId),
  childRequests: state.childRequests.filter((item) => item.requestId !== requestId),
});

/** The session a delegation event belongs to is the lead's. Events for another lead are ignored; unknown kinds change nothing. */
function reduceDelegation(state: AgentState, event: DelegationEvent): AgentState {
  if (!knownDelegation(event)) return state;
  const otherLead = (lead: SessionKey) => Boolean(state.sessionId && lead.sessionId !== state.sessionId);
  switch (event.kind) {
    case "attached":
      return { ...state, delegation: { attached: { sessionId: event.lead.sessionId, agentName: event.agentName } } };
    case "detached": {
      if (state.delegation.attached?.sessionId !== event.lead.sessionId) return state;
      const stopped = (item: FeedItem): FeedItem =>
        item.kind === "delegation" && !isFinished(item.task.status)
          ? { ...item, task: { ...item.task, status: "cancelled", reason: "cancelled", detail: "The lead session ended" } }
          : item;
      return { ...state, delegation: { ...state.delegation, attached: undefined }, feed: state.feed.map(stopped) };
    }
    case "unavailable":
      return { ...state, delegation: { unavailable: { agentName: event.agentName, reason: event.reason } } };
    case "decision": {
      if (otherLead(event.lead) || state.feed.some((item) => item.kind === "decision" && item.decision.id === event.decision.id)) return state;
      return addFeedItem(state, { kind: "decision", decision: event.decision });
    }
    case "childPermission": {
      // Only permission requests: an elicitation from a child is not offered in the permission dock.
      if (otherLead(event.lead) || event.requestKind !== "permission") return state;
      const request = { taskId: event.taskId ?? null, child: event.child, agentName: event.agentName, sessionId: event.sessionId, requestId: event.requestId };
      return { ...state, childRequests: [...state.childRequests.filter((item) => item.requestId !== event.requestId), request].slice(-STRAY_LIMIT) };
    }
    case "starting": {
      // No prompt: the user turned delegation on. The card makes the start visible.
      if (otherLead(event.lead)) return state;
      const placeholder = { taskId: `starting:${event.agentId}:${state.nextId}`, child: { connectionId: "", sessionId: "" }, agentName: event.agentId, status: "starting" as const, startingAgentId: event.agentId };
      return addFeedItem(state, { kind: "delegation", task: placeholder });
    }
    case "startFinished": {
      if (otherLead(event.lead)) return state;
      const index = state.feed.findIndex((item) => item.kind === "delegation" && item.task.status === "starting" && item.task.startingAgentId === event.agentId);
      if (event.reason) {
        if (index < 0) return state;
        const reason = event.reason;
        const detail = event.detail ?? undefined;
        return { ...state, feed: state.feed.map((item, at): FeedItem => (at === index && item.kind === "delegation" ? { ...item, task: { ...item.task, status: "failed", rawStatus: "failed", reason, detail } } : item)) };
      }
      const cleared = index < 0 ? state : { ...state, feed: state.feed.filter((_, at) => at !== index) };
      if (!event.launched) return cleared;
      const leadName = state.delegation.attached?.agentName || state.agent?.title || state.agent?.name || "the lead";
      return addFeedItem(cleared, { kind: "note", text: `Started ${event.agentName || event.agentId} for ${leadName}` });
    }
    case "delegated":
    case "taskFinished": {
      if (otherLead(event.lead)) return state;
      const patch = event.kind === "delegated" ? { taskId: event.taskId, child: event.child, agentName: event.agentName, model: event.model, deliverables: event.deliverables } : { taskId: event.taskId, child: event.child, status: event.status, reason: event.reason };
      return upsertTask(state, patch);
    }
  }
  return state;
}

function upsertTask(state: AgentState, patch: Parameters<typeof mergeTask>[1]): AgentState {
  const found = state.feed.some((item) => item.kind === "delegation" && item.task.taskId === patch.taskId);
  if (!found) return addFeedItem(state, { kind: "delegation", task: mergeTask(undefined, patch) });
  return mapFeed(state, (item) => (item.kind === "delegation" && item.task.taskId === patch.taskId ? { ...item, task: mergeTask(item.task, patch) } : item));
}

/** Folds a polled `agent_delegation_status` into the cards already in the feed, which adds the failure detail the events do not carry. */
export function applyDelegationStatus(state: AgentState, status: DelegationStatus): AgentState {
  if (status.lead && state.sessionId && status.lead.sessionId !== state.sessionId) return state;
  return status.tasks.reduce((current, task) => {
    if (!current.feed.some((item) => item.kind === "delegation" && item.task.taskId === task.taskId)) return current;
    return upsertTask(current, { taskId: task.taskId, child: task.child, agentName: task.agentName, model: task.model, status: task.status, reason: task.reason, stopReason: task.stopReason, detail: task.detail, startedAtMs: task.startedAtMs, finishedAtMs: task.finishedAtMs, progressText: task.progressText ?? null, resultSummary: task.resultSummary, artifacts: task.artifacts, budgetUsed: task.budgetUsed, deliverables: task.deliverables });
  }, state);
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
/** The feed record for a URL request. Keeps the provider and host only: never the message, the code or the query. */
function urlRecordFor(event: ElicitationEvent): Omit<Extract<FeedItem, { kind: "signin" }>, "id"> {
  const view = parseUrlRequest(event.message, event.url);
  return {
    kind: "signin",
    requestId: event.requestId,
    ...(event.elicitationId ? { elicitationId: event.elicitationId } : {}),
    ...(view.provider ? { provider: view.provider } : {}),
    host: view.host,
    status: view.rejection ? "cancelled" : "waiting",
    ...(view.rejection ? { reason: view.rejection } : {}),
  };
}

function mapUrlRecords(state: AgentState, change: (item: Extract<FeedItem, { kind: "signin" }>) => Extract<FeedItem, { kind: "signin" }>): AgentState {
  return mapFeed(state, (item) => (item.kind === "signin" ? change(item) : item));
}

/** The user opened the page and accepted: the record reads Opened until the agent says it finished. */
export function markUrlOpened(state: AgentState, requestId: string): AgentState {
  return mapUrlRecords(state, (item) => (item.requestId === requestId && !item.reason && (item.status === "waiting" || item.status === "cancelled") ? { ...item, status: "opened" } : item));
}

export function openPermission(feed: readonly FeedItem[]): Extract<FeedItem, { kind: "permission" }> | undefined {
  return feed.find((item): item is Extract<FeedItem, { kind: "permission" }> => item.kind === "permission" && !item.resolved);
}

/** True when the agent advertised a compact slash command. */
export const canCompact = (commands: readonly SlashCommand[]) => commands.some((command) => command.name.replace(/^\//, "") === "compact");
