import { createSignal, onCleanup } from "solid-js";
import type { AgentKeyedEvent_Serialize as AgentKeyedEvent, LiveSession_Serialize as LiveSession, SessionKey } from "../../bindings";
import { agentSessions } from "../client";
import { sharedStore } from "./shared";

/** One string per session key. A session id alone is not unique: two connections can use the same id (ADR 0001). */
export const sessionKeyId = (key: SessionKey) => `${key.connectionId}\u0000${key.sessionId}`;

/** Events that never change what the live list shows, so they do not trigger a reread. Streaming text is the bulk. */
const QUIET = new Set(["text", "thought", "log", "usage", "plan", "availableCommands", "compactionSummary"]);
/** Rereads of the live list are coalesced over this window, so a busy thread does not flood the backend. */
const REFRESH_MS = 250;

/**
 * Live sessions (app-wide, ADR 0011 phase 2): every session the backend holds, from `agent_live_sessions`, kept fresh
 * from the keyed event stream, and a per-key dispatch of that stream so each thread hears only its own events. Not
 * started until a holder calls `start`, so holding it alone sends nothing to the backend.
 */
export function createLiveSessions() {
  const [sessions, setSessions] = createSignal<LiveSession[]>([]);
  const listeners = new Map<string, Set<(event: AgentKeyedEvent) => void>>();
  /** Listeners for the connection level events (`key` null) of one connection, by connection id. */
  const connectionListeners = new Map<string, Set<(event: AgentKeyedEvent) => void>>();
  let disposed = false;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
    unsubscribe?.();
    listeners.clear();
    connectionListeners.clear();
  });

  /** Rereads the live list. A read that a newer one overtook is dropped. */
  async function refresh() {
    const mine = ++generation;
    try {
      const list = await agentSessions.live();
      if (!disposed && mine === generation) setSessions(list);
    } catch {
      // The rail keeps what it showed; the next event reads again.
    }
  }
  function scheduleRefresh() {
    if (timer !== undefined || disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, REFRESH_MS);
  }
  function receive(event: AgentKeyedEvent) {
    const own = event.key ? listeners.get(sessionKeyId(event.key)) : connectionListeners.get(event.connectionId);
    if (own) for (const listener of [...own]) listener(event);
    if (!QUIET.has(event.event.kind)) scheduleRefresh();
  }
  /** Reads the list and follows the keyed stream. Calling it again does nothing. */
  async function start() {
    if (started || disposed) return;
    started = true;
    void refresh();
    try {
      const cleanup = await agentSessions.onEvent(receive);
      if (disposed) cleanup();
      else unsubscribe = cleanup;
    } catch {
      started = false;
    }
  }
  function listen(map: Map<string, Set<(event: AgentKeyedEvent) => void>>, id: string, listener: (event: AgentKeyedEvent) => void) {
    let own = map.get(id);
    if (!own) map.set(id, (own = new Set()));
    own.add(listener);
    return () => {
      const current = map.get(id);
      if (!current) return;
      current.delete(listener);
      if (!current.size) map.delete(id);
    };
  }
  /** Delivers the keyed events of `key` only. Returns the unsubscribe. */
  const onSession = (key: SessionKey, listener: (event: AgentKeyedEvent) => void) => listen(listeners, sessionKeyId(key), listener);
  /** Delivers the connection level events (no session key: status, log, ready, sign-in) of one connection. Returns the unsubscribe. */
  const onConnection = (connectionId: string, listener: (event: AgentKeyedEvent) => void) => listen(connectionListeners, connectionId, listener);
  const find = (key: SessionKey) => sessions().find((entry) => entry.key.connectionId === key.connectionId && entry.key.sessionId === key.sessionId);
  /** Number of sessions with a listener, for tests and diagnostics. */
  const listenedKeys = () => listeners.size;
  /** Number of connections with a connection level listener, for tests and diagnostics. */
  const listenedConnections = () => connectionListeners.size;

  return { sessions, refresh, start, onSession, onConnection, find, listenedKeys, listenedConnections };
}

export type LiveSessions = ReturnType<typeof createLiveSessions>;

/** The app's one live session list. */
export const liveSessions = sharedStore(createLiveSessions);
