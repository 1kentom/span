import type { FeedPosition } from "../feed-follow";
import type { PromptAttachment, SessionKey } from "../../bindings";
import type { AgentErrorInfo } from "../agent-errors";
import { initialAgentState, type AgentState } from "../agent-session";
import type { Attachment } from "../attachments";

/**
 * One agent thread (ADR 0011 phase 2): everything that belongs to one session on one connection, in one plain value.
 * The sidebar shows the focused thread and the Agents page shows many; both read the same shape. Pure data: every
 * change goes through the reducers in thread-events.ts and thread-queue.ts.
 */

/** A message waiting to go out: the text the user typed, the built prompt, and the attachments both ways. */
export type Queued = { id: string; text: string; message: string; attachments: PromptAttachment[]; items: Attachment[] };
/** A steer waiting for its turn to end. `turn` is the turn it interrupts; a steer never outlives that turn. */
export type Steering = { entry: Queued; cancelled: boolean; turn: number };
/**
 * An agent switch in the open chat. `text` is the carried context, sent once ahead of the first prompt of the session
 * named by `sessionId`; `sessionId` is set when the new session is ready.
 */
export type Handoff = {
  from: string;
  to: string;
  text?: string;
  sessionId?: string;
  /** Shown on the context card instead of the switch note. */
  note?: string;
  /** The session the chat leaves, linked from the new one so History shows one thread. */
  link?: { agentId: string; sessionId: string; name: string; title?: string };
};
/**
 * A user message picked with Edit or Restore. Edit puts its text in the composer (the previous draft is kept in
 * `draft`) and the next send starts a new session from there; both show the files changed since that message.
 */
export type Rewind = { itemId: number; sessionId?: string; mode: "edit" | "restore"; draft: string };
/**
 * The turn the provider refused (missing sign-in or a usage limit), in the session it was sent to. Only this turn can
 * be sent again with another model or agent.
 */
export type Refused = { sessionId: string; entry: Queued; itemId: number; limit?: AgentErrorInfo };
/** Progress through an elicitation form, one field at a time. */
export type FormProgress = { requestId: string; index: number; values: Record<string, string | number | boolean>; error?: string };

export type ThreadState = {
  /** The session this thread is. Never changes: another session is another thread. */
  key: SessionKey;
  /** Feed, plan, usage, config, requests, running and stop state, built from ACP events (agent-session.ts). */
  conversation: AgentState;
  /** The composer. */
  draft: string;
  attachments: Attachment[];
  queue: Queued[];
  /** True when the queue must not drain on its own (an error, a dropped connection, a switch since queueing). */
  queueHeld: boolean;
  /** The queued message picked with Send now, until it goes out or is dropped. */
  queueSending?: string;
  steering?: Steering;
  /** Counts dispatched turns, so a steer can tell its own turn from a later one. */
  turn: number;
  /** Prompts sent and not yet settled. */
  promptsInFlight: number;
  /** When the current turn started (ms), 0 before the first. */
  turnStart: number;
  /** A prompt was refused because a turn still runs: the composer offers steer or queue. */
  busyNotice: boolean;
  refused?: Refused;
  handoff?: Handoff;
  rewind?: Rewind;
  form?: FormProgress;
  /** A prompt has gone out on this session, so a late options restore never races the user's own turn. */
  prompted: boolean;
  /** Scroll: following the newest output, and where the reader left it when not. */
  pinned: boolean;
  scrollTop?: number;
  scrollAnchor?: FeedPosition;
  /** When the thread was last open or changed in the background, for eviction (agent-chats.ts). */
  touchedAt?: number;
};

/** What a new thread starts with besides the defaults. `conversation` fields merge into a fresh conversation. */
export type ThreadSeed = Partial<Omit<ThreadState, "key" | "conversation">> & { conversation?: Partial<AgentState> };

/** A fresh thread for `key`. `seed` fills in a thread that continues something (a snapshot, a branch). */
export function initialThreadState(key: SessionKey, seed: ThreadSeed = {}): ThreadState {
  const { conversation: fields, ...rest } = seed;
  const conversation: AgentState = { ...initialAgentState(true), status: "ready", statusMessage: "Connected and ready", ...fields, sessionId: key.sessionId };
  return {
    key,
    conversation,
    draft: "",
    attachments: [],
    queue: [],
    queueHeld: false,
    turn: 0,
    promptsInFlight: 0,
    turnStart: 0,
    busyNotice: false,
    prompted: false,
    pinned: true,
    ...rest,
  };
}

export const sameKey = (a: SessionKey | null | undefined, b: SessionKey | null | undefined) => Boolean(a && b && a.connectionId === b.connectionId && a.sessionId === b.sessionId);
