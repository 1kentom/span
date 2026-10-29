/**
 * Pure helpers for the Agents page (ADR 0011 phase 3): the Editor or Agents mode per workspace, the sessions rail rows
 * and their grouping, rail keyboard movement, and the clamped widths of the rail and the side panel. Nothing here
 * talks to the backend; the page reads the agent controller and the live session list and hands plain values in.
 */
import type { LiveSession_Serialize as LiveSession, SessionMeta_Serialize as SessionMeta, SessionSummary } from "../bindings";
import type { RowStatus } from "./agent-chats";
import { listedTitle, sameFolder, threadRowMeta, visibleThreadRows, type Thread } from "./session-threads";

export type AgentMode = "editor" | "agents";

/**
 * Rail and side panel bounds. The rail is 200 to 420 (268 default) and only grows when the user drags it. The side
 * panel is at least 320 and at most half the window; until the user drags it, its width follows the window
 * (24 percent, from 420 to 760, the same as `--ap-side-default` in agents-page.css).
 */
export const RAIL_WIDTH = { min: 200, max: 420, initial: 268 } as const;
export const SIDE_WIDTH = { min: 320, initial: 420, wideMax: 760, share: 0.24, windowShare: 0.5 } as const;
/** From this window width the side panel opens by default only when it has something to show. */
export const WIDE_WINDOW = 2200;
/** The thread keeps at least this much width before the side panel gives way. */
export const THREAD_MIN = 560;
/** Below this window width the rail would leave the thread too little room (PR 2 turns it into an overlay). */
export const NARROW_WINDOW = 1100;
/** Idle sessions older than this sit under the collapsed Settled row. */
export const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const STORAGE_PREFIX = "span.agents.";

/** Storage that can throw (private windows, blocked site data) or be missing (tests, previews) reads as empty. */
function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function readStored(key: string): string | undefined {
  try {
    return storage()?.getItem(STORAGE_PREFIX + key) ?? undefined;
  } catch {
    return undefined;
  }
}
export function writeStored(key: string, value: string): void {
  try {
    storage()?.setItem(STORAGE_PREFIX + key, value);
  } catch {
    // A remembered layout is a convenience; failing to store it changes nothing else.
  }
}

/** The mode remembered for a workspace folder. No folder, or nothing stored, is Editor. */
export function readAgentMode(workspace: string | undefined): AgentMode {
  return workspace && readStored(`mode:${workspace}`) === "agents" ? "agents" : "editor";
}
export function writeAgentMode(workspace: string | undefined, mode: AgentMode): void {
  if (workspace) writeStored(`mode:${workspace}`, mode);
}

/**
 * Cmd+Shift+A on macOS, Ctrl+Shift+A elsewhere: toggles Editor and Agents. Handled in the webview, not through the
 * command table, because a new command id must also be added to `COMMAND_IDS` in crates/core (not rebindable yet).
 */
export function isAgentModeChord(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented">, platform: "mac" | "windows" | "linux"): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || !event.shiftKey) return false;
  const letter = event.code === "KeyA" || event.key.toLowerCase() === "a";
  return letter && (platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}
export const AGENT_MODE_SHORTCUT = { mac: "⌘⇧A", other: "Ctrl+Shift+A" } as const;

export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
/** A stored width, clamped, or the default when nothing valid is stored. */
export function readWidth(key: string, bounds: { min: number; max: number; initial: number }): number {
  const raw = Number(readStored(key));
  return raw > 0 ? clampWidth(raw, bounds.min, bounds.max) : bounds.initial;
}
/** The widest the side panel may be in a window: half the window, and never squeezing the thread under `THREAD_MIN`. */
export function sidePanelMax(windowWidth: number, railWidth: number): number {
  return clampWidth(Math.min(windowWidth * SIDE_WIDTH.windowShare, windowWidth - railWidth - THREAD_MIN - 32), SIDE_WIDTH.min, Number.POSITIVE_INFINITY);
}
/** The side panel width before the user resizes it: proportional to the window, 420 to 760. */
export function sidePanelDefault(windowWidth: number): number {
  return clampWidth(windowWidth * SIDE_WIDTH.share, SIDE_WIDTH.initial, SIDE_WIDTH.wideMax);
}
/**
 * Storage keys written only by a user action. The earlier `sideWidth` and `sideOpen` keys were written on every
 * mount, so they cannot tell a choice from the old default and are no longer read.
 */
export const SIDE_WIDTH_KEY = "sideWidthChosen";
export const SIDE_OPEN_KEY = "sideOpenChosen";
/** The side panel width the user dragged to, or undefined while it follows the window. */
export function readSideWidth(): number | undefined {
  const raw = Number(readStored(SIDE_WIDTH_KEY));
  return raw > 0 && Number.isFinite(raw) ? Math.max(SIDE_WIDTH.min, Math.round(raw)) : undefined;
}
/**
 * Whether the side panel shows when the user has not chosen. Up to `WIDE_WINDOW` it is open, as before; on a wider
 * window it opens only when there is something to show (proposed edits, delegated agents).
 */
export function sidePanelOpenByDefault(windowWidth: number, hasContent: boolean): boolean {
  return windowWidth <= WIDE_WINDOW || hasContent;
}

/** A rail row's state. "needs" waits for the user (approval, answer, sign-in), "failed" stopped on an error. */
export type RailState = "needs" | "failed" | "working" | "idle";

export type RailRow = {
  /** Unique in the rail: the session id, or connection plus session for a live session from another connection. */
  id: string;
  sessionId: string;
  connectionId?: string;
  title: string;
  /** Epoch milliseconds of the last activity, 0 when unknown. */
  updatedAt: number;
  state: RailState;
  statusText: string;
  agents: { id: string; name: string }[];
  delta?: { add: number; del: number };
  archived?: boolean;
  current?: boolean;
  /** Why the row cannot be focused from here. Absent when selecting it opens the thread. */
  unavailable?: string;
};

export type RailGroupId = "needs" | "working" | "recent";
export type RailGroup = { id: RailGroupId; label: string; rows: RailRow[] };
export type RailGroups = { groups: RailGroup[]; settled: RailRow[] };

const LABELS: Record<RailGroupId, string> = { needs: "Needs you", working: "Working", recent: "Recent" };

const newestFirst = (a: RailRow, b: RailRow) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);

/** Whether a row matches the search: its title or one of its agents, case-insensitive. An empty query matches all. */
export function railMatches(row: RailRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return row.title.toLowerCase().includes(needle) || row.agents.some((agent) => agent.name.toLowerCase().includes(needle));
}

/**
 * Groups rail rows: Needs you (waiting or failed), Working, Recent (idle and active within `RECENT_MS`, or the open
 * thread), and Settled (archived or older idle rows, shown collapsed). Each group is newest first; empty groups drop.
 */
export function groupRail(rows: readonly RailRow[], options: { query?: string; now: number }): RailGroups {
  const buckets: Record<RailGroupId, RailRow[]> = { needs: [], working: [], recent: [] };
  const settled: RailRow[] = [];
  for (const row of rows) {
    if (!railMatches(row, options.query ?? "")) continue;
    if (row.state === "needs" || row.state === "failed") buckets.needs.push(row);
    else if (row.state === "working") buckets.working.push(row);
    else if (!row.archived && (row.current || !(row.updatedAt > 0) || options.now - row.updatedAt <= RECENT_MS)) buckets.recent.push(row);
    else settled.push(row);
  }
  const groups = (Object.keys(buckets) as RailGroupId[]).map((id) => ({ id, label: LABELS[id], rows: buckets[id].sort(newestFirst) })).filter((group) => group.rows.length);
  return { groups, settled: settled.sort(newestFirst) };
}

/** Row ids in the order the rail shows them, Settled rows last when that section is open. */
export function railOrder(grouped: RailGroups, settledOpen: boolean): string[] {
  return [...grouped.groups.flatMap((group) => group.rows), ...(settledOpen ? grouped.settled : [])].map((row) => row.id);
}

/**
 * Roving focus in the rail: Arrow keys move one row and stop at the ends, Home and End jump. Returns the row id to
 * focus, or undefined for a key the rail does not handle.
 */
export function railNav(ids: readonly string[], current: string | undefined, key: string): string | undefined {
  if (!ids.length) return undefined;
  const at = current === undefined ? -1 : ids.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return ids[at < 0 ? 0 : Math.min(at + 1, ids.length - 1)];
    case "ArrowUp":
      return ids[at < 0 ? ids.length - 1 : Math.max(at - 1, 0)];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return undefined;
  }
}

/** A short relative time for a rail row: "now", "4m", "2h", "3d", or a short date past a week. Empty when unknown. */
export function railTime(updatedAt: number, now: number): string {
  if (!(updatedAt > 0)) return "";
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(updatedAt).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** A backend row state (agent-chats `rowStatus`) as a rail state. */
export function railStateOf(status: RowStatus | undefined): RailState {
  if (!status) return "idle";
  if (status.kind === "approval" || status.kind === "answer") return "needs";
  return status.kind === "running" ? "working" : "idle";
}

/** A live session's activity as a rail state and status line. */
export function liveRailState(session: Pick<LiveSession, "state" | "currentTool">): { state: RailState; statusText: string } {
  switch (session.state) {
    case "waitingForApproval":
      return { state: "needs", statusText: "Waiting for your approval" };
    case "waitingForAnswer":
      return { state: "needs", statusText: "Waiting for your answer" };
    case "running":
      return { state: "working", statusText: session.currentTool ? `Working · ${session.currentTool}` : "Working" };
    default:
      return { state: "idle", statusText: "Idle" };
  }
}

/** The open thread as the controller sees it, for its own rail row. */
export type CurrentThread = {
  sessionId?: string;
  title?: string;
  state: RailState;
  statusText: string;
  agents: { id: string; name: string }[];
};

export type RailInput = {
  /** The agent's session list for the folder (or every folder). */
  listed: readonly SessionSummary[];
  metas: readonly SessionMeta[];
  agentId: string | undefined;
  threadFor: (sessionId: string) => Thread;
  statusOf: (sessionId: string) => RowStatus | undefined;
  /** The connected agent, the one agent known for a listed row without metadata. */
  brand?: { id: string; name: string };
  current: CurrentThread;
  /** Every live session the backend holds (`agent_live_sessions`). Only user leads become rows. */
  live: readonly LiveSession[];
  /** The connection the sidebar is focused on. Live sessions on another connection cannot be focused from here yet. */
  focusedConnection?: string;
  workspace?: string;
  /** False when the agent cannot load sessions, so listed rows Span does not hold cannot be reopened. */
  canLoad: boolean;
  now: number;
};

/**
 * One row per thread: the agent's listed sessions (one row per chat thread, as History shows them), the open thread
 * even before the agent lists it, and live user sessions of other connections. Facts come from what Span already
 * holds (session metadata, backend states, the live list); nothing is invented.
 */
export function railRows(input: RailInput): RailRow[] {
  const rows: RailRow[] = [];
  const seen = new Set<string>();
  const shown = new Set(visibleThreadRows(input.listed.map((session) => session.sessionId), input.metas, input.agentId));
  for (const session of input.listed) {
    if (!shown.has(session.sessionId) || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    const stored = threadRowMeta(input.threadFor(session.sessionId));
    const isCurrent = session.sessionId === input.current.sessionId;
    const status = input.statusOf(session.sessionId);
    const inWorkspace = sameFolder(session.cwd, input.workspace);
    const state = isCurrent ? input.current.state : railStateOf(status);
    const agents = stored.agents.length ? stored.agents : input.brand ? [input.brand] : [];
    rows.push({
      id: session.sessionId,
      sessionId: session.sessionId,
      title: (isCurrent ? input.current.title : undefined) || stored.title || listedTitle(session.title) || "Untitled session",
      updatedAt: isCurrent ? input.now : (session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0),
      state,
      statusText: isCurrent ? input.current.statusText : status?.label ?? (stored.delta ? "Done" : "Idle"),
      agents: isCurrent && input.current.agents.length ? input.current.agents : agents,
      delta: stored.delta,
      archived: stored.archived,
      current: isCurrent || undefined,
      unavailable: !inWorkspace ? "This session belongs to another folder" : !input.canLoad && !status && !isCurrent ? "This agent cannot reopen earlier sessions" : undefined,
    });
  }
  if (input.current.sessionId && !seen.has(input.current.sessionId)) {
    seen.add(input.current.sessionId);
    rows.push({ id: input.current.sessionId, sessionId: input.current.sessionId, title: input.current.title || "New session", updatedAt: input.now, state: input.current.state, statusText: input.current.statusText, agents: input.current.agents, current: true });
  }
  for (const session of input.live) {
    if (session.origin !== "user" || session.parent || seen.has(session.key.sessionId)) continue;
    const other = Boolean(input.focusedConnection) && session.key.connectionId !== input.focusedConnection;
    const id = other ? `${session.key.connectionId}/${session.key.sessionId}` : session.key.sessionId;
    if (seen.has(id)) continue;
    seen.add(id);
    const { state, statusText } = liveRailState(session);
    rows.push({
      id,
      sessionId: session.key.sessionId,
      connectionId: session.key.connectionId,
      title: listedTitle(session.title) || "Untitled session",
      updatedAt: session.startedAtMs ?? 0,
      state,
      statusText,
      agents: [{ id: session.agentId ?? session.agentName, name: session.agentName }],
      unavailable: other ? "Runs on another agent connection. Open it from that agent's sidebar" : undefined,
    });
  }
  return rows;
}

/** The thread's own state for its rail row and header, from what the controller holds. */
export function currentThreadState(input: { running: boolean; waiting: "approval" | "answer" | undefined; failed: boolean; stopping?: boolean; connected: boolean; queued: number }): { state: RailState; statusText: string } {
  const queued = input.queued > 0 ? ` · ${input.queued} queued` : "";
  if (input.waiting === "approval") return { state: "needs", statusText: `Waiting for your approval${queued}` };
  if (input.waiting === "answer") return { state: "needs", statusText: `Waiting for your answer${queued}` };
  if (input.failed) return { state: "failed", statusText: "Stopped on an error" };
  if (input.running) return { state: "working", statusText: `${input.stopping ? "Stopping" : "Working"}${queued}` };
  return { state: "idle", statusText: input.connected ? `Idle${queued}` : "Not connected" };
}

/** One installed agent in the rail's Plan limits footer. */
export type PlanLimit = { id: string; name: string; limited: boolean; resetAt?: number; models: string[] };

/**
 * The Plan limits footer: the first `max` installed agents (the connected one first), each with the models Span saw
 * hit a usage limit and the earliest known reset. Agents report no plan usage over ACP, so an agent without a limit
 * reads as "no limit reported", never as a made-up percentage.
 */
export function planLimits(installed: readonly { id: string; name: string }[], limitedModels: Readonly<Record<string, number>>, connectedId: string | undefined, max = 3): PlanLimit[] {
  const ordered = [...installed].sort((a, b) => Number(b.id === connectedId) - Number(a.id === connectedId));
  return ordered.slice(0, max).map((agent) => {
    const prefix = `${agent.id}\n`;
    const entries = Object.entries(limitedModels).filter(([key]) => key.startsWith(prefix));
    const resets = entries.map(([, at]) => at).filter((at) => at > 0);
    return { id: agent.id, name: agent.name, limited: entries.length > 0, resetAt: resets.length ? Math.min(...resets) : undefined, models: entries.map(([key]) => key.slice(prefix.length)) };
  });
}

/** "resets in 2h 5m", "resets in 40m", "reset time unknown". */
export function resetText(resetAt: number | undefined, now: number): string {
  if (!resetAt) return "reset time unknown";
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${hours}h`;
}
