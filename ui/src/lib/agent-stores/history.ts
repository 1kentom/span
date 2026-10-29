import { createSignal } from "solid-js";
import type { SessionMeta_Serialize as SessionMeta, SessionMetaPatch_Deserialize as SessionMetaPatch, SessionSummary } from "../../bindings";
import { api, isDesktop, sessionMetaList, sessionMetaUpdate } from "../client";
import { threadOf } from "../session-threads";
import { sharedStore } from "./shared";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True while the caller's request still matters (its agent and workspace are still the current ones). */
export type StillCurrent = () => boolean;

/**
 * History (app-wide, ADR 0011 phase 2): the sessions the connected agent lists, and Span's stored metadata index for
 * the workspace's sessions (ADR 0005). Every async write takes the caller's `current` check, so an answer for an agent
 * or workspace the user has left is dropped.
 */
export function createAgentHistory() {
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [sessionsBusy, setSessionsBusy] = createSignal(false);
  const [sessionsError, setSessionsError] = createSignal("");
  /** History scope: this workspace (the agent lists sessions of the folder) or every folder the agent knows. */
  const [sessionScope, setSessionScope] = createSignal<"workspace" | "all">("workspace");
  /** Span's stored metadata for the workspace's sessions (ADR 0005). Empty when none is stored or it cannot be read. */
  const [sessionMeta, setSessionMeta] = createSignal<SessionMeta[]>([]);

  /** Reads the agent's session list for the current scope, with the metadata beside it. */
  async function loadSessions(current: StillCurrent) {
    setSessionsBusy(true);
    setSessionsError("");
    void loadSessionMeta(current);
    try {
      const found = sessionScope() === "all" ? await api.agentListAllSessions() : await api.agentListSessions();
      if (current()) setSessions(found);
    } catch (cause) {
      if (current()) setSessionsError(errorText(cause));
    } finally {
      if (current()) setSessionsBusy(false);
    }
  }
  /** Metadata only adds chips and titles to History rows, so a failed read leaves the rows as the agent lists them. */
  async function loadSessionMeta(current: StillCurrent) {
    try {
      const found = await sessionMetaList();
      if (current()) setSessionMeta(found);
    } catch {
      if (current()) setSessionMeta([]);
    }
  }
  /** Puts a saved record first, replacing the stored one for the same agent and session. */
  const keepSaved = (saved: SessionMeta) => setSessionMeta((list) => [saved, ...list.filter((entry) => !(entry.agentId === saved.agentId && entry.sessionId === saved.sessionId))]);
  /**
   * Writes what Span observed about a session to the metadata store (ADR 0005) and keeps the History rows in step.
   * The store is a convenience: a failed write (no folder open, browser preview) never disturbs the chat.
   */
  async function recordSessionMeta(patch: SessionMetaPatch, current: StillCurrent) {
    if (!isDesktop) return;
    try {
      const saved = await sessionMetaUpdate(patch);
      if (current()) keepSaved(saved);
    } catch {
      // Nothing to show: History falls back to what the agent lists.
    }
  }
  /** Stored metadata for one session of `agent`. Sessions are keyed by agent and id (ADR 0005). */
  const metaOf = (agent: string | undefined, sessionId: string) => (agent ? sessionMeta().find((entry) => entry.agentId === agent && entry.sessionId === sessionId) : undefined);
  /** Every stored segment of the chat thread that holds `sessionId` of `agent` (ADR 0005, thread links). */
  const threadFor = (agent: string | undefined, sessionId: string) => threadOf(sessionMeta(), agent, sessionId);

  return { sessions, setSessions, sessionsBusy, sessionsError, setSessionsError, sessionScope, setSessionScope, sessionMeta, loadSessions, recordSessionMeta, keepSaved, metaOf, threadFor };
}

export type AgentHistory = ReturnType<typeof createAgentHistory>;

/** The app's one History and metadata index. */
export const agentHistory = sharedStore(createAgentHistory);
