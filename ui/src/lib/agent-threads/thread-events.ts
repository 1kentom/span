import type { AgentEvent, AgentKeyedEvent_Serialize as AgentKeyedEvent, SessionKey, SessionRuntimeState_Serialize as SessionRuntimeState } from "../../bindings";
import { reduceAgentEvent } from "../agent-session";
import { holdQueue, releaseSteer } from "./thread-queue";
import { sameKey, type ThreadState } from "./thread-state";

/**
 * Event reducers of one thread (ADR 0011 phase 2). Pure: a keyed event in, the next state and the side effects the
 * thread must run out. The conversation itself is `reduceAgentEvent` (agent-session.ts), the reducer the sidebar has
 * always used, so a thread's feed is exactly what the sidebar shows for the same events. Around it are the rules the
 * sidebar controller applies on each event: a finished turn lets the steer and the queue go, an abnormal end holds them.
 */

export type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

export type ThreadEffect =
  /** A turn of this thread completed: send the waiting steer, then drain the queue (after the event settles). */
  | { kind: "turnEnded" }
  /** The turn completed for a reason other than a refusal: the model it ran on works again. */
  | { kind: "turnSucceeded" }
  /** Record the finished turn in the session metadata (ADR 0005). */
  | { kind: "turnRecorded"; stopReason: string }
  /** Re-read the delegation status, which carries what the events do not (failure detail, progress). */
  | { kind: "refreshDelegation" }
  /** The lead delegated to a child session: follow the child's permission requests, record the delegated agent. */
  | { kind: "delegated"; child: SessionKey; agentName: string }
  /** A delegated child reported its options, for the subagent model in the lead's metadata. */
  | { kind: "childConfig"; child: SessionKey; event: Extract<AgentEvent, { kind: "config" }> }
  /** A tool call of this thread changed: follow mode may reveal its location, the tool bar times it. */
  | { kind: "tool"; event: ToolEvent }
  /** The connection ended. */
  | { kind: "disconnected" };

export type ThreadStep = { state: ThreadState; effects: ThreadEffect[] };

/** Child session events a lead thread takes: a delegated child asks permission through the lead's dock. */
const CHILD_KINDS = new Set(["permission", "permissionResolved"]);

function withConversation(state: ThreadState, event: AgentEvent): ThreadState {
  const next = reduceAgentEvent(state.conversation, event);
  if (next === state.conversation) return state;
  // A turn that stops running ends the busy notice with it.
  return { ...state, conversation: next, busyNotice: next.running ? state.busyNotice : false };
}

/** True for a key this thread follows as a delegated child (a `delegated` event in its feed named it). */
export function isChildOf(state: ThreadState, key: SessionKey): boolean {
  return state.conversation.feed.some((item) => item.kind === "delegation" && sameKey(item.task.child, key));
}

/**
 * Applies one keyed event. Events of another session are ignored, except a delegated child's permission requests and
 * options; connection level events (no key) apply only from this thread's own connection.
 */
export function reduceThreadEvent(state: ThreadState, keyed: AgentKeyedEvent): ThreadStep {
  const { event } = keyed;
  const effects: ThreadEffect[] = [];
  if (keyed.key && !sameKey(keyed.key, state.key)) {
    if (keyed.key.connectionId !== state.key.connectionId) return { state, effects };
    // The "deleted but still listed" notice names the deleted session, and is noted in the thread that sees it.
    if (CHILD_KINDS.has(event.kind) || (event.kind === "notice" && event.hint === "deletedStillListed")) return { state: withConversation(state, event), effects };
    if (event.kind === "config" && isChildOf(state, keyed.key)) effects.push({ kind: "childConfig", child: keyed.key, event });
    return { state, effects };
  }
  if (!keyed.key && keyed.connectionId !== state.key.connectionId) return { state, effects };
  // A connection level status names no session; it never moves this thread to another one.
  let next = withConversation(state, event);
  if (next.conversation.sessionId !== state.key.sessionId && !(event.kind === "status" && ["error", "disconnected"].includes(event.state))) {
    next = { ...next, conversation: { ...next.conversation, sessionId: state.key.sessionId } };
  }
  switch (event.kind) {
    case "tool":
      effects.push({ kind: "tool", event });
      break;
    case "delegation":
      if (event.event.kind === "taskFinished" || event.event.kind === "delegated") effects.push({ kind: "refreshDelegation" });
      if (event.event.kind === "delegated") effects.push({ kind: "delegated", child: event.event.child, agentName: event.event.agentName });
      break;
    case "complete":
      effects.push({ kind: "turnRecorded", stopReason: event.stopReason }, { kind: "turnEnded" });
      if (event.stopReason !== "refusal") effects.push({ kind: "turnSucceeded" });
      break;
    case "error":
      // The turn ended abnormally: nothing queued or steered may go out on its own.
      next = holdQueue(releaseSteer(next));
      break;
    case "status":
      if (["error", "disconnected"].includes(event.state)) next = holdQueue(releaseSteer(next));
      if (event.state === "disconnected") effects.push({ kind: "disconnected" });
      break;
  }
  return { state: next, effects };
}

/** Replays events in order, collecting every effect. For tests and for seeding a thread from recorded events. */
export function replayThread(state: ThreadState, events: readonly AgentKeyedEvent[]): ThreadStep {
  return events.reduce<ThreadStep>((step, event) => {
    const next = reduceThreadEvent(step.state, event);
    return { state: next.state, effects: [...step.effects, ...next.effects] };
  }, { state, effects: [] });
}

/**
 * Applies the backend's runtime state of this session. A focused thread follows it: running when a turn runs that it
 * did not start (a chat reopened while busy), idle when nothing it sent is still in flight. A thread in the background
 * whose turn ended while away is idle, whatever it last showed.
 */
export function applyRuntime(state: ThreadState, runtime: SessionRuntimeState | undefined, options: { focused: boolean; working: boolean; now: number }): ThreadState {
  if (!runtime) return state;
  const running = state.conversation.running;
  if (!options.focused) {
    return runtime.state === "idle" && running ? { ...state, conversation: { ...state.conversation, running: false, stopRequested: false }, busyNotice: false } : state;
  }
  if (options.working) return state;
  if (runtime.state !== "idle" && !running) {
    return { ...state, conversation: { ...state.conversation, running: true, status: "busy", statusMessage: "Agent is working" }, turnStart: runtime.startedAtMs ?? options.now };
  }
  if (runtime.state === "idle" && runtime.queued === 0 && running && state.promptsInFlight === 0 && !state.steering) {
    return { ...state, conversation: { ...state.conversation, running: false, stopRequested: false, status: "ready" }, busyNotice: false };
  }
  return state;
}
