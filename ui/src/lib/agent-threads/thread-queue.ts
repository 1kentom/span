import type { SessionRuntimeState_Serialize as SessionRuntimeState } from "../../bindings";
import { classifyAgentError, isLimitKind, limitStatus, type AgentErrorInfo } from "../agent-errors";
import { withHandoff } from "../agent-handoff";
import { moveItem } from "../agent-queue";
import { addFeedItem, type AgentState } from "../agent-session";
import type { Queued, ThreadState } from "./thread-state";

/**
 * Queue, steering and turn reducers of one thread (ADR 0011 phase 2). Pure: state in, state out, plus what the caller
 * must send. Extracted from the sidebar controller with the same rules, so the sidebar and the Agents page queue,
 * steer and recover from failed prompts the same way.
 */

const conversation = (state: ThreadState, values: Partial<AgentState>): ThreadState => ({ ...state, conversation: { ...state.conversation, ...values } });

/** Stops the queue from draining on its own, when there is anything in it. A pending Send now is dropped. */
export function holdQueue(state: ThreadState): ThreadState {
  return { ...state, queueSending: undefined, queueHeld: state.queueHeld || state.queue.length > 0 };
}

/**
 * The turn a steer was waiting on ended without the normal cancelled completion. The steer text goes back to the
 * composer when it is empty, otherwise to the front of the queue, and the steer is forgotten.
 */
export function releaseSteer(state: ThreadState): ThreadState {
  const pending = state.steering;
  if (!pending) return state;
  const { entry } = pending;
  const next: ThreadState = !state.draft.trim() && !state.attachments.length
    ? { ...state, steering: undefined, draft: entry.text, attachments: entry.items.length ? entry.items : state.attachments }
    : { ...state, steering: undefined, queue: [entry, ...state.queue], queueHeld: true };
  return conversation(next, { stopRequested: false });
}

export const enqueue = (state: ThreadState, entry: Queued): ThreadState => ({ ...state, queue: [...state.queue, entry] });
/** Picks a queued message for Send now (or clears the pick). */
export const pickSending = (state: ThreadState, id: string | undefined): ThreadState => ({ ...state, queueSending: id });

/** Replaces the typed part of a queued message. Text added to an attachment-only message gets a blank line before the attachments. */
export function editQueuedEntry(entry: Queued, text: string): Queued {
  const rest = entry.message.slice(entry.text.length);
  const joiner = !entry.text && rest && !rest.startsWith("\n") ? "\n\n" : "";
  return { ...entry, text, message: `${text}${joiner}${rest}` };
}
export const editQueued = (state: ThreadState, id: string, text: string): ThreadState => ({ ...state, queue: state.queue.map((entry) => (entry.id === id ? editQueuedEntry(entry, text) : entry)) });
/** Moves a queued message. Ignored while one is being sent, so the order cannot shift under it. */
export const reorderQueue = (state: ThreadState, from: number, to: number): ThreadState => (state.queueSending ? state : { ...state, queue: moveItem(state.queue, from, to) });
export function removeQueued(state: ThreadState, id: string): ThreadState {
  const queue = state.queue.filter((entry) => entry.id !== id);
  return { ...state, queue, queueSending: state.queueSending === id ? undefined : state.queueSending, queueHeld: queue.length ? state.queueHeld : false };
}
export const clearQueue = (state: ThreadState): ThreadState => ({ ...state, queue: [], queueHeld: false, queueSending: undefined });

/** Queued follow-ups that go out together: one message, texts and prompts joined by a blank line. */
export function mergeQueued(entries: readonly Queued[], id: string): Queued {
  return {
    id,
    text: entries.map((entry) => entry.text).join("\n\n"),
    message: entries.map((entry) => entry.message).join("\n\n"),
    attachments: entries.flatMap((entry) => entry.attachments),
    items: entries.flatMap((entry) => entry.items),
  };
}

export type Dispatch = { entry: Queued; steered?: boolean; sentNow?: boolean };

/**
 * What the queue sends once the agent finished: the message picked with Send now, else everything merged. A held
 * queue goes out only with `force` (Send queued) or a Send now pick.
 */
export function planDrain(state: ThreadState, options: { connected: boolean; online: boolean; force?: boolean; nextId: () => string }): { state: ThreadState; dispatch?: Dispatch } {
  const waiting = state.queue;
  if (!waiting.length || state.conversation.running || !options.connected || !options.online || state.steering) return { state };
  const priority = state.queueSending;
  if (state.queueHeld && !options.force && !priority) return { state };
  const chosen = priority ? waiting.find((entry) => entry.id === priority) : undefined;
  if (chosen) {
    const rest = waiting.filter((entry) => entry !== chosen);
    return { state: { ...state, queueSending: undefined, queue: rest, queueHeld: rest.length ? state.queueHeld : false }, dispatch: { entry: chosen, sentNow: true } };
  }
  return { state: { ...state, queueSending: undefined, queue: [], queueHeld: false }, dispatch: { entry: mergeQueued(waiting, options.nextId()) } };
}

/** Where a composed message goes: a steer of the running turn, the queue, or straight out. */
export function routeSubmit(state: ThreadState, mode: "queue" | "steer", online: boolean): "steer" | "queue" | "send" {
  if (mode === "steer" && state.conversation.running && online) return "steer";
  if (state.conversation.running || !online || state.steering) return "queue";
  return "send";
}

/** Starts a steer: the running turn is cancelled and `entry` waits for it to end. A second steer queues behind the first. */
export function beginSteer(state: ThreadState, entry: Queued): ThreadState {
  if (state.steering) return enqueue(state, entry);
  return conversation({ ...state, steering: { entry, cancelled: false, turn: state.turn } }, { stopRequested: true, statusMessage: "Steering the agent" });
}
/** The cancel for `entry`'s steer resolved. Ignored when the steer was released meanwhile. */
export function steerCancelled(state: ThreadState, entry: Queued): ThreadState {
  return state.steering?.entry === entry ? { ...state, steering: { ...state.steering, cancelled: true } } : state;
}
/** The cancel for `entry`'s steer failed: the message is queued first and the card says why. */
export function steerCancelFailed(state: ThreadState, entry: Queued, message: string): ThreadState {
  if (state.steering?.entry !== entry) return state;
  return conversation({ ...state, steering: undefined, queue: [entry, ...state.queue] }, { stopRequested: false, statusMessage: "Agent is working", failure: { phase: "prompt", message: `Could not cancel the turn, so the message was queued: ${message}` } });
}
/** Sends the steer once its cancel resolved and the cancelled turn ended. A steer whose turn has passed is released. */
export function planFlushSteer(state: ThreadState): { state: ThreadState; dispatch?: Dispatch } {
  const pending = state.steering;
  if (!pending?.cancelled || state.conversation.running) return { state };
  if (pending.turn !== state.turn) return { state: releaseSteer(state) };
  return { state: { ...state, steering: undefined }, dispatch: { entry: pending.entry, steered: true } };
}

export type TurnStart = { state: ThreadState; turn: number; itemId: number; message: string; carried?: ThreadState["handoff"] };

/**
 * A prompt goes out: the user bubble joins the feed, the thread runs, and the first prompt after an agent switch or a
 * branch carries the context exactly once (slash commands go out unchanged).
 */
export function beginTurn(state: ThreadState, entry: Queued, options: { steered?: boolean; sentNow?: boolean; now: number }): TurnStart {
  let next = state.steering && !options.steered ? releaseSteer(state) : state;
  const turn = next.turn + 1;
  const handoff = next.handoff;
  const carried = handoff?.text && handoff.sessionId && handoff.sessionId === next.conversation.sessionId && !entry.message.trimStart().startsWith("/") ? handoff : undefined;
  const message = carried ? withHandoff(carried.text!, entry.message) : entry.message;
  const live = addFeedItem(
    { ...next.conversation, running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", failure: undefined },
    {
      kind: "user",
      text: entry.text,
      attachments: entry.items.length ? entry.items : undefined,
      ...(options.steered ? { steered: true } : {}),
      ...(options.sentNow ? { sentNow: true } : {}),
      ...(carried ? { context: carried.text, ...(carried.note ? { contextNote: carried.note } : {}) } : {}),
    },
  );
  next = { ...next, turn, busyNotice: false, refused: undefined, prompted: true, handoff: carried ? undefined : handoff, conversation: live, turnStart: options.now, pinned: true, promptsInFlight: next.promptsInFlight + 1 };
  return { state: next, turn, itemId: live.nextId, message, carried };
}

/** The prompt call returned, either way. */
export const settleTurn = (state: ThreadState): ThreadState => ({ ...state, promptsInFlight: Math.max(0, state.promptsInFlight - 1) });

/** Gives a turn's text and attachments back to an empty composer. */
function giveBack(state: ThreadState, entry: Queued): ThreadState {
  return { ...state, draft: state.draft || entry.text, attachments: !state.attachments.length && entry.items.length ? entry.items : state.attachments };
}

/**
 * The session still ran a turn, so nothing was sent: the thread shows as running, the text comes back and the composer
 * offers steer or queue instead of an error card. The carried context waits for the next prompt.
 */
export function promptBusy(state: ThreadState, start: TurnStart, entry: Queued, known?: SessionRuntimeState): ThreadState {
  let next: ThreadState = { ...state, handoff: start.carried && !state.handoff ? start.carried : state.handoff };
  next = conversation(next, { running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", feed: next.conversation.feed.filter((item) => item.id !== start.itemId) });
  if (known?.startedAtMs) next = { ...next, turnStart: known.startedAtMs };
  next = { ...next, busyNotice: true };
  if (next.steering?.turn === start.turn) return releaseSteer(next);
  return giveBack(next, entry);
}

/**
 * The prompt failed. Limits and missing sign-ins keep the turn so the card can send it again with another model or
 * agent; anything queued or steered waits for the user. Returns the limit, which the caller marks on the model.
 */
export function promptFailed(state: ThreadState, start: TurnStart, entry: Queued, failure: { message: string; cause: string; agent: string }): { state: ThreadState; limit?: AgentErrorInfo } {
  const classified = classifyAgentError({ message: failure.cause, agent: failure.agent });
  const limit = isLimitKind(classified.kind) ? classified : undefined;
  const sessionId = state.conversation.sessionId;
  let next = conversation(state, {
    running: false,
    stopRequested: false,
    failure: { phase: "prompt", message: failure.message },
    ...(sessionId ? { status: "ready", statusMessage: limit ? limitStatus(limit) : "Prompt failed" } : {}),
  });
  next = holdQueue(next);
  const promptSession = state.key.sessionId;
  if ((next.conversation.auth || limit) && promptSession === next.conversation.sessionId) {
    if (start.carried && !next.handoff) next = { ...next, handoff: start.carried };
    if (start.turn === next.turn) next = { ...next, refused: { sessionId: promptSession, entry, itemId: start.itemId, ...(limit ? { limit } : {}) } };
  }
  if (next.steering?.turn === start.turn) return { state: releaseSteer(next), limit };
  if (start.turn !== next.turn) return { state: next, limit };
  return { state: giveBack(next, entry), limit };
}

/**
 * Takes the refused turn off the card: its bubble leaves the feed (the resend adds it again) and the composer no
 * longer holds the same text and attachments to send twice.
 */
export function takeRefused(state: ThreadState, values: Partial<AgentState> = {}): { state: ThreadState; entry?: Queued } {
  const turn = state.refused;
  if (!turn) return { state };
  const { entry } = turn;
  const sameItems = entry.items.length && state.attachments.length === entry.items.length && state.attachments.every((item, index) => item.id === entry.items[index].id);
  const next = conversation(
    { ...state, refused: undefined, draft: state.draft === entry.text ? "" : state.draft, attachments: sameItems ? [] : state.attachments },
    { ...values, failure: undefined, status: "ready", statusMessage: "Connected and ready", feed: state.conversation.feed.filter((item) => item.id !== turn.itemId) },
  );
  return { state: next, entry };
}
