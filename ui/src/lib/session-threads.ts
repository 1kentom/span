import type { SessionLink_Serialize as SessionLink, SessionMeta_Serialize as SessionMeta, Transcript_Deserialize as Transcript, TranscriptItem_Deserialize as TranscriptItem } from "../bindings";
import type { FeedItem } from "./agent-session";
import { toolLocations, workspaceRelative } from "./agent-view";

/**
 * Chat threads for History (ADR 0005, thread links). An ACP session belongs to one agent process, so a chat that
 * switches agent continues in a new session. The new session's metadata stores `continues`, a link to the session it
 * came from. Following those links gives the thread: every segment, oldest first. History shows one row per thread
 * with every provider and model used, and hides an earlier segment when its continuation is listed too.
 */

export type Thread = { segments: SessionMeta[]; links: SessionLink[] };

/** Longest chain followed. A thread longer than this is cut, never looped. */
const MAX_SEGMENTS = 32;

/**
 * The stored metadata for a session: the exact `(agentId, sessionId)` key, else the one entry with that session id.
 * The fallback covers one agent reached through two catalog entries (a preset and a registry entry of the same
 * adapter list the same sessions), where the session was recorded under the other id.
 */
function findMeta(metas: readonly SessionMeta[], agentId: string | undefined, sessionId: string): SessionMeta | undefined {
  const exact = agentId ? metas.find((entry) => entry.agentId === agentId && entry.sessionId === sessionId) : undefined;
  if (exact) return exact;
  const loose = metas.filter((entry) => entry.sessionId === sessionId);
  return loose.length === 1 ? loose[0] : undefined;
}

const key = (meta: { agentId: string; sessionId: string }) => `${meta.agentId}\u0000${meta.sessionId}`;

/** The session that continues `meta`, if one was recorded. */
const successorOf = (metas: readonly SessionMeta[], meta: SessionMeta) =>
  metas.find((entry) => entry.continues && entry.continues.sessionId === meta.sessionId && entry.continues.agentId === meta.agentId) ??
  metas.find((entry) => entry.continues && entry.continues.sessionId === meta.sessionId);

/** Every segment of the thread that holds the session, oldest first. Empty when Span has no metadata for it. */
export function threadOf(metas: readonly SessionMeta[], agentId: string | undefined, sessionId: string): Thread {
  const start = findMeta(metas, agentId, sessionId);
  if (!start) return { segments: [], links: [] };
  const seen = new Set([key(start)]);
  const segments = [start];
  for (let at = start; at.continues && segments.length < MAX_SEGMENTS; ) {
    const previous = findMeta(metas, at.continues.agentId, at.continues.sessionId);
    if (!previous || seen.has(key(previous))) break;
    seen.add(key(previous));
    segments.unshift(previous);
    at = previous;
  }
  for (let at = start; segments.length < MAX_SEGMENTS; ) {
    const next = successorOf(metas, at);
    if (!next || seen.has(key(next))) break;
    seen.add(key(next));
    segments.push(next);
    at = next;
  }
  return { segments, links: segments.flatMap((segment) => (segment.continues ? [segment.continues] : [])) };
}

/** The label of a model chip: name, effort, and the subagent marker for a delegated child's model. */
export const modelLabel = (model: SessionMeta["models"][number]) => [model.name.trim(), model.effort?.trim(), model.subagent ? "subagent" : ""].filter(Boolean).join(" · ");

export type ThreadRowMeta = {
  title?: string;
  agents: { id: string; name: string }[];
  models: string[];
  files?: number;
  delta?: { add: number; del: number };
  /** Every segment was tracked and changed nothing. */
  noChanges?: true;
  archived: boolean;
};

/**
 * What a History row shows for a thread: the providers in the order they joined, the model chips of every segment,
 * the newest user title (else the title the chat had when it switched agent), and the counters summed over segments.
 * Zero and empty mean unknown in the store, so they produce nothing.
 */
export function threadRowMeta(thread: Thread): ThreadRowMeta {
  const agents: ThreadRowMeta["agents"] = [];
  const models: string[] = [];
  const addAgent = (id: string, name: string) => {
    if (name.trim() && !agents.some((agent) => agent.id === id)) agents.push({ id, name: name.trim() });
  };
  for (const segment of thread.segments) {
    addAgent(segment.agentId, segment.connectionName);
    for (const agent of segment.agents) addAgent(agent.agentId, agent.name);
    for (const model of segment.models) {
      const label = modelLabel(model);
      if (model.name.trim() && !models.includes(label)) models.push(label);
    }
  }
  const newestFirst = [...thread.segments].reverse();
  const title = newestFirst.map((segment) => segment.titleOverride?.trim()).find(Boolean) ?? [...thread.links].reverse().map((link) => link.title?.trim()).find(Boolean);
  const files = thread.segments.reduce((sum, segment) => sum + Math.max(0, segment.filesChanged), 0);
  const add = thread.segments.reduce((sum, segment) => sum + Math.max(0, segment.linesAdded), 0);
  const del = thread.segments.reduce((sum, segment) => sum + Math.max(0, segment.linesRemoved), 0);
  const tracked = thread.segments.length > 0 && thread.segments.every((segment) => segment.changesTracked);
  return {
    ...(title ? { title } : {}),
    agents,
    models,
    ...(files > 0 ? { files } : {}),
    ...(add > 0 || del > 0 ? { delta: { add, del } } : {}),
    ...(tracked && files === 0 && add === 0 && del === 0 ? { noChanges: true as const } : {}),
    archived: Boolean(newestFirst[0]?.archived),
  };
}

/**
 * The listed sessions History shows, in order: an earlier segment is left out when a later segment of its thread is
 * listed as well, so a chat that switched agent appears once. A delegated child (its metadata has a `parent` link to
 * the lead) is never a row of its own: it belongs to the lead's thread, where its delegation card shows it (ADR 0003).
 */
export function visibleThreadRows(listed: readonly string[], metas: readonly SessionMeta[], agentId: string | undefined): string[] {
  const present = new Set(listed);
  const children = new Set(metas.filter((entry) => entry.parent).map((entry) => entry.sessionId));
  return listed.filter((id) => {
    if (children.has(id)) return false;
    const { segments } = threadOf(metas, agentId, id);
    const own = segments.findIndex((segment) => segment.sessionId === id);
    return own < 0 || !segments.slice(own + 1).some((later) => present.has(later.sessionId));
  });
}

/**
 * What an agent titles a Span health check session (ADR 0010; the prompt is "Health check. Reply with exactly one
 * word: OK", and agents may cut it short). Matches HEALTH_TITLE_PREFIX in crates/acp. A chat that merely starts with
 * "Health check" is the user's and is never matched.
 */
const HEALTH_TITLE_PREFIX = "Health check. Reply with exactly one word";

/**
 * Whole titles an agent regenerated for an old health check session from the exchange (ADR 0010, amendment). Matches
 * RENAMED_HEALTH_TITLES in crates/acp: the whole trimmed title, case insensitive, one trailing period allowed. Nothing
 * broader, so "Health check of the CI pipeline" or "Health checks for k8s" stay.
 */
const RENAMED_HEALTH_TITLES = new Set([
  "health check",
  "health check response",
  "health check response request",
  "health check reply",
  "health check request",
  "health check result",
  "health check ping",
  "health check one word",
  "one-word health check",
  "health check status",
]);

/**
 * True for a title an agent regenerated for an old health check session. A user may name a chat exactly "Health
 * check", so when the listing reports a message count only a session of at most two messages matches.
 */
export function isRenamedHealthTitle(title: string | null | undefined, messageCount?: number | null): boolean {
  if (typeof messageCount === "number" && messageCount > 2) return false;
  const text = title?.trim();
  if (!text) return false;
  return RENAMED_HEALTH_TITLES.has((text.endsWith(".") ? text.slice(0, -1) : text).toLowerCase());
}

/** True for a session Span opened for its health check: never shown in History, never resumed, never counted. */
export function isHealthCheckSession(session: { title?: string | null; messageCount?: number | null }): boolean {
  return Boolean(session.title?.trimStart().startsWith(HEALTH_TITLE_PREFIX)) || isRenamedHealthTitle(session.title, session.messageCount);
}

/** The header Span puts ahead of carried context (agent-handoff.ts). An agent that titles a session by its first prompt shows it. */
const CARRIED_PREFIX = "[Context from an earlier session";

/** An agent's session title, trimmed, or undefined when empty or just the carried context header. */
export function listedTitle(title: string | null | undefined): string | undefined {
  const text = title?.trim();
  return text && !text.startsWith(CARRIED_PREFIX) ? text : undefined;
}

/** Whether a session's folder is the workspace. Unknown counts as the workspace (the agent was asked for it). */
export function sameFolder(cwd: string | null | undefined, workspace: string | undefined): boolean {
  if (!cwd || !workspace) return true;
  const windows = (path: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(path);
  const norm = (path: string) => {
    const unified = windows(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
    return unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
  };
  return norm(cwd) === norm(workspace);
}

/** The last path component, for "In <folder>" on a row from another folder. */
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Lines added and removed between two texts, like a line diff (the Rust store counts the same way). */
export function hunkLineDelta(before: string, after: string): { add: number; del: number } {
  const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // Longest common subsequence of the changed middle. Very large hunks count every middle line as changed.
  if (!midA.length || !midB.length || midA.length * midB.length > 1_000_000) return { add: midB.length, del: midA.length };
  let previous = new Array<number>(midB.length + 1).fill(0);
  for (const lineA of midA) {
    const row = new Array<number>(midB.length + 1).fill(0);
    for (let j = 0; j < midB.length; j += 1) row[j + 1] = lineA === midB[j] ? previous[j] + 1 : Math.max(previous[j + 1], row[j]);
    previous = row;
  }
  const common = previous[midB.length];
  return { add: midB.length - common, del: midA.length - common };
}

const EDIT_KINDS = ["edit", "delete", "move"];

/**
 * True when the feed shows a file change that did not go through Span's review: a completed edit tool call on a path
 * with no proposal (the agent wrote the file itself). Then the counters miss it and "No changes" would be wrong.
 */
export function hasUntrackedEdits(feed: readonly FeedItem[], root?: string): boolean {
  const norm = (path: string) => workspaceRelative(root, path) ?? path;
  const reviewed = new Set(feed.flatMap((item) => (item.kind === "proposal" ? [norm(item.proposal.path)] : [])));
  return feed.some((item) => {
    if (item.kind !== "tool" || !EDIT_KINDS.includes(item.event.toolKind ?? "") || item.event.status !== "completed") return false;
    const typed = item.event.locations ?? [];
    const paths = [...(item.event.diffs ?? []).map((diff) => diff.path), ...(typed.length ? typed : toolLocations(item.event.contentJson ?? "")).map((location) => location.path)];
    return !paths.length || paths.some((path) => !reviewed.has(norm(path)));
  });
}

/**
 * The open chat as a transcript for Export as Markdown. Carried context is left out (it repeats earlier turns), a
 * rejected proposal changed nothing, and permission or request cards are not part of the record.
 */
export function exportTranscript(title: string, feed: readonly FeedItem[]): Transcript {
  const items: TranscriptItem[] = [];
  for (const item of feed) {
    switch (item.kind) {
      case "user":
        items.push({ kind: "user", text: item.text });
        break;
      case "text":
        items.push({ kind: "agent", text: item.text });
        break;
      case "thought":
        items.push({ kind: "thought", text: item.text });
        break;
      case "tool":
        items.push({ kind: "tool", title: item.event.title?.trim() || item.event.toolKind || "Tool call", status: item.event.status ?? null });
        for (const diff of item.event.diffs ?? []) items.push({ kind: "diff", path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText });
        break;
      case "proposal":
        if (item.resolution === "accepted") for (const hunk of item.proposal.hunks) items.push({ kind: "diff", path: item.proposal.path, oldText: hunk.before, newText: hunk.after });
        break;
      case "handoff":
        items.push({ kind: "notice", text: `Switched from ${item.from} to ${item.to}.` });
        break;
      case "note":
        items.push({ kind: "notice", text: item.text });
        break;
      case "notice":
        items.push({ kind: "notice", text: item.description ? `${item.title}: ${item.description}` : item.title });
        break;
      default:
        break;
    }
  }
  return { title, items };
}

/** A file name for an exported chat: the title in lowercase words, safe on every platform. */
export function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "chat"}.md`;
}
