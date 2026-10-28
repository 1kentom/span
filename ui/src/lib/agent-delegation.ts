import type { DecisionRecord, DelegationEvent, FailureReason, SessionKey } from "../bindings";
import type { PermissionEvent } from "./agent-session";

/** Delegation view data. Everything here comes from DelegationEvent or DelegationStatus; nothing is inferred. */

export type DelegationStatusKind = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

/** One delegated task as the feed shows it. Fields the backend does not report (timing, progress, results, budget) are not modelled. */
export type DelegationTaskState = {
  taskId: string;
  child: SessionKey;
  /** Absent only when the task finished before the "delegated" event arrived. */
  agentName?: string;
  status: DelegationStatusKind;
  /** The backend's status string, kept for a status Span does not know. */
  rawStatus?: string;
  reason?: FailureReason;
  stopReason?: string;
  detail?: string;
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
};

export function failureText(reason: FailureReason | string | null | undefined): string | undefined {
  if (!reason) return undefined;
  return (FAILURE_TEXT as Record<string, string>)[reason] ?? `Failed (${reason})`;
}

/** Maps the backend status string (`queued`, `running`, `completed`, `failed`) plus its failure reason. */
export function taskStatusKind(raw: string, reason?: FailureReason | null): DelegationStatusKind {
  if (raw === "queued" || raw === "running" || raw === "completed") return raw;
  if (raw === "cancelled") return "cancelled";
  if (raw === "failed") return reason === "cancelled" ? "cancelled" : "failed";
  return "unknown";
}

export const STATUS_TEXT: Record<DelegationStatusKind, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Finished",
};

const optional = <T,>(value: T | null | undefined) => (value === null || value === undefined ? undefined : value);

export type TaskPatch = { taskId: string; child: SessionKey; agentName?: string; status?: string; reason?: FailureReason | null; stopReason?: string | null; detail?: string | null };

/** Merges a report about one task into what is known. A late "delegated" event never moves a finished task back to running. */
export function mergeTask(previous: DelegationTaskState | undefined, patch: TaskPatch): DelegationTaskState {
  const reason = optional(patch.reason) ?? previous?.reason;
  const base: DelegationTaskState = previous ?? { taskId: patch.taskId, child: patch.child, status: "running" };
  const next: DelegationTaskState = { ...base, child: patch.child };
  if (patch.agentName) next.agentName = patch.agentName;
  if (patch.status !== undefined) {
    next.status = taskStatusKind(patch.status, reason);
    next.rawStatus = patch.status;
  }
  if (reason) next.reason = reason;
  const stop = optional(patch.stopReason);
  if (stop) next.stopReason = stop;
  const detail = optional(patch.detail);
  if (detail) next.detail = detail;
  return next;
}

export const isFinished = (status: DelegationStatusKind) => status === "completed" || status === "failed" || status === "cancelled" || status === "unknown";

export type DecisionView = { by: string; chosen: string; why: string; alternatives: string[] };
export const decisionView = (decision: DecisionRecord, by: string): DecisionView => ({ by, chosen: decision.chosen, why: decision.why, alternatives: decision.alternatives.filter((item) => item.trim()) });

export const alternativesLabel = (count: number) => `${count} ${count === 1 ? "alternative" : "alternatives"} considered`;

/** What the card says under the header, from the reported reason and detail only. */
export function taskNote(task: DelegationTaskState): string | undefined {
  if (task.status === "failed") return [failureText(task.reason) ?? "The task failed", task.detail].filter(Boolean).join(". ");
  if (task.status === "cancelled") return task.detail ?? failureText(task.reason);
  if (task.status === "unknown") return task.rawStatus ? `Status reported: ${task.rawStatus}` : undefined;
  return undefined;
}

/** The status line near the composer: only when the tools are attached to this session or the agent cannot get them. */
export function delegationLine(note: DelegationNote, sessionId: string | undefined): { tone: "on" | "warn"; text: string } | undefined {
  if (note.attached && sessionId && note.attached.sessionId === sessionId) return { tone: "on", text: "Delegation on" };
  if (note.unavailable) return { tone: "warn", text: `Delegation unavailable: ${note.unavailable.reason}` };
  return undefined;
}

export type ChildPermission = { event: PermissionEvent; child: SessionKey; agentName: string };

/** Open permission requests from sessions Span knows as delegated children. Requests from any other session are never offered. */
export function childPermissions(stray: readonly PermissionEvent[], tasks: readonly DelegationTaskState[]): ChildPermission[] {
  return stray.flatMap((event) => {
    const task = tasks.find((item) => item.child.sessionId === event.sessionId);
    return task ? [{ event, child: task.child, agentName: task.agentName ?? "Delegated agent" }] : [];
  });
}

/** Narrows a delegation event kind the reducer does not know to nothing. */
export const knownDelegation = (event: DelegationEvent) => ["decision", "delegated", "taskFinished", "attached", "detached", "unavailable"].includes((event as { kind: string }).kind);
