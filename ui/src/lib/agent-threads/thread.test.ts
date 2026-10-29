import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { SessionKey } from "../../bindings";

const mocks = vi.hoisted(() => ({ live: vi.fn(async () => []), onEvent: vi.fn() }));
vi.mock("../client", () => ({ agentSessions: { live: mocks.live, onEvent: mocks.onEvent }, agentChildPermission: vi.fn(), agentDelegationStatus: vi.fn() }));

import { createLiveSessions } from "../agent-stores/live-sessions";
import { createThread } from "./thread";
import type { ThreadClient } from "./thread-actions";
import { createThreadRegistry } from "./threads";
import type { Queued } from "./thread-state";

const A: SessionKey = { connectionId: "c1", sessionId: "s1" };
/** The same session id on another connection: a different thread (ADR 0001). */
const B: SessionKey = { connectionId: "c2", sessionId: "s1" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const entry = (id: string, value = id): Queued => ({ id, text: value, message: value, attachments: [], items: [] });
const keyed = (key: SessionKey | null, event: Record<string, unknown>, connectionId = key?.connectionId ?? "c1") => ({ connectionId, agentName: "Agent", key, event: { sessionId: key?.sessionId, ...event } }) as never;

function fakeClient(): { [K in keyof ThreadClient]: Mock<ThreadClient[K]> } {
  return {
    prompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    permission: vi.fn(async () => undefined),
    elicitation: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => undefined),
    review: vi.fn(async () => ({ path: "a.ts", text: "", revision: 1 }) as never),
    reviewHunks: vi.fn(async () => ({ path: "a.ts", text: "", revision: 1 }) as never),
    open: vi.fn(async () => ({ connectionId: "c1", sessionId: "s-branch" })),
    childPermission: vi.fn(async () => undefined),
    delegationStatus: vi.fn(async () => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] }) as never),
  };
}

/** A live sessions store started on a fake keyed stream, and its emitter. */
async function stream() {
  let emit!: (event: unknown) => void;
  const unsubscribe = vi.fn();
  mocks.onEvent.mockImplementation(async (listener: (event: unknown) => void) => {
    emit = listener;
    return unsubscribe;
  });
  const root = createRoot((dispose) => ({ live: createLiveSessions(), dispose }));
  await root.live.start();
  return { ...root, emit: (...events: unknown[]) => events.forEach((event) => emit(event)), unsubscribe };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("thread isolation", () => {
  it("two threads fed interleaved keyed events never cross, even with the same session id", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const a = createThread(A, { events: live, client, pollDelegation: false });
    const b = createThread(B, { events: live, client, pollDelegation: false });
    emit(
      keyed(A, { kind: "text", text: "a1" }),
      keyed(B, { kind: "text", text: "b1" }),
      keyed(A, { kind: "permission", requestId: "r1", toolCallId: "t", title: "Edit", options: [] }),
      keyed(B, { kind: "plan", entries: [{ content: "b plan", priority: "high", status: "pending" }] }),
      keyed(null, { kind: "status", state: "disconnected", message: "c2 gone" }, "c2"),
      keyed(A, { kind: "text", text: "a2" }),
    );
    expect(a.feed().map((item) => item.kind)).toEqual(["text", "permission", "text"]);
    expect(a.conversation().plan).toEqual([]);
    expect(a.conversation().status).toBe("ready");
    expect(b.feed().map((item) => item.kind === "text" && item.text)).toEqual(["b1"]);
    expect(b.conversation().plan).toHaveLength(1);
    expect(b.conversation().status).toBe("disconnected");
    expect(b.permission()).toBeUndefined();
    a.dispose();
    b.dispose();
    dispose();
  });

  it("a prompt on A is sent on A's key only, and its queue drains only after A's own turn ends", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const a = createThread(A, { events: live, client, pollDelegation: false, online: () => true });
    const b = createThread(B, { events: live, client, pollDelegation: false, online: () => true });
    a.send(entry("first", "hello"));
    expect(client.prompt).toHaveBeenCalledTimes(1);
    expect(client.prompt).toHaveBeenCalledWith(A, "hello", []);
    a.send(entry("second", "next"));
    expect(a.state().queue.map((item) => item.id)).toEqual(["second"]);
    expect(b.state().queue).toEqual([]);
    emit(keyed(B, { kind: "complete", stopReason: "end_turn", usage: null }));
    await tick();
    expect(client.prompt).toHaveBeenCalledTimes(1);
    emit(keyed(A, { kind: "complete", stopReason: "end_turn", usage: null }));
    await tick();
    expect(client.prompt).toHaveBeenCalledTimes(2);
    expect(client.prompt).toHaveBeenLastCalledWith(A, "next", []);
    expect(client.prompt.mock.calls.every(([key]) => key === A)).toBe(true);
    a.dispose();
    b.dispose();
    dispose();
  });

  it("a steer on A cancels A only and goes out as A's next prompt", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const a = createThread(A, { events: live, client, pollDelegation: false, online: () => true });
    const b = createThread(B, { events: live, client, pollDelegation: false, online: () => true });
    a.send(entry("first"));
    b.send(entry("other"));
    a.steer(entry("steer", "change course"));
    await tick();
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(client.cancel).toHaveBeenCalledWith(A);
    expect(b.state().steering).toBeUndefined();
    emit(keyed(A, { kind: "complete", stopReason: "cancelled", usage: null }));
    await tick();
    expect(client.prompt).toHaveBeenLastCalledWith(A, "change course", []);
    expect(a.feed().at(-1)).toMatchObject({ kind: "user", text: "change course", steered: true });
    expect(b.conversation().running).toBe(true);
    a.dispose();
    b.dispose();
    dispose();
  });

  it("a permission answered on A resolves only A", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const a = createThread(A, { events: live, client, pollDelegation: false });
    const b = createThread(B, { events: live, client, pollDelegation: false });
    const ask = { kind: "permission", requestId: "r1", toolCallId: "t", title: "Edit", options: [] };
    emit(keyed(A, ask), keyed(B, ask));
    await a.answerPermission("r1", "allow");
    expect(client.permission).toHaveBeenCalledWith(A, "r1", "allow");
    expect(a.permission()).toBeUndefined();
    expect(b.permission()?.event.requestId).toBe("r1");
    a.dispose();
    b.dispose();
    dispose();
  });

  it("a delegated child's permission reaches the lead and is answered on the child's key", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const a = createThread(A, { events: live, client, pollDelegation: false });
    const child = { connectionId: "c1", sessionId: "child" };
    emit(keyed(A, { kind: "delegation", event: { kind: "delegated", lead: A, taskId: "k1", child, agentName: "Helper" } }));
    expect(a.followedChildren()).toBe(1);
    emit(keyed(child, { kind: "permission", requestId: "cr1", toolCallId: "x", title: "Run", options: [] }));
    const request = a.childPermissions()[0];
    expect(request?.child).toEqual(child);
    await a.answerChildPermission(request, "allow");
    expect(client.childPermission).toHaveBeenCalledWith("c1", "child", "cr1", "allow");
    expect(client.permission).not.toHaveBeenCalled();
    expect(a.childPermissions()).toEqual([]);
    a.dispose();
    dispose();
  });

  it("disposing a thread unsubscribes, stops its timers and ignores late events and results", async () => {
    const { live, emit, dispose } = await stream();
    vi.useFakeTimers();
    const client = fakeClient();
    const a = createThread(A, { events: live, client });
    const child = { connectionId: "c1", sessionId: "child" };
    emit(keyed(A, { kind: "delegation", event: { kind: "delegated", lead: A, taskId: "k1", child, agentName: "Helper" } }));
    expect(live.listenedKeys()).toBe(2);
    expect(live.listenedConnections()).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);
    const polls = client.delegationStatus.mock.calls.length;
    expect(polls).toBeGreaterThanOrEqual(2);
    a.dispose();
    expect(live.listenedKeys()).toBe(0);
    expect(live.listenedConnections()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.delegationStatus).toHaveBeenCalledTimes(polls);
    const before = a.state();
    emit(keyed(A, { kind: "text", text: "late" }));
    a.receive(keyed(A, { kind: "text", text: "late" }));
    expect(a.state()).toBe(before);
    dispose();
  });

  it("is disposed with the owner that created it", async () => {
    const { live, dispose } = await stream();
    const owner = createRoot((release) => ({ thread: createThread(A, { events: live, client: fakeClient(), pollDelegation: false }), release }));
    expect(live.listenedKeys()).toBe(1);
    owner.release();
    expect(live.listenedKeys()).toBe(0);
    dispose();
  });
});

describe("thread registry", () => {
  it("holds one thread per key, closes it on request and disposes all with itself", async () => {
    const { live, dispose } = await stream();
    const client = fakeClient();
    const root = createRoot((release) => ({ threads: createThreadRegistry({ events: live, client, pollDelegation: false }), release }));
    const a = root.threads.open(A);
    expect(root.threads.open(A)).toBe(a);
    const b = root.threads.open(B);
    expect(b).not.toBe(a);
    expect(root.threads.size()).toBe(2);
    expect(live.listenedKeys()).toBe(2);
    expect(root.threads.close(A)).toBe(true);
    expect(root.threads.has(A)).toBe(false);
    expect(live.listenedKeys()).toBe(1);
    root.release();
    expect(live.listenedKeys()).toBe(0);
    dispose();
  });

  it("branches a fork into a new session on the same connection with the carried feed, context and options", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const root = createRoot((release) => ({ threads: createThreadRegistry({ events: live, client, pollDelegation: false, online: () => true }), release }));
    const a = root.threads.open(A);
    emit(keyed(A, { kind: "config", options: [{ id: "model", name: "Model", category: "model", currentValue: "big", groups: [{ name: null, choices: [{ value: "big", name: "Big" }, { value: "small", name: "Small" }] }] }] }));
    a.send(entry("m1", "first question"));
    emit(keyed(A, { kind: "text", text: "first answer" }), keyed(A, { kind: "complete", stopReason: "end_turn", usage: null }));
    await tick();
    const userId = a.feed().find((item) => item.kind === "user")!.id;
    const forked = await root.threads.branch(a, userId, "fork", { agentLabel: "Agent", entry: entry("m2", "go on") });
    expect(client.open).toHaveBeenCalledWith({ connectionId: "c1" });
    expect(forked?.key).toEqual({ connectionId: "c1", sessionId: "s-branch" });
    expect(forked!.feed().map((item) => item.kind)).toEqual(["user", "text", "branch", "user"]);
    const sent = client.prompt.mock.calls.at(-1)!;
    expect(sent[0]).toEqual({ connectionId: "c1", sessionId: "s-branch" });
    expect(sent[1]).toContain("first question");
    expect(sent[1]).toMatch(/go on$/);
    // The new session reports options and gets the source's, unless a prompt went first (it did here).
    emit(keyed({ connectionId: "c1", sessionId: "s-branch" }, { kind: "config", options: [{ id: "model", name: "Model", category: "model", currentValue: "small", groups: [] }] }));
    expect(client.setConfig).not.toHaveBeenCalled();
    root.release();
    dispose();
  });

  it("a branch with no prompt yet gives the new session the source's options when they arrive, on the new key", async () => {
    const { live, emit, dispose } = await stream();
    const client = fakeClient();
    const root = createRoot((release) => ({ threads: createThreadRegistry({ events: live, client, pollDelegation: false, online: () => true }), release }));
    const a = root.threads.open(A);
    const option = (value: string) => ({ id: "model", name: "Model", category: "model", currentValue: value, groups: [{ name: null, choices: [{ value: "big", name: "Big" }, { value: "small", name: "Small" }] }] });
    emit(keyed(A, { kind: "config", options: [option("big")] }));
    a.send(entry("m1", "question"));
    emit(keyed(A, { kind: "complete", stopReason: "end_turn", usage: null }));
    await tick();
    const forked = await root.threads.branch(a, a.feed()[0].id, "fork", { agentLabel: "Agent" });
    emit(keyed(forked!.key, { kind: "config", options: [option("small")] }));
    await tick();
    expect(client.setConfig).toHaveBeenCalledWith({ connectionId: "c1", sessionId: "s-branch" }, "model", "big");
    root.release();
    dispose();
  });
});
