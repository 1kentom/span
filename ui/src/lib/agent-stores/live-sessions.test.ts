import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  live: vi.fn(),
  onEvent: vi.fn(),
}));
vi.mock("../client", () => ({ agentSessions: { live: mocks.live, onEvent: mocks.onEvent } }));

import { liveSessions } from "./live-sessions";

const held = () => createRoot((dispose) => ({ store: liveSessions.use(), dispose }));
const key = (connectionId: string, sessionId: string) => ({ connectionId, sessionId });
const keyed = (k: { connectionId: string; sessionId: string } | null, kind: string, text = "") =>
  ({ connectionId: k?.connectionId ?? "c", agentName: "A", key: k, event: { kind, sessionId: k?.sessionId, text } }) as never;

/** Starts the store and returns the listener it gave the keyed stream. */
async function started(store: ReturnType<typeof held>["store"], unsubscribe = vi.fn()) {
  let emit!: (event: unknown) => void;
  mocks.onEvent.mockImplementation(async (listener: (event: unknown) => void) => {
    emit = listener;
    return unsubscribe;
  });
  await store.start();
  return emit;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("live sessions store", () => {
  it("is shared, and holding it sends nothing until started", () => {
    const one = held();
    const two = held();
    expect(two.store).toBe(one.store);
    expect(mocks.live).not.toHaveBeenCalled();
    expect(mocks.onEvent).not.toHaveBeenCalled();
    one.dispose();
    two.dispose();
  });

  it("delivers interleaved keyed events only to their own session, even with the same session id", async () => {
    mocks.live.mockResolvedValue([]);
    const { store, dispose } = held();
    const emit = await started(store);
    const a = key("c1", "s1");
    const b = key("c2", "s1");
    const seenA: string[] = [];
    const seenB: string[] = [];
    store.onSession(a, (event) => seenA.push((event.event as { text: string }).text));
    store.onSession(b, (event) => seenB.push((event.event as { text: string }).text));
    emit(keyed(a, "text", "a1"));
    emit(keyed(b, "text", "b1"));
    emit(keyed(null, "status"));
    emit(keyed(a, "text", "a2"));
    emit(keyed(key("c1", "other"), "text", "x"));
    emit(keyed(b, "text", "b2"));
    expect(seenA).toEqual(["a1", "a2"]);
    expect(seenB).toEqual(["b1", "b2"]);
    dispose();
  });

  it("stops delivering after a listener unsubscribes, and drops the stream with the store", async () => {
    mocks.live.mockResolvedValue([]);
    const unsubscribe = vi.fn();
    const { store, dispose } = held();
    const emit = await started(store, unsubscribe);
    const listener = vi.fn();
    const stop = store.onSession(key("c1", "s1"), listener);
    expect(store.listenedKeys()).toBe(1);
    stop();
    expect(store.listenedKeys()).toBe(0);
    emit(keyed(key("c1", "s1"), "text", "late"));
    expect(listener).not.toHaveBeenCalled();
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reads the live list on start and again, coalesced, after events that change it", async () => {
    vi.useFakeTimers();
    const entry = { key: key("c1", "s1"), state: "running" };
    mocks.live.mockResolvedValueOnce([]).mockResolvedValue([entry]);
    const { store, dispose } = held();
    const emit = await started(store);
    await Promise.resolve();
    expect(mocks.live).toHaveBeenCalledTimes(1);
    emit(keyed(key("c1", "s1"), "text", "streaming"));
    vi.advanceTimersByTime(300);
    expect(mocks.live).toHaveBeenCalledTimes(1);
    emit(keyed(key("c1", "s1"), "status"));
    emit(keyed(key("c1", "s1"), "complete"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.live).toHaveBeenCalledTimes(2);
    expect(store.find(key("c1", "s1"))?.state).toBe("running");
    expect(store.find(key("c2", "s1"))).toBeUndefined();
    dispose();
  });
});
