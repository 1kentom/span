// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { ATTACH_PX, GESTURE_MS, createFeedFollow, followStep, initialFollow, pinTop, type FollowEvent, type FollowState } from "./feed-follow";

const run = (state: FollowState, ...events: FollowEvent[]) => events.reduce(followStep, state);
const scroll = (at: number, top: number, distance: number): FollowEvent => ({ type: "scroll", at, top, distance });

describe("followStep", () => {
  const following = { ...initialFollow(true), lastTop: 1000 };

  it("never detaches on a scroll event without a user gesture (a pin landing, a smooth frame, a clamp)", () => {
    // The echo of a pin read after a big chunk arrived: far from the bottom, yet not the user's doing.
    expect(run(following, scroll(10, 1000, 466)).mode).toBe("following");
    // A scroll moving up without a gesture, as a restore or an older smooth scroll does.
    expect(run(following, scroll(10, 800, 300)).mode).toBe("following");
  });

  it("detaches when the user scrolls up during a gesture, and keeps that choice while content grows", () => {
    const detached = run(following, { type: "gesture", at: 100 }, scroll(120, 940, 60));
    expect(detached.mode).toBe("detached");
    expect(run(detached, { type: "grew" }, { type: "resized" }, scroll(5000, 940, 900)).mode).toBe("detached");
    expect(pinTop(detached, { scrollHeight: 3000, clientHeight: 500 })).toBeUndefined();
  });

  it("does not detach on a tiny upward clamp at the very end", () => {
    expect(run(following, { type: "gesture", at: 100 }, scroll(120, 999, 1)).mode).toBe("following");
  });

  it("treats scroll events as the user's only within the gesture window, or while a pointer is held", () => {
    expect(run(following, { type: "gesture", at: 100 }, scroll(100 + GESTURE_MS + 1, 900, 200)).mode).toBe("following");
    const held = run(following, { type: "hold", held: true, at: 0 }, scroll(10_000, 900, 200));
    expect(held.mode).toBe("detached");
    const released = run({ ...following, held: true }, { type: "hold", held: false, at: 0 }, scroll(10_000, 900, 200));
    expect(released.mode).toBe("following");
  });

  it("re-attaches when the user scrolls back near the bottom", () => {
    const detached = { ...initialFollow(false), lastTop: 200 };
    expect(run(detached, { type: "gesture", at: 0 }, scroll(50, 900, ATTACH_PX + 10)).mode).toBe("detached");
    expect(run(detached, { type: "gesture", at: 0 }, scroll(50, 950, ATTACH_PX)).mode).toBe("following");
  });

  it("re-attaches without a gesture only at the very bottom", () => {
    const detached = { ...initialFollow(false), lastTop: 200 };
    expect(run(detached, scroll(10, 900, 30)).mode).toBe("detached");
    expect(run(detached, scroll(10, 930, 0)).mode).toBe("following");
  });

  it("sending and the Latest pill always follow, wherever the reader was", () => {
    const detached = initialFollow(false);
    expect(run(detached, { type: "send" }).mode).toBe("following");
    expect(run(detached, { type: "jump" }).mode).toBe("following");
    expect(run(following, { type: "detach" }).mode).toBe("detached");
  });

  it("a thread switch takes that thread's remembered mode", () => {
    expect(run(following, { type: "thread", following: false, top: 120 })).toMatchObject({ mode: "detached", lastTop: 120 });
    expect(run(initialFollow(false), { type: "thread", following: true, top: 0 }).mode).toBe("following");
  });

  it("pins to the end of the content while following", () => {
    expect(pinTop(following, { scrollHeight: 3000, clientHeight: 500 })).toBe(2500);
    expect(pinTop(following, { scrollHeight: 300, clientHeight: 500 })).toBe(0);
  });
});

describe("createFeedFollow", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
  });

  function setup() {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const metrics = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => metrics.scrollTop, set: (value: number) => (metrics.scrollTop = value) });
    const writes: number[] = [];
    scroller.scrollTo = ((options: ScrollToOptions) => {
      writes.push(options.top!);
      metrics.scrollTop = Math.max(0, Math.min(options.top!, metrics.scrollHeight - metrics.clientHeight));
    }) as never;
    let follow!: ReturnType<typeof createFeedFollow>;
    let following!: () => boolean;
    createRoot((dispose) => {
      const [pinned, setPinned] = createSignal(true);
      following = pinned;
      follow = createFeedFollow({ following: pinned, setFollowing: setPinned, scroller: () => scroller });
      disposers.push(follow.attach(scroller), dispose);
    });
    const userScroll = (top: number) => {
      scroller.dispatchEvent(new Event("wheel"));
      metrics.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    };
    const echo = () => scroller.dispatchEvent(new Event("scroll"));
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    return { scroller, metrics, writes, follow, following: () => following(), userScroll, echo, frame };
  }

  it("keeps following when the echo of its own pin arrives after a big chunk grew the feed", async () => {
    const t = setup();
    t.metrics.scrollHeight = 2466;
    t.echo();
    expect(t.following()).toBe(true);
    t.follow.pin();
    await t.frame();
    expect(t.writes.at(-1)).toBe(2466);
    expect(t.metrics.scrollTop).toBe(2066);
  });

  it("detaches on a user scroll up and leaves the position alone while content streams", async () => {
    const t = setup();
    t.userScroll(1200);
    expect(t.following()).toBe(false);
    expect(t.scroller.dataset.follow).toBe("detached");
    t.metrics.scrollHeight = 2600;
    t.follow.pin();
    await t.frame();
    expect(t.writes).toEqual([]);
    expect(t.metrics.scrollTop).toBe(1200);
  });

  it("sending re-attaches and pins with one instant write per frame", async () => {
    const t = setup();
    t.userScroll(300);
    t.metrics.scrollHeight = 2200;
    t.follow.send();
    t.follow.pin();
    t.follow.pin();
    await t.frame();
    expect(t.following()).toBe(true);
    expect(t.scroller.dataset.follow).toBe("following");
    expect(t.writes).toEqual([2200]);
    expect(t.metrics.scrollTop).toBe(1800);
  });

  it("re-attaches when the user scrolls back to the bottom", () => {
    const t = setup();
    t.userScroll(500);
    expect(t.following()).toBe(false);
    t.userScroll(1590);
    expect(t.following()).toBe(true);
  });

  it("ignores navigation keys typed into a field inside the feed", () => {
    const t = setup();
    const input = document.createElement("textarea");
    t.scroller.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    t.metrics.scrollTop = 900;
    t.echo();
    expect(t.following()).toBe(true);
    t.scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    t.metrics.scrollTop = 600;
    t.echo();
    expect(t.following()).toBe(false);
  });
});
