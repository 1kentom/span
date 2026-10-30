import { createEffect, on, onCleanup, type Accessor } from "solid-js";

/**
 * Feed follow: one authority for whether the agent feed stays pinned to its newest output, shared by the Editor sidebar
 * and the Agents page. A pure state machine decides the mode; `createFeedFollow` binds it to a scroller and is the only
 * code that writes the feed's scroll position while following.
 *
 * Only a person detaches the feed. A scroll event counts as theirs while a wheel, touch, key or pointer gesture on the
 * scroller is recent or held; every other scroll event (the echo of a pin, a clamp after content shrank, a restore)
 * leaves the mode alone. Sending, the Latest pill and scrolling back to the bottom re-attach it.
 *
 * WebKit (the desktop app's WKWebView) differs from Chromium in ways this file absorbs, so both behave the same:
 * - No CSS scroll anchoring (`overflow-anchor`). While detached, the feed keeps the first visible element where the
 *   reader saw it when content above changes height (markdown settling, `content-visibility` blocks rendering for the
 *   first time, images, a group opening above). The scroller sets `overflow-anchor: none` so Chromium does not apply
 *   its own correction on top.
 * - Scroll events land a frame after the wheel that caused them, so a pin written in between would undo the first
 *   upward wheel. An upward wheel or key that can scroll the feed releases follow at once, before its scroll lands.
 * - Trackpad inertia keeps sending wheel events after a flick. When the reader sends or clicks Latest during that
 *   stream, the rest of the stream is not a new gesture and does not detach the feed again.
 */

export type FollowMode = "following" | "detached";

export interface FollowState {
  mode: FollowMode;
  /** The scroll position seen last, to tell scrolling up from scrolling down. */
  lastTop: number;
  /** When the last user gesture on the scroller happened, in milliseconds. */
  gestureAt: number;
  /** A pointer or touch is down on the scroller: its scroll events are the user's. */
  held: boolean;
}

export type FollowEvent =
  /** A wheel, key or touch move on the scroller. */
  | { type: "gesture"; at: number }
  /** A pointer or touch went down on the scroller (true) or was released (false). */
  | { type: "hold"; held: boolean; at: number }
  /** The scroller scrolled. `distance` is how far its bottom edge is from the end of the content. */
  | { type: "scroll"; at: number; top: number; distance: number }
  /** The user sent a prompt: sending always follows. */
  | { type: "send" }
  /** The Latest pill was clicked. */
  | { type: "jump" }
  /** Code moved the reader to an older message on purpose (Show in session). */
  | { type: "detach" }
  /** Another thread was shown: its own remembered mode applies. */
  | { type: "thread"; following: boolean; top: number }
  /** The feed's content grew or the scroller was resized. Never changes the mode. */
  | { type: "grew" }
  | { type: "resized" };

/** A scroll event this long after a wheel, key or touch gesture still counts as the user's (wheel momentum included). */
export const GESTURE_MS = 400;
/** A user scroll that ends this close to the bottom re-attaches. Matches the Latest pill's hide threshold. */
export const ATTACH_PX = 48;
/** Scrolling up detaches only when it leaves the feed more than this from the bottom (not a clamp at the end). */
export const DETACH_PX = 2;
/** Wheel events closer together than this belong to one stream (a gesture and its inertia). */
export const INERTIA_GAP_MS = 120;
/** How far below the view top `reveal(..., "start")` puts its target. */
export const REVEAL_START_PX = 12;
/** Frames a restore keeps correcting while late layout (markdown, images, unrendered blocks) settles. */
export const RESTORE_FRAMES = 30;

/**
 * Where a reader left a feed: the content child at the top of the view, named by the nearest message at or above it
 * (`data-feed-id`) and how many children further down it is, and how far its top sat below the view top. A background
 * thread drops its oldest items and keeps receiving new ones, so neither a child index nor `top` survives a switch.
 */
export interface FeedPosition {
  top: number;
  id?: string;
  delta?: number;
  offset?: number;
}

export const initialFollow = (following = true): FollowState => ({ mode: following ? "following" : "detached", lastTop: 0, gestureAt: Number.NEGATIVE_INFINITY, held: false });

const userScroll = (state: FollowState, at: number) => state.held || at - state.gestureAt <= GESTURE_MS;

export function followStep(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "gesture":
      return { ...state, gestureAt: event.at };
    case "hold":
      return { ...state, held: event.held, gestureAt: event.at };
    case "scroll": {
      const next = { ...state, lastTop: event.top };
      if (userScroll(state, event.at)) {
        if (event.top < state.lastTop && event.distance > DETACH_PX) return { ...next, mode: "detached" };
        if (event.distance <= ATTACH_PX) return { ...next, mode: "following" };
        return next;
      }
      // Not the user's: a pin landing, a clamp, a restore. Reaching the very bottom still re-attaches.
      if (state.mode === "detached" && event.distance <= DETACH_PX) return { ...next, mode: "following" };
      return next;
    }
    case "send":
    case "jump":
      return { ...state, mode: "following" };
    case "detach":
      return { ...state, mode: "detached" };
    case "thread":
      return { ...state, mode: event.following ? "following" : "detached", lastTop: event.top };
    case "grew":
    case "resized":
      return state;
  }
}

/** Where the scroller must be: its end while following, otherwise wherever the reader left it. */
export const pinTop = (state: FollowState, scroller: { scrollHeight: number; clientHeight: number }): number | undefined =>
  state.mode === "following" ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : undefined;

/**
 * How far the view's bottom edge is from the end of the content, rounded up and never negative. Retina layouts give
 * fractional scroll positions that stop a fraction short of the end, and WebKit's rubber band overshoots past it.
 */
export const distanceOf = (element: { scrollHeight: number; scrollTop: number; clientHeight: number }) => Math.max(0, Math.ceil(element.scrollHeight - element.scrollTop - element.clientHeight - 0.01));
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/** True when an element between `target` and `scroller` scrolls itself in that direction (a long output box, a table). */
function scrollsInside(target: EventTarget | null, scroller: HTMLElement, up: boolean): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== scroller; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight + 1) continue;
    const overflow = getComputedStyle(node).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (up ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
  }
  return false;
}

/** The first child of `parent` whose bottom is below `edge`, by binary search over children laid out top to bottom. */
function firstBelow(parent: Element, edge: number): Element | undefined {
  const children = parent.children;
  let low = 0;
  let high = children.length - 1;
  let found: Element | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const rect = children[middle].getBoundingClientRect();
    if (rect.bottom > edge) {
      found = children[middle];
      high = middle - 1;
    } else low = middle + 1;
  }
  return found;
}

/**
 * The element that holds the reader's place: the first visible element, descending into a block that starts above the
 * view (one long message) so a change inside it above the view is caught too.
 */
export function pickAnchor(root: Element, viewTop: number): { node: Element; offset: number } | undefined {
  let parent = root;
  let found: Element | undefined;
  for (let depth = 0; depth < 6; depth++) {
    const next = firstBelow(parent, viewTop + 1);
    if (!next) break;
    found = next;
    if (next.getBoundingClientRect().top >= viewTop - 1 || !next.children.length) break;
    parent = next;
  }
  return found ? { node: found, offset: found.getBoundingClientRect().top - viewTop } : undefined;
}
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export interface FeedFollow {
  /** Binds a feed scroller: gestures, scroll events and its size. Returns the cleanup. */
  attach(scroller: HTMLElement): () => void;
  /** Watches the feed content's height (markdown, images, tables settling) so a following feed stays pinned. */
  observe(content: Element): () => void;
  /** Pins a following feed on the next animation frame. Several calls in one frame write once. */
  pin(): void;
  /** Sending a prompt: re-attach and pin. */
  send(): void;
  /** The Latest pill: re-attach and pin. */
  jump(): void;
  /** Code scrolls to an older message: stop following. */
  detach(): void;
  /**
   * Detaches and brings `target` (an element or a text range) to the middle of the view, or near its top with
   * `"start"`, scrolling only the feed (never its ancestors, as `scrollIntoView` does).
   */
  reveal(target: { getBoundingClientRect(): DOMRect }, align?: "center" | "start"): void;
  /** Where the reader is now, to restore after a thread switch. */
  position(): FeedPosition | undefined;
  /** Puts a detached feed back at a saved position, holding it while late layout settles; a gesture cancels it. */
  restore(position: FeedPosition): void;
}

/**
 * Binds the follow state machine to the feed. The mode itself lives in the focused thread (`following`), so each
 * thread remembers it across switches; this keeps only gesture timing. The single scroll writer pins with an instant
 * jump (never smooth: a smooth scroll lags the streaming content and its frames read as the user scrolling away).
 */
export function createFeedFollow(options: { following: Accessor<boolean>; setFollowing: (following: boolean) => void; scroller: () => HTMLElement | undefined; active?: () => boolean }): FeedFollow {
  let local = initialFollow();
  const state = (): FollowState => ({ ...local, mode: options.following() ? "following" : "detached" });
  const dispatch = (event: FollowEvent) => {
    const before = state();
    const next = followStep(before, event);
    local = next;
    if (next.mode !== before.mode) options.setFollowing(next.mode === "following");
    return next;
  };
  const active = () => options.active?.() ?? true;
  /** When the last wheel event arrived, and whether the current wheel stream is inertia left over from before a send. */
  let lastWheelAt = Number.NEGATIVE_INFINITY;
  let inertia = false;
  /** Sending or Latest during a wheel stream: the rest of that stream is inertia, not a gesture. */
  const settle = () => {
    stopRestore();
    inertia = now() - lastWheelAt <= INERTIA_GAP_MS;
    // The flick's earlier wheel events must not make its inertia scrolls count as the reader's.
    if (inertia) local = { ...local, gestureAt: Number.NEGATIVE_INFINITY };
  };
  /** The scroll position this code wrote last: its scroll event is not the user's. */
  let ownTop: number | undefined;
  const scrollTo = (element: HTMLElement, top: number) => {
    element.scrollTo({ top, behavior: "instant" });
    ownTop = element.scrollTop;
    local = { ...local, lastTop: element.scrollTop };
  };
  /** The observed feed content, where anchors are picked. */
  let content: Element | undefined;
  /** The reader's place while detached, kept where it was when content above changes height. */
  let anchor: { node: Element; offset: number; top: number } | undefined;
  const viewTop = (element: HTMLElement) => element.getBoundingClientRect().top;
  const capture = () => {
    const element = options.scroller();
    const picked = element && content?.isConnected && state().mode === "detached" ? pickAnchor(content, viewTop(element)) : undefined;
    anchor = picked && element ? { ...picked, top: element.scrollTop } : undefined;
  };
  /**
   * Keeps a detached feed's anchor where the scroll alone would have put it: any further movement is content above
   * changing height, and the feed scrolls by that much. WebKit sizes `content-visibility` blocks inside the layout a
   * scroll handler forces, so this runs on scroll events as well as on resizes.
   */
  const hold = () => {
    const element = options.scroller();
    if (!element || !active() || state().mode !== "detached") return;
    if (anchor?.node.isConnected) {
      const expected = anchor.offset - (element.scrollTop - anchor.top);
      const drift = anchor.node.getBoundingClientRect().top - viewTop(element) - expected;
      if (Math.abs(drift) >= 1) scrollTo(element, element.scrollTop + drift);
    }
    capture();
  };
  const write = () => {
    const element = options.scroller();
    if (!element || !active()) return;
    const top = pinTop(state(), element);
    if (top === undefined) return hold();
    if (Math.abs(element.scrollTop - top) < 1) return;
    scrollTo(element, element.scrollHeight);
    syncAttribute();
  };
  const syncAttribute = () => {
    const element = options.scroller();
    if (element) element.dataset.follow = state().mode;
  };
  let frame: number | undefined;
  const pin = () => {
    syncAttribute();
    if (frame !== undefined || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      write();
    });
  };
  /** A pending restore or reveal, corrected each frame while layout settles, until a gesture cancels it. */
  let restoring: { frames: number; frame?: number } | undefined;
  const stopRestore = () => {
    if (restoring?.frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(restoring.frame);
    restoring = undefined;
  };
  /** Runs `apply` on the next RESTORE_FRAMES frames while the feed stays detached. */
  const settleTo = (apply: () => void) => {
    stopRestore();
    const mine = { frames: 0 } as { frames: number; frame?: number };
    const run = () => {
      if (restoring !== mine || !options.scroller() || state().mode !== "detached") return restoring === mine ? stopRestore() : undefined;
      apply();
      capture();
      if (++mine.frames >= RESTORE_FRAMES || typeof requestAnimationFrame !== "function") return stopRestore();
      mine.frame = requestAnimationFrame(run);
    };
    restoring = mine;
    if (typeof requestAnimationFrame === "function") mine.frame = requestAnimationFrame(run);
    else run();
  };
  // A thread switch or a queued send flips the mode in the store: pin as soon as it reads following.
  createEffect(on(options.following, (following) => {
    dispatch({ type: "thread", following, top: options.scroller()?.scrollTop ?? 0 });
    syncAttribute();
    if (following) pin();
  }));
  onCleanup(() => {
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    stopRestore();
  });

  const observeSize = (target: Element) => {
    if (typeof ResizeObserver === "undefined") return () => undefined;
    // Runs after layout and before paint: pinning here shows the new content already at the bottom, without a lagging
    // frame. WebKit can apply a scroll written here a frame late, so a following feed checks once more next frame.
    const observer = new ResizeObserver(() => {
      dispatch({ type: target === options.scroller() ? "resized" : "grew" });
      write();
      if (state().mode === "following") pin();
    });
    observer.observe(target);
    return () => observer.disconnect();
  };

  const contentOf = (scroller: HTMLElement) => content?.isConnected ? content : scroller;
  const position = (): FeedPosition | undefined => {
    const element = options.scroller();
    if (!element) return undefined;
    const root = contentOf(element);
    const top = viewTop(element);
    const first = firstBelow(root, top + 1);
    if (!first) return { top: element.scrollTop };
    const children = Array.from(root.children);
    const index = children.indexOf(first);
    let named = index;
    while (named > 0 && !(children[named] as HTMLElement).dataset.feedId) named--;
    const id = (children[named] as HTMLElement).dataset.feedId;
    return { top: element.scrollTop, ...(id ? { id, delta: index - named } : {}), offset: first.getBoundingClientRect().top - top };
  };
  const applyPosition = (element: HTMLElement, saved: FeedPosition) => {
    const root = contentOf(element);
    const children = Array.from(root.children);
    const named = saved.id ? children.findIndex((child) => (child as HTMLElement).dataset.feedId === saved.id) : -1;
    const node = named >= 0 ? children[named + (saved.delta ?? 0)] : undefined;
    if (!node) {
      if (Math.abs(element.scrollTop - saved.top) >= 1) scrollTo(element, saved.top);
      return;
    }
    const drift = node.getBoundingClientRect().top - viewTop(element) - (saved.offset ?? 0);
    if (Math.abs(drift) >= 1) scrollTo(element, element.scrollTop + drift);
  };

  return {
    attach(scroller) {
      const gesture = () => {
        stopRestore();
        dispatch({ type: "gesture", at: now() });
      };
      /** The reader asked to go up and the feed can: stop following now, before WebKit delivers the scroll. */
      const release = (target: EventTarget | null) => {
        if (state().mode !== "following" || scroller.scrollTop <= 0 || scrollsInside(target, scroller, true)) return;
        dispatch({ type: "detach" });
        capture();
        syncAttribute();
      };
      const down = () => {
        stopRestore();
        dispatch({ type: "hold", held: true, at: now() });
      };
      const up = () => {
        if (local.held) dispatch({ type: "hold", held: false, at: now() });
      };
      const key = (event: KeyboardEvent) => {
        if (!NAV_KEYS.has(event.key) || typing(event.target)) return;
        gesture();
        if (UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) release(event.target);
      };
      const wheel = (event: WheelEvent) => {
        const at = now();
        const gap = at - lastWheelAt;
        lastWheelAt = at;
        if (inertia) {
          // The rest of a flick that was going when the reader sent or clicked Latest: not a new gesture.
          if (gap <= INERTIA_GAP_MS) {
            if (state().mode === "following") pin();
            return;
          }
          inertia = false;
        }
        gesture();
        const dy = event.deltaY ?? 0;
        if (dy < 0 && Math.abs(dy) >= Math.abs(event.deltaX ?? 0)) release(event.target);
      };
      const scroll = () => {
        if (!active()) return;
        const top = scroller.scrollTop;
        const own = ownTop !== undefined && Math.abs(top - ownTop) < 1;
        ownTop = undefined;
        if (own) {
          local = { ...local, lastTop: top };
          if (state().mode === "detached") capture();
        } else {
          dispatch({ type: "scroll", at: now(), top, distance: distanceOf(scroller) });
          if (inertia && state().mode === "following" && distanceOf(scroller) > DETACH_PX) pin();
          if (state().mode === "detached") hold();
        }
        syncAttribute();
      };
      // Late images change heights without a feed change: pin a following feed, hold a detached one.
      const loaded = () => (state().mode === "following" ? pin() : hold());
      scroller.addEventListener("wheel", wheel, { passive: true });
      scroller.addEventListener("load", loaded, true);
      scroller.addEventListener("touchmove", gesture, { passive: true });
      scroller.addEventListener("touchstart", down, { passive: true });
      scroller.addEventListener("pointerdown", down);
      scroller.addEventListener("keydown", key);
      scroller.addEventListener("scroll", scroll, { passive: true });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      window.addEventListener("touchend", up);
      window.addEventListener("touchcancel", up);
      local = { ...local, lastTop: scroller.scrollTop };
      syncAttribute();
      const unobserve = observeSize(scroller);
      return () => {
        unobserve();
        scroller.removeEventListener("wheel", wheel);
        scroller.removeEventListener("load", loaded, true);
        scroller.removeEventListener("touchmove", gesture);
        scroller.removeEventListener("touchstart", down);
        scroller.removeEventListener("pointerdown", down);
        scroller.removeEventListener("keydown", key);
        scroller.removeEventListener("scroll", scroll);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("touchend", up);
        window.removeEventListener("touchcancel", up);
      };
    },
    observe(target) {
      content = target;
      const unobserve = observeSize(target);
      // Web fonts change line heights once they load.
      void (typeof document !== "undefined" ? document.fonts?.ready : undefined)?.then(() => (state().mode === "following" ? pin() : hold()));
      return () => {
        unobserve();
        if (content === target) content = undefined;
      };
    },
    pin,
    send() {
      settle();
      dispatch({ type: "send" });
      pin();
    },
    jump() {
      settle();
      dispatch({ type: "jump" });
      pin();
    },
    detach() {
      stopRestore();
      dispatch({ type: "detach" });
      capture();
      syncAttribute();
    },
    reveal(target, align = "center") {
      const scroller = options.scroller();
      if (!scroller) return;
      stopRestore();
      dispatch({ type: "detach" });
      const view = scroller.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const inset = align === "start" ? REVEAL_START_PX : Math.max(0, (scroller.clientHeight - rect.height) / 2);
      const offset = Math.min(inset, Math.max(0, scroller.clientHeight - rect.height));
      scrollTo(scroller, scroller.scrollTop + rect.top - view.top - inset);
      capture();
      syncAttribute();
      // Blocks between the old and new view render for the first time and change height (content-visibility), which
      // moves the target: hold the target itself where it was put while layout settles.
      settleTo(() => {
        const element = options.scroller();
        if (!element) return;
        const drift = target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
        if (Math.abs(drift) >= 1) scrollTo(element, element.scrollTop + drift);
      });
    },
    position,
    restore(saved) {
      settleTo(() => {
        const element = options.scroller();
        if (element) applyPosition(element, saved);
      });
    },
  };
}
