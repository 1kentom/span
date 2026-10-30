// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { ATTACH_PX, GESTURE_MS, INERTIA_GAP_MS, createFeedFollow, distanceOf, followStep, initialFollow, pinTop, type FollowEvent, type FollowState } from "./feed-follow";

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

  it("rounds the distance up and never reports a rubber-band overshoot as negative", () => {
    // Retina: a fractional position a hair short of the end still reads as at the end within the 2 px tolerance.
    expect(distanceOf({ scrollHeight: 1000, scrollTop: 599.5, clientHeight: 400 })).toBe(1);
    expect(distanceOf({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(0);
    expect(distanceOf({ scrollHeight: 1000, scrollTop: 640, clientHeight: 400 })).toBe(0);
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

  const wheel = (target: EventTarget, deltaY: number, deltaX = 0) => target.dispatchEvent(Object.assign(new Event("wheel", { bubbles: true }), { deltaY, deltaX }));

  it("an upward wheel releases follow at once, before its scroll event lands (WebKit delivers it a frame late)", async () => {
    const t = setup();
    wheel(t.scroller, -4);
    expect(t.following()).toBe(false);
    // Content streams in before the scroll lands: nothing pins the reader back down.
    t.metrics.scrollHeight = 2600;
    t.follow.pin();
    await t.frame();
    expect(t.writes).toEqual([]);
  });

  it("a downward or sideways wheel does not release follow, nor does one scrolling an inner box", () => {
    const t = setup();
    wheel(t.scroller, 30);
    wheel(t.scroller, -2, 40);
    expect(t.following()).toBe(true);
    const box = document.createElement("pre");
    box.style.overflowY = "auto";
    Object.defineProperty(box, "scrollHeight", { value: 900 });
    Object.defineProperty(box, "clientHeight", { value: 200 });
    box.scrollTop = 120;
    t.scroller.append(box);
    wheel(box, -40);
    expect(t.following()).toBe(true);
    box.scrollTop = 0;
    wheel(box, -40);
    expect(t.following()).toBe(false);
  });

  it("an upward key releases follow at once", () => {
    const t = setup();
    t.scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(t.following()).toBe(false);
  });

  it("trackpad inertia still arriving after Latest does not detach the feed again; a new gesture does", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const t = setup();
      wheel(t.scroller, -30);
      expect(t.following()).toBe(false);
      vi.advanceTimersByTime(16);
      t.follow.jump();
      expect(t.following()).toBe(true);
      // The flick keeps coming, every frame, and moves the view: still the old stream.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(16);
        wheel(t.scroller, -10 + i);
        t.metrics.scrollTop -= 8;
        t.echo();
      }
      expect(t.following()).toBe(true);
      // A pause, then a new upward gesture: the reader's.
      vi.advanceTimersByTime(INERTIA_GAP_MS + 50);
      wheel(t.scroller, -20);
      expect(t.following()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Lays children out top to bottom with the given heights, so getBoundingClientRect follows scrollTop. */
  function layout(t: ReturnType<typeof setup>, heights: number[]) {
    const content = document.createElement("div");
    t.scroller.append(content);
    const rows = heights.map((height, index) => {
      const row = document.createElement("div");
      if (index % 3 === 0) row.dataset.feedId = String(100 + index);
      row.getBoundingClientRect = () => {
        const top = heights.slice(0, index).reduce((sum, value) => sum + value, 0) - t.metrics.scrollTop;
        return { top, bottom: top + heights[index], height: heights[index], left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
      content.append(row);
      return row;
    });
    t.scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400, height: 400, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    t.metrics.scrollHeight = heights.reduce((sum, value) => sum + value, 0);
    return { content, rows };
  }

  it("keeps a detached reader's first visible row in place when content above it changes height (WebKit has no scroll anchoring)", () => {
    const t = setup();
    const heights = Array.from({ length: 40 }, () => 100);
    const { content } = layout(t, heights);
    disposers.push(t.follow.observe(content));
    t.userScroll(1550);
    expect(t.following()).toBe(false);
    // Row 15 starts 50 px above the view top. A row above it renders for the first time and grows by 180 px.
    heights[10] = 280;
    t.metrics.scrollHeight += 180;
    t.userScroll(1450);
    // The reader scrolled 100 px up; the row moved exactly that far on screen, not 280.
    expect(t.metrics.scrollTop).toBe(1630);
    expect(t.writes.at(-1)).toBe(1630);
  });

  it("restores a detached thread by its message, not its old scrollTop, after the oldest items were dropped", async () => {
    const t = setup();
    const heights = Array.from({ length: 30 }, () => 100);
    const { content, rows } = layout(t, heights);
    disposers.push(t.follow.observe(content));
    t.userScroll(1240);
    const saved = t.follow.position()!;
    expect(saved).toMatchObject({ id: "112", delta: 0, offset: -40 });
    // Back from another thread: six rows were trimmed from the front and every height is new.
    rows.slice(0, 6).forEach((row) => row.remove());
    heights.splice(0, 6);
    heights.forEach((_, index) => (heights[index] = 60));
    rows.slice(6).forEach((row, index) => {
      row.getBoundingClientRect = () => {
        const top = index * 60 - t.metrics.scrollTop;
        return { top, bottom: top + 60, height: 60, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
      };
    });
    t.metrics.scrollHeight = 24 * 60;
    t.metrics.scrollTop = 0;
    t.follow.restore(saved);
    await t.frame();
    // Row 12 (index 6 after the trim) sits 40 px above the view top again.
    expect(t.metrics.scrollTop).toBe(6 * 60 + 40);
  });

  it("reveals a message by scrolling only the feed", () => {
    const t = setup();
    const heights = Array.from({ length: 30 }, () => 100);
    const { rows } = layout(t, heights);
    t.metrics.scrollTop = 1000;
    t.follow.reveal(rows[4]);
    expect(t.following()).toBe(false);
    // Row 4 (top 400) centred in a 400 px view: its top at 150.
    expect(t.metrics.scrollTop).toBe(250);
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
