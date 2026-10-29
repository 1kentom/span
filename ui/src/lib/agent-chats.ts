import type {
  AgentEvent,
  ConfigOption,
  SessionMetaPatch_Deserialize as SessionMetaPatch,
  SessionMeta_Serialize as SessionMeta,
  SessionRuntimeState_Serialize as SessionRuntimeState,
  SessionStates_Serialize as SessionStates,
} from "../bindings";
import type { Queued } from "./agent-controller";
import { RUN_TEXT } from "./agent-hint-text";
import { clockText } from "./agent-running";
import { reduceAgentEvent, type AgentState } from "./agent-session";
import type { Attachment } from "./attachments";

/**
 * Per-chat state for the agent sidebar. Every chat (one agent session on one connection) keeps its own feed, running
 * flag, queue, draft, pending requests, scroll position, usage and mode or config view. The open chat lives in the
 * controller's signals; every other chat Span holds is a `ChatSnapshot` here, and events for it keep updating it in
 * the background, so leaving a chat never resets it. Whether a chat is running comes from the backend's session
 * states (`agent_session_states` and `AgentSessionStatesChanged`), never from a guess.
 */

/** Chats are keyed by connection and session: session ids repeat across agent processes. */
export const chatKey = (connectionId: string, sessionId: string) => `${connectionId}\u0000${sessionId}`;

/**
 * Feed items kept per background chat. The open chat keeps `FEED_LIMIT` (400); a chat in the background keeps its
 * newest 200, which bounds memory to roughly CHAT_LIMIT x 200 feed items however long the background turns run.
 */
export const BACKGROUND_FEED_LIMIT = 200;
/** Chats kept besides the open one. Chats still working (running, waiting or queued) are never evicted. */
export const CHAT_LIMIT = 12;

export type ChatSnapshot = {
  /** The chat's conversation. Connection level fields (status, agent, logs) are ignored on restore. */
  conversation: AgentState;
  draft: string;
  attachments: Attachment[];
  queue: Queued[];
  queueHeld: boolean;
  pinned: boolean;
  scrollTop?: number;
  turnStart: number;
  /** When the chat was last open or changed, for eviction. */
  touchedAt: number;
};

/** The fields of `AgentState` that belong to one conversation and travel with its chat. */
export const CONVERSATION_FIELDS = [
  "feed",
  "plan",
  "elicitations",
  "strayPermissions",
  "childRequests",
  "usage",
  "turnUsage",
  "sessionTitle",
  "commands",
  "config",
  "running",
  "stopRequested",
  "delegation",
  "failure",
  "nextId",
] as const satisfies readonly (keyof AgentState)[];

/** Copies one chat's conversation fields onto the live state, keeping the connection's own fields. */
export function withConversation(live: AgentState, conversation: AgentState): AgentState {
  const next: AgentState = { ...live };
  for (const field of CONVERSATION_FIELDS) (next as Record<string, unknown>)[field] = conversation[field];
  return next;
}

const trimmed = (state: AgentState): AgentState => (state.feed.length > BACKGROUND_FEED_LIMIT ? { ...state, feed: state.feed.slice(-BACKGROUND_FEED_LIMIT) } : state);

/** Applies an event of a background chat to its snapshot. Connection level events never reach here. */
export function reduceBackground(chat: ChatSnapshot, event: AgentEvent): ChatSnapshot {
  const conversation = trimmed(reduceAgentEvent(chat.conversation, event));
  return conversation === chat.conversation ? chat : { ...chat, conversation, touchedAt: Date.now() };
}

/** Prepares a chat for the background: its feed is capped and a queue never drains on its own while it is away. */
export function toBackground(chat: ChatSnapshot): ChatSnapshot {
  return { ...chat, conversation: trimmed(chat.conversation), queueHeld: chat.queueHeld || chat.queue.length > 0 };
}

/** A plain map of background chats with bounded size. Not reactive: the controller bumps its own signal. */
export function createChatStore(limit = CHAT_LIMIT) {
  const chats = new Map<string, ChatSnapshot>();
  return {
    get: (key: string) => chats.get(key),
    has: (key: string) => chats.has(key),
    set: (key: string, chat: ChatSnapshot) => void chats.set(key, chat),
    delete: (key: string) => chats.delete(key),
    clear: () => chats.clear(),
    keys: () => [...chats.keys()],
    size: () => chats.size,
    /** Evicts the oldest chats that are not live until at most `limit` remain, chats without a draft or queue first. */
    prune(isLive: (key: string) => boolean) {
      while (chats.size > limit) {
        const candidates = [...chats.entries()].filter(([key]) => !isLive(key));
        if (!candidates.length) return;
        const keeps = ([, chat]: [string, ChatSnapshot]) => Boolean(chat.draft.trim() || chat.queue.length || chat.attachments.length);
        const pool = candidates.some((entry) => !keeps(entry)) ? candidates.filter((entry) => !keeps(entry)) : candidates;
        pool.sort((a, b) => a[1].touchedAt - b[1].touchedAt);
        chats.delete(pool[0][0]);
      }
    },
  };
}
export type ChatStore = ReturnType<typeof createChatStore>;

type BusyError = { kind: "busy"; message: string; state?: SessionRuntimeState | null };
const isBusy = (value: unknown): value is BusyError => Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "busy");

/** True for the typed `PromptError::Busy` from agent_prompt, raw or wrapped by the client as `error.prompt`. */
export function isBusyPromptError(cause: unknown): boolean {
  return isBusy(cause) || isBusy((cause as { prompt?: unknown } | null)?.prompt);
}
/** The session state a busy refusal carried, when it carried one. */
export function busyState(cause: unknown): SessionRuntimeState | undefined {
  const value = isBusy(cause) ? cause : (cause as { prompt?: unknown } | null)?.prompt;
  return isBusy(value) ? value.state ?? undefined : undefined;
}

export type RowStatus = { kind: "running" | "approval" | "answer" | "idle"; label: string; attention: boolean };

/** What a session list row says about a session. `undefined` for a session Span does not hold: nothing is invented. */
export function rowStatus(state: SessionRuntimeState | undefined, options: { now: number }): RowStatus | undefined {
  if (!state) return undefined;
  const queued = state.queued > 0 ? ` · ${RUN_TEXT.queued} ${state.queued}` : "";
  switch (state.state) {
    case "waitingForApproval":
      return { kind: "approval", label: `${RUN_TEXT.approval}${queued}`, attention: true };
    case "waitingForAnswer":
      return { kind: "answer", label: `${RUN_TEXT.answer}${queued}`, attention: true };
    case "running": {
      const elapsed = state.startedAtMs !== null && state.startedAtMs !== undefined ? ` ${clockText(options.now - state.startedAtMs)}` : "";
      return { kind: "running", label: `${RUN_TEXT.running}${elapsed}${queued}`, attention: false };
    }
    default:
      return { kind: "idle", label: queued ? `${RUN_TEXT.idle}${queued}` : RUN_TEXT.idle, attention: false };
  }
}

/** What a History row shows from Span's stored session metadata (ADR 0005). */
export type RowMeta = { title?: string; agents: { id: string; name: string }[]; models: string[]; files?: number; delta?: { add: number; del: number } };

/**
 * The agent avatars, model chips, counters and user title for a History row. Empty, zero and null fields mean unknown
 * in the store, so they produce nothing: a session Span never observed shows only what the agent lists.
 */
export function rowMeta(meta: SessionMeta | undefined): RowMeta {
  if (!meta) return { agents: [], models: [] };
  const agents: RowMeta["agents"] = [];
  const addAgent = (id: string, name: string) => {
    if (name.trim() && !agents.some((agent) => agent.id === id)) agents.push({ id, name: name.trim() });
  };
  addAgent(meta.agentId, meta.connectionName);
  for (const agent of meta.agents) addAgent(agent.agentId, agent.name);
  const models = meta.models.filter((model) => model.name.trim()).map((model) => (model.effort ? `${model.name} · ${model.effort}` : model.name));
  const title = meta.titleOverride?.trim();
  const delta = meta.linesAdded > 0 || meta.linesRemoved > 0 ? { add: Math.max(0, meta.linesAdded), del: Math.max(0, meta.linesRemoved) } : undefined;
  return { ...(title ? { title } : {}), agents, models, ...(meta.filesChanged > 0 ? { files: meta.filesChanged } : {}), ...(delta ? { delta } : {}) };
}

/** The name the pickers show for an option's current value, else the raw value. */
const choiceName = (option: ConfigOption) =>
  option.groups.flatMap((group) => group.choices).find((choice) => choice.value === option.currentValue)?.name.trim() || option.currentValue.trim();

/**
 * The metadata patch for one finished turn (ADR 0005 section 5, step 1): the model and effort the turn ran with, by
 * the names the model picker shows. No model option means no model is recorded. Undefined without an agent catalog
 * id or a session, since the store is keyed by both.
 */
export function turnMetaPatch(input: { agentId: string | undefined; sessionId: string | undefined; connectionName: string; config: readonly ConfigOption[] }): SessionMetaPatch | undefined {
  if (!input.agentId || !input.sessionId) return undefined;
  const model = input.config.find((option) => option.category === "model");
  const effort = input.config.find((option) => option.category === "thought_level");
  const name = model ? choiceName(model) : "";
  return {
    agentId: input.agentId,
    sessionId: input.sessionId,
    connectionName: input.connectionName,
    ...(name ? { models: [{ name, effort: (effort && choiceName(effort)) || null, turns: 1 }] } : {}),
  };
}

/**
 * The metadata patch for a delegated child's model, recorded on the lead session as a subagent use (shown as
 * `model · subagent`). Zero turns: the child's turns are not the lead's. Undefined without a model option.
 */
export function subagentModelPatch(agentId: string | undefined, leadSessionId: string, config: readonly ConfigOption[]): SessionMetaPatch | undefined {
  const model = config.find((option) => option.category === "model");
  const name = model ? choiceName(model) : "";
  if (!agentId || !leadSessionId || !name) return undefined;
  return { agentId, sessionId: leadSessionId, models: [{ name, turns: 0, subagent: true }] };
}

/** The metadata patch naming an agent the lead session delegated to (ADR 0005 section 5, step 5). */
export function delegationMetaPatch(agentId: string | undefined, leadSessionId: string, agentName: string): SessionMetaPatch | undefined {
  if (!agentId || !leadSessionId || !agentName.trim()) return undefined;
  return { agentId, sessionId: leadSessionId, agents: [{ agentId: agentName, name: agentName, role: "delegated", subagent: false }] };
}

const waiting = (state: SessionRuntimeState) => state.state === "waitingForApproval" || state.state === "waitingForAnswer";

/** User chats other than the open one that wait for the user. Delegated children ask through their lead's dock. */
export function attentionSessions(states: SessionStates, openSessionId: string | undefined): SessionRuntimeState[] {
  return states.sessions.filter((state) => state.origin === "user" && state.sessionId !== openSessionId && waiting(state));
}

/** Attention sessions in `next` that were not waiting in the same way in `previous`. */
export function newAttention(previous: SessionStates, next: SessionStates, openSessionId: string | undefined): SessionRuntimeState[] {
  const before = new Map(previous.connectionId === next.connectionId ? previous.sessions.map((state) => [state.sessionId, state.state]) : []);
  return attentionSessions(next, openSessionId).filter((state) => before.get(state.sessionId) !== state.state);
}
