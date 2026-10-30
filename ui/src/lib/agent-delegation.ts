import type { Artifact, DecisionRecord, DelegationEvent, Deliverables_Deserialize, FailureReason, SessionKey, UsageReport_Deserialize } from "../bindings";
import type { PermissionEvent } from "./agent-session";

/** Delegation view data. Everything here comes from DelegationEvent or DelegationStatus; nothing is inferred. */

/** `starting`: Span is starting the installed agent before the task exists. */
export type DelegationStatusKind = "starting" | "queued" | "running" | "needs_user" | "completed" | "failed" | "cancelled" | "lost" | "unknown";

/** One delegated task as the feed shows it. Timing, progress, result and budget arrive with the polled status and are absent until then. */
export type DelegationTaskState = {
  taskId: string;
  child: SessionKey;
  /** Absent only when the task finished before the "delegated" event arrived. */
  agentName?: string;
  /** Display name of the model the child runs, when the agent reported one. */
  model?: string;
  status: DelegationStatusKind;
  /** The backend's status string, kept for a status Span does not know. */
  rawStatus?: string;
  reason?: FailureReason;
  stopReason?: string;
  detail?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  progressText?: string;
  resultSummary?: string;
  artifacts?: Artifact[];
  budgetUsed?: UsageReport_Deserialize;
  /** Set on the placeholder card shown while Span starts this installed agent. */
  startingAgentId?: string;
  /** What the lead expects back (files and summary format), as the lead asked for it. */
  deliverables?: Deliverables_Deserialize;
  /** The `delegate_many` batch the task belongs to. */
  groupId?: string;
  /** The child waits for the user (a permission, a question or an edit review), as the polled status reports it. */
  waitingForUser?: boolean;
};

/** The delegation facts the session keeps outside the feed. */
export type DelegationNote = {
  /** The lead session that has the span-agents tools, from the "attached" event. */
  attached?: { sessionId: string; agentName: string };
  /** Delegation is enabled but this connection does not get the tools. */
  unavailable?: { agentName: string; reason: string };
};

/** One table for every failure reason the backend can report. */
export const FAILURE_TEXT: Record<FailureReason, string> = {
  auth_required: "The agent needs you to sign in",
  permission_rejected: "You rejected a permission or edit",
  refused: "The agent declined the task",
  cancelled: "Cancelled",
  output_limit: "The agent hit its output limit",
  agent_unavailable: "The agent could not be reached",
  depth_exceeded: "Delegation depth limit reached",
  budget_exceeded: "The task used up its budget",
  timeout: "The task timed out",
  lost: "The child session is gone",
  permission_required: "Stopped at a permission request (the lead asked to fail instead of waiting)",
  mode_unavailable: "The agent has no mode this task may run in",
  worktree_unavailable: "Worktrees are not available yet",
};

export function failureText(reason: FailureReason | string | null | undefined): string | undefined {
  if (!reason) return undefined;
  return (FAILURE_TEXT as Record<string, string>)[reason] ?? `Failed (${reason})`;
}

/** Maps the backend status string (`queued`, `running`, `completed`, `failed`) plus its failure reason. */
export function taskStatusKind(raw: string, reason?: FailureReason | null): DelegationStatusKind {
  if (raw === "queued" || raw === "running" || raw === "completed") return raw;
  if (raw === "cancelled") return "cancelled";
  if (raw === "lost") return "lost";
  if (raw === "failed") return reason === "cancelled" ? "cancelled" : "failed";
  return "unknown";
}

export const STATUS_TEXT: Record<DelegationStatusKind, string> = {
  starting: "Starting",
  queued: "Queued",
  running: "Running",
  needs_user: "Needs you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  lost: "Lost",
  unknown: "Finished",
};

const optional = <T,>(value: T | null | undefined) => (value === null || value === undefined ? undefined : value);

export type TaskPatch = {
  taskId: string;
  child: SessionKey;
  agentName?: string;
  model?: string | null;
  status?: string;
  reason?: FailureReason | null;
  stopReason?: string | null;
  detail?: string | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  /** Present with null when the child reported no activity: that clears an earlier line. */
  progressText?: string | null;
  resultSummary?: string | null;
  artifacts?: Artifact[] | null;
  budgetUsed?: UsageReport_Deserialize | null;
  deliverables?: Deliverables_Deserialize | null;
  groupId?: string | null;
  waitingForUser?: boolean | null;
};

/** Merges a report about one task into what is known. A late "delegated" event never moves a finished task back to running. */
export function mergeTask(previous: DelegationTaskState | undefined, patch: TaskPatch): DelegationTaskState {
  const reason = optional(patch.reason) ?? previous?.reason;
  const base: DelegationTaskState = previous ?? { taskId: patch.taskId, child: patch.child, status: "running" };
  const next: DelegationTaskState = { ...base, child: patch.child };
  if (patch.agentName) next.agentName = patch.agentName;
  if (patch.model) next.model = patch.model;
  if (patch.status !== undefined) {
    next.status = taskStatusKind(patch.status, reason);
    next.rawStatus = patch.status;
  }
  if (reason) next.reason = reason;
  const stop = optional(patch.stopReason);
  if (stop) next.stopReason = stop;
  const detail = optional(patch.detail);
  if (detail) next.detail = detail;
  if (typeof patch.startedAtMs === "number") next.startedAtMs = patch.startedAtMs;
  if (typeof patch.finishedAtMs === "number") next.finishedAtMs = patch.finishedAtMs;
  if (patch.progressText !== undefined) next.progressText = patch.progressText || undefined;
  if (patch.resultSummary !== undefined) next.resultSummary = patch.resultSummary || undefined;
  if (patch.artifacts) next.artifacts = patch.artifacts;
  if (patch.budgetUsed) next.budgetUsed = patch.budgetUsed;
  if (patch.deliverables) next.deliverables = patch.deliverables;
  if (patch.groupId) next.groupId = patch.groupId;
  if (typeof patch.waitingForUser === "boolean") next.waitingForUser = patch.waitingForUser;
  return next;
}

export const isFinished = (status: DelegationStatusKind) => status === "completed" || status === "failed" || status === "cancelled" || status === "lost" || status === "unknown";

/** The status a card shows: a running task whose child waits for the user (an open request in the dock, or the polled flag) reads "Needs you". */
export function cardStatus(task: Pick<DelegationTaskState, "status" | "waitingForUser">, waiting: boolean): DelegationStatusKind {
  return task.status === "running" && (waiting || task.waitingForUser) ? "needs_user" : task.status;
}

/** How far a `delegate_many` batch got: finished tasks of the group over all its tasks. Absent for a task outside a batch. */
export function groupProgress(tasks: readonly DelegationTaskState[], groupId: string | undefined): { done: number; total: number } | undefined {
  if (!groupId) return undefined;
  const members = tasks.filter((task) => task.groupId === groupId);
  if (!members.length) return undefined;
  return { done: members.filter((task) => isFinished(task.status)).length, total: members.length };
}

export type DecisionView = { by: string; chosen: string; why: string; alternatives: string[] };
export const decisionView = (decision: DecisionRecord, by: string): DecisionView => ({ by, chosen: decision.chosen, why: decision.why, alternatives: decision.alternatives.filter((item) => item.trim()) });

/** "Summary, files: a.md, b.rs": what the lead asked the child to hand back. Absent when it asked for nothing. */
export function deliverablesText(deliverables: Deliverables_Deserialize | undefined): string | undefined {
  if (!deliverables) return undefined;
  const format = deliverables.format ? { summary: "Summary", diff: "Diff", json: "JSON" }[deliverables.format] ?? deliverables.format : undefined;
  const files = deliverables.files.length ? `files: ${deliverables.files.join(", ")}` : undefined;
  return [format, files].filter(Boolean).join(", ") || undefined;
}

export const alternativesLabel = (count: number) => `${count} ${count === 1 ? "alternative" : "alternatives"} considered`;

/** What the card says under the header, from the reported reason and detail only. */
export function taskNote(task: DelegationTaskState): string | undefined {
  if (task.status === "failed") return [failureText(task.reason) ?? "The task failed", task.detail].filter(Boolean).join(". ");
  if (task.status === "cancelled") return task.detail ?? failureText(task.reason);
  if (task.status === "lost") return [failureText("lost"), task.detail].filter(Boolean).join(". ");
  if (task.status === "unknown") return task.rawStatus ? `Status reported: ${task.rawStatus}` : undefined;
  return undefined;
}

/**
 * A quiet note for a task that finished normally while its delegation spent more than its token budget, for example
 * "Used about 1500 tokens, over the 1000 token budget". The backend only sets a completed task's detail for this, and
 * such a task is never a failure.
 */
export function budgetNote(task: DelegationTaskState): string | undefined {
  return task.status === "completed" ? task.detail : undefined;
}

/** The status line near the composer: only when the agent cannot get the delegation tools. Working delegation shows no text. */
export function delegationLine(note: DelegationNote, _sessionId: string | undefined): { tone: "warn"; text: string } | undefined {
  if (note.unavailable) return { tone: "warn", text: `Delegation unavailable: ${note.unavailable.reason}` };
  return undefined;
}

/** What a typed `childPermission` delegation event says about one request. */
export type ChildRequest = { taskId: string | null; child: SessionKey; agentName: string; sessionId: string; requestId: string };

export type ChildPermission = { event: PermissionEvent; child: SessionKey; agentName: string; /** The task the child was running, when the typed event named one. */ taskId?: string | null };

/**
 * Open permission requests from delegated children, oldest first. A request is a child's when a typed `childPermission`
 * event names its request id and session; the typed event supplies the child key and agent name. Without one, only a
 * session that a delegation card already names qualifies. A request from any other session is never offered.
 */
export function childPermissions(stray: readonly PermissionEvent[], tasks: readonly DelegationTaskState[], typed: readonly ChildRequest[] = []): ChildPermission[] {
  return stray.flatMap((event) => {
    const request = typed.find((item) => item.requestId === event.requestId && item.sessionId === event.sessionId);
    if (request) {
      const task = request.taskId ? tasks.find((item) => item.taskId === request.taskId) : undefined;
      return [{ event, child: request.child, agentName: request.agentName || task?.agentName || "Delegated agent", taskId: request.taskId }];
    }
    const task = tasks.find((item) => item.child.sessionId === event.sessionId);
    return task ? [{ event, child: task.child, agentName: task.agentName ?? "Delegated agent", taskId: task.taskId }] : [];
  });
}

/** True when the open request belongs to this task: by the typed task id, else by the child session. */
export const permissionWaitsOn = (entry: ChildPermission, task: DelegationTaskState) => (entry.taskId ? entry.taskId === task.taskId : entry.child.sessionId === task.child.sessionId);

const SUMMARY_LIMIT = 600;
/** The result text as plain text, cut to a fixed length. It is rendered as a text node, never as HTML. */
export const boundedSummary = (text: string | undefined) => {
  const value = text?.trim();
  if (!value) return undefined;
  return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT).trimEnd()}...` : value;
};

/** Elapsed milliseconds: finish minus start, or time since start while the task has not finished. Absent without a start. */
export function taskElapsedMs(task: Pick<DelegationTaskState, "startedAtMs" | "finishedAtMs" | "status">, now: number): number | undefined {
  if (typeof task.startedAtMs !== "number") return undefined;
  if (typeof task.finishedAtMs === "number") return Math.max(0, task.finishedAtMs - task.startedAtMs);
  return isFinished(task.status) ? undefined : Math.max(0, now - task.startedAtMs);
}

/** Budget used so far, from reported figures only. The elapsed seconds are left out: they keep counting after a task ends. */
export function budgetText(budget: UsageReport_Deserialize | undefined): string | undefined {
  if (!budget) return undefined;
  const parts: string[] = [];
  if (budget.turns > 0) parts.push(`${budget.turns} ${budget.turns === 1 ? "turn" : "turns"}`);
  // With a window size the figure is context occupancy (system prompt and tools included), not what the task spent.
  if (typeof budget.tokens === "number") parts.push(`${budget.tokens.toLocaleString("en-US")} tokens${typeof budget.contextSize === "number" ? " in context" : ""}`);
  if (typeof budget.cost === "number") parts.push(`${budget.currency ?? ""} ${budget.cost.toFixed(2)}`.trim());
  return parts.length ? parts.join(", ") : undefined;
}

/** Narrows a delegation event kind the reducer does not know to nothing. */
export const knownDelegation = (event: DelegationEvent) => ["decision", "delegated", "taskFinished", "childPermission", "attached", "detached", "unavailable", "starting", "startFinished"].includes((event as { kind: string }).kind);
