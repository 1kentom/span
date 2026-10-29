import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentKeyedEvent_Serialize as AgentKeyedEvent, SessionKey } from "../../bindings";
import { applyRuntime, reduceThreadEvent, replayThread } from "./thread-events";
import { initialThreadState, type Queued, type ThreadState } from "./thread-state";

const A: SessionKey = { connectionId: "c1", sessionId: "s1" };
const keyed = (key: SessionKey | null, event: Record<string, unknown>, connectionId = key?.connectionId ?? "c1"): AgentKeyedEvent =>
  ({ connectionId, agentName: "Agent", key, event: { sessionId: key?.sessionId, ...event } as AgentEvent }) as AgentKeyedEvent;
const text = (key: SessionKey, value: string) => keyed(key, { kind: "text", text: value });
const entry = (id: string, value = id): Queued => ({ id, text: value, message: value, attachments: [], items: [] });
const runningThread = (patch: Partial<ThreadState> = {}) => {
  const state = initialThreadState(A, patch);
  return { ...state, conversation: { ...state.conversation, running: true } };
};

describe("thread event reducer", () => {
  it("takes its own events and ignores every other session, including the same session id on another connection", () => {
    const events = [text(A, "a1"), text({ connectionId: "c2", sessionId: "s1" }, "x"), text({ connectionId: "c1", sessionId: "s2" }, "y"), text(A, "a2")];
    const { state } = replayThread(initialThreadState(A), events);
    expect(state.conversation.feed.map((item) => item.kind === "text" && item.text)).toEqual(["a1a2"]);
  });

  it("applies connection level events of its own connection only", () => {
    const ready = { kind: "ready", agentName: "a", agentTitle: "Mine", agentVersion: null, authMethods: [], features: { loadSession: true, canListSessions: false } };
    const other = reduceThreadEvent(initialThreadState(A), keyed(null, ready, "c2")).state;
    expect(other.conversation.agent).toBeUndefined();
    const own = reduceThreadEvent(initialThreadState(A), keyed(null, ready, "c1")).state;
    expect(own.conversation.agent?.title).toBe("Mine");
    expect(own.conversation.sessionId).toBe("s1");
  });

  it("asks for the steer and the queue after its own turn completes, and clears the limit unless refused", () => {
    expect(reduceThreadEvent(runningThread(), keyed(A, { kind: "complete", stopReason: "end_turn", usage: null })).effects.map((effect) => effect.kind)).toEqual(["turnRecorded", "turnEnded", "turnSucceeded"]);
    expect(reduceThreadEvent(runningThread(), keyed(A, { kind: "complete", stopReason: "refusal", usage: null })).effects.map((effect) => effect.kind)).toEqual(["turnRecorded", "turnEnded"]);
    expect(reduceThreadEvent(runningThread(), keyed({ connectionId: "c2", sessionId: "s1" }, { kind: "complete", stopReason: "end_turn", usage: null })).effects).toEqual([]);
  });

  it("holds the queue and gives a waiting steer back when the turn errors or the connection drops", () => {
    const steering = { entry: entry("steer", "steer text"), cancelled: false, turn: 1 };
    for (const event of [keyed(A, { kind: "error", message: "boom" }), keyed(null, { kind: "status", state: "disconnected", message: "gone" })]) {
      const { state } = reduceThreadEvent(runningThread({ queue: [entry("q1")], steering, turn: 1 }), event);
      expect(state.steering).toBeUndefined();
      expect(state.draft).toBe("steer text");
      expect(state.queueHeld).toBe(true);
      expect(state.conversation.running).toBe(false);
    }
  });

  it("ends the busy notice when the turn stops running", () => {
    const state = reduceThreadEvent(runningThread({ busyNotice: true }), keyed(A, { kind: "complete", stopReason: "end_turn", usage: null })).state;
    expect(state.busyNotice).toBe(false);
  });

  it("follows a delegated child: its permission request reaches the lead, its text does not", () => {
    const child = { connectionId: "c1", sessionId: "child" };
    const delegated = keyed(A, { kind: "delegation", event: { kind: "delegated", lead: A, taskId: "k1", child, agentName: "Helper" } });
    const step = reduceThreadEvent(initialThreadState(A), delegated);
    expect(step.effects).toEqual([{ kind: "refreshDelegation" }, { kind: "delegated", child, agentName: "Helper" }]);
    let state = replayThread(step.state, [text(child, "child text"), keyed(child, { kind: "permission", requestId: "cr1", toolCallId: "x", title: "Run", options: [] })]).state;
    expect(state.conversation.feed.some((item) => item.kind === "text")).toBe(false);
    expect(state.conversation.strayPermissions.map((item) => item.requestId)).toEqual(["cr1"]);
    state = reduceThreadEvent(state, keyed(child, { kind: "permissionResolved", requestId: "cr1" })).state;
    expect(state.conversation.strayPermissions).toEqual([]);
  });

  it("reports a delegated child's options for the subagent model, and nobody else's", () => {
    const child = { connectionId: "c1", sessionId: "child" };
    const state = reduceThreadEvent(initialThreadState(A), keyed(A, { kind: "delegation", event: { kind: "delegated", lead: A, taskId: "k1", child, agentName: "Helper" } })).state;
    expect(reduceThreadEvent(state, keyed(child, { kind: "config", options: [] })).effects.map((effect) => effect.kind)).toEqual(["childConfig"]);
    expect(reduceThreadEvent(state, keyed({ connectionId: "c1", sessionId: "stranger" }, { kind: "config", options: [] })).effects).toEqual([]);
  });
});

describe("runtime state", () => {
  const runtime = (state: string, patch: Record<string, unknown> = {}) => ({ connectionId: "c1", sessionId: "s1", state, queued: 0, startedAtMs: null, origin: "user", ...patch }) as never;
  it("a focused thread shows a turn it did not start, and goes idle when nothing it sent is in flight", () => {
    const busy = applyRuntime(initialThreadState(A), runtime("running", { startedAtMs: 5 }), { focused: true, working: false, now: 9 });
    expect(busy.conversation.running).toBe(true);
    expect(busy.turnStart).toBe(5);
    expect(applyRuntime(busy, runtime("idle"), { focused: true, working: false, now: 9 }).conversation.running).toBe(false);
    expect(applyRuntime({ ...busy, promptsInFlight: 1 }, runtime("idle"), { focused: true, working: false, now: 9 }).conversation.running).toBe(true);
    expect(applyRuntime(initialThreadState(A), runtime("running"), { focused: true, working: true, now: 9 }).conversation.running).toBe(false);
  });
  it("a background thread whose turn ended while away is idle, even with a prompt in flight", () => {
    const state = applyRuntime(runningThread({ promptsInFlight: 1 }), runtime("idle"), { focused: false, working: false, now: 0 });
    expect(state.conversation.running).toBe(false);
  });
});
