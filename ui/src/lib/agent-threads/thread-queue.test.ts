import { describe, expect, it } from "vitest";
import { beginSteer, beginTurn, editQueued, holdQueue, planDrain, planFlushSteer, promptBusy, promptFailed, releaseSteer, removeQueued, reorderQueue, routeSubmit, steerCancelFailed, steerCancelled, takeRefused } from "./thread-queue";
import { initialThreadState, type Queued, type ThreadState } from "./thread-state";

const A = { connectionId: "c1", sessionId: "s1" };
const entry = (id: string, value = id): Queued => ({ id, text: value, message: value, attachments: [], items: [] });
const thread = (patch: Partial<ThreadState> = {}, running = false) => {
  const state = initialThreadState(A, patch);
  return { ...state, conversation: { ...state.conversation, running } };
};
const ids = () => "merged";
const drain = (state: ThreadState, force = false) => planDrain(state, { connected: true, online: true, force, nextId: ids });

describe("queue", () => {
  it("merges everything queued into one message once idle, and waits while running, offline or steering", () => {
    const queued = thread({ queue: [entry("a"), entry("b")] });
    const plan = drain(queued);
    expect(plan.dispatch).toEqual({ entry: { id: "merged", text: "a\n\nb", message: "a\n\nb", attachments: [], items: [] } });
    expect(plan.state.queue).toEqual([]);
    expect(drain(thread({ queue: [entry("a")] }, true)).dispatch).toBeUndefined();
    expect(planDrain(queued, { connected: true, online: false, nextId: ids }).dispatch).toBeUndefined();
    expect(drain({ ...queued, steering: { entry: entry("s"), cancelled: false, turn: 0 } }).dispatch).toBeUndefined();
  });

  it("a held queue goes out only with Send queued or a Send now pick, which goes alone", () => {
    const held = thread({ queue: [entry("a"), entry("b")], queueHeld: true });
    expect(drain(held).dispatch).toBeUndefined();
    expect(drain(held, true).dispatch?.entry.text).toBe("a\n\nb");
    const picked = drain({ ...held, queueSending: "b" });
    expect(picked.dispatch).toEqual({ entry: entry("b"), sentNow: true });
    expect(picked.state.queue).toEqual([entry("a")]);
    expect(picked.state.queueHeld).toBe(true);
    expect(picked.state.queueSending).toBeUndefined();
  });

  it("edits, reorders and removes like the sidebar", () => {
    const attachmentOnly: Queued = { id: "x", text: "", message: "File: a.ts", attachments: [], items: [] };
    expect(editQueued(thread({ queue: [attachmentOnly] }), "x", "look").queue[0].message).toBe("look\n\nFile: a.ts");
    expect(reorderQueue(thread({ queue: [entry("a"), entry("b")], queueSending: "a" }), 0, 1).queue.map((item) => item.id)).toEqual(["a", "b"]);
    expect(reorderQueue(thread({ queue: [entry("a"), entry("b")] }), 0, 1).queue.map((item) => item.id)).toEqual(["b", "a"]);
    const removed = removeQueued(thread({ queue: [entry("a")], queueHeld: true, queueSending: "a" }), "a");
    expect(removed).toMatchObject({ queue: [], queueHeld: false, queueSending: undefined });
    expect(holdQueue(thread({ queue: [entry("a")], queueSending: "a" }))).toMatchObject({ queueHeld: true, queueSending: undefined });
    expect(holdQueue(thread()).queueHeld).toBe(false);
  });
});

describe("steering", () => {
  it("routes a composed message: steer while running and online, queue behind a turn or a steer, else send", () => {
    expect(routeSubmit(thread({}, true), "steer", true)).toBe("steer");
    expect(routeSubmit(thread({}, true), "steer", false)).toBe("queue");
    expect(routeSubmit(thread({}, true), "queue", true)).toBe("queue");
    expect(routeSubmit(thread({ steering: { entry: entry("s"), cancelled: true, turn: 0 } }), "queue", true)).toBe("queue");
    expect(routeSubmit(thread(), "queue", true)).toBe("send");
  });

  it("sends the steer after its cancel resolved and its turn ended, and only for that turn", () => {
    const steer = entry("steer");
    let state = beginSteer(thread({ turn: 3 }, true), steer);
    expect(state.conversation).toMatchObject({ stopRequested: true, statusMessage: "Steering the agent" });
    expect(beginSteer(state, entry("second")).queue.map((item) => item.id)).toEqual(["second"]);
    state = steerCancelled(state, steer);
    expect(planFlushSteer(state).dispatch).toBeUndefined();
    const idle = { ...state, conversation: { ...state.conversation, running: false } };
    expect(planFlushSteer(idle).dispatch).toEqual({ entry: steer, steered: true });
    const passed = planFlushSteer({ ...idle, turn: 4 });
    expect(passed.dispatch).toBeUndefined();
    expect(passed.state.draft).toBe("steer");
  });

  it("queues the steer first when its cancel fails, and ignores a released steer", () => {
    const steer = entry("steer");
    const failed = steerCancelFailed(beginSteer(thread({ queue: [entry("q")] }, true), steer), steer, "nope");
    expect(failed.queue.map((item) => item.id)).toEqual(["steer", "q"]);
    expect(failed.conversation.failure?.message).toBe("Could not cancel the turn, so the message was queued: nope");
    expect(steerCancelFailed(thread(), steer, "nope")).toEqual(thread());
  });

  it("a released steer goes to an empty composer, else to the front of a held queue", () => {
    const steering = { entry: entry("s", "steer text"), cancelled: false, turn: 0 };
    expect(releaseSteer(thread({ steering })).draft).toBe("steer text");
    const busy = releaseSteer(thread({ steering, draft: "typing", queue: [entry("q")] }));
    expect(busy.queue.map((item) => item.id)).toEqual(["s", "q"]);
    expect(busy.queueHeld).toBe(true);
  });
});

describe("turns", () => {
  it("a turn adds the user bubble, runs, and carries the handoff context once", () => {
    const handoff = { from: "A", to: "B", text: "[context]", sessionId: "s1" };
    const start = beginTurn(thread({ handoff }), entry("m", "hello"), { now: 7 });
    expect(start.message).toBe("[context]\n\nhello");
    expect(start.state.handoff).toBeUndefined();
    expect(start.state.conversation.running).toBe(true);
    expect(start.state.conversation.feed.at(-1)).toMatchObject({ kind: "user", text: "hello", context: "[context]" });
    expect(start.state).toMatchObject({ turn: 1, turnStart: 7, promptsInFlight: 1, prompted: true });
    expect(beginTurn(thread({ handoff }), entry("m", "/compact"), { now: 0 }).message).toBe("/compact");
  });

  it("a busy refusal sends nothing: the bubble goes, the text comes back and the notice shows", () => {
    const start = beginTurn(thread(), entry("m", "hello"), { now: 0 });
    const state = promptBusy({ ...start.state, draft: "" }, start, entry("m", "hello"), { startedAtMs: 3 } as never);
    expect(state.conversation.feed).toEqual([]);
    expect(state).toMatchObject({ draft: "hello", busyNotice: true, turnStart: 3 });
    expect(state.conversation.running).toBe(true);
  });

  it("a limit keeps the refused turn for the card, holds the queue and gives the text back", () => {
    const start = beginTurn(thread({ queue: [entry("q")] }), entry("m", "hello"), { now: 0 });
    const failed = promptFailed(start.state, start, entry("m", "hello"), { message: "Claude usage limit reached. Your limit will reset at 3pm", cause: "Claude usage limit reached. Your limit will reset at 3pm", agent: "Claude Code" });
    expect(failed.limit).toBeDefined();
    expect(failed.state.refused).toMatchObject({ sessionId: "s1", itemId: start.itemId });
    expect(failed.state).toMatchObject({ queueHeld: true, draft: "hello" });
    const taken = takeRefused({ ...failed.state, draft: "hello" });
    expect(taken.entry?.text).toBe("hello");
    expect(taken.state.draft).toBe("");
    expect(taken.state.conversation.feed.some((item) => item.id === start.itemId)).toBe(false);
  });
});
