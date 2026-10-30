import { createSignal } from "solid-js";
import type { AgentCommand, SessionStates_Serialize as SessionStates } from "../../bindings";
import { sharedStore } from "./shared";

export const NO_STATES: SessionStates = { connectionId: null, sessions: [] };

/** How the focused agent was started, so Reconnect can start it again. */
export type Launch = { command: AgentCommand; name: string; id?: string };
/** A connection being made, for the startup phases. `failed` marks the step that stopped. */
export type Connecting = { name: string; command: string; logBase: number; failed: boolean };

/**
 * The focused agent connection (app-wide, ADR 0011 phase 2): which agent the sidebar's chat runs on, how it was
 * started, the backend's session states for that connection, and the attention notice for background chats. The
 * open chat's own state lives with the chat.
 */
export function createAgentConnection() {
  const [agentName, setAgentName] = createSignal("Select agent");
  const [agentId, setAgentId] = createSignal<string>();
  const [launch, setLaunch] = createSignal<Launch>();
  const [connecting, setConnecting] = createSignal<Connecting>();
  /** The backend's session states for the active connection: the only source of "is this chat running". */
  const [sessionStates, setSessionStates] = createSignal<SessionStates>(NO_STATES);
  /** The connection chats are keyed by: the backend connection id, or a local stand-in when it could not be read. */
  const [connectionKey, setConnectionKey] = createSignal<string>();
  let localConnection = 0;
  /** A new local stand-in connection key, for a connection whose backend id could not be read. */
  const localKey = () => `local-${++localConnection}`;
  /** Read once by screen readers: a background chat newly waits for the user. Timers never change it. */
  const [attentionAnnouncement, setAttentionAnnouncement] = createSignal("");
  const runtimeOf = (sessionId: string | undefined) => (sessionId ? sessionStates().sessions.find((entry) => entry.sessionId === sessionId) : undefined);
  /** Running, waiting or with follow-ups queued on the backend. */
  const isLive = (sessionId: string | undefined) => {
    const entry = runtimeOf(sessionId);
    return Boolean(entry && (entry.state !== "idle" || entry.queued > 0));
  };
  return {
    agentName,
    setAgentName,
    agentId,
    setAgentId,
    launch,
    setLaunch,
    connecting,
    setConnecting,
    sessionStates,
    setSessionStates,
    connectionKey,
    setConnectionKey,
    localKey,
    attentionAnnouncement,
    setAttentionAnnouncement,
    runtimeOf,
    isLive,
  };
}

export type AgentConnection = ReturnType<typeof createAgentConnection>;

/** The app's one focused connection. */
export const agentConnection = sharedStore(createAgentConnection);
