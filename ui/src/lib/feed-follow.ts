import { createEffect, on, onCleanup, type Accessor } from "solid-js";

/**
 * Feed follow: one authority for whether the agent feed stays pinned to its newest output, shared by the Editor sidebar
 * and the Agents page. A pure state machine decides the mode; `createFeedFollow` binds it to a scroller and is the only
 * code that writes the feed's scroll position while following.
 *
 * Only a person detaches the feed. A scroll event counts as theirs while a wheel, touch, key or pointer gesture on the
 * scroller is recent or held; every other scroll event (the echo of a pin, a clamp after content shrank, a restore)
 * leaves the mode alone. Sending, the Latest pill and scrolling back to the bottom re-attach it.
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

const distanceOf = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight;
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
  const write = () => {
    const element = options.scroller();
    if (!element || !active()) return;
    const top = pinTop(state(), element);
    if (top === undefined || Math.abs(element.scrollTop - top) < 1) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    local = { ...local, lastTop: element.scrollTop };
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
  // A thread switch or a queued send flips the mode in the store: pin as soon as it reads following.
  createEffect(on(options.following, (following) => {
    dispatch({ type: "thread", following, top: options.scroller()?.scrollTop ?? 0 });
    syncAttribute();
    if (following) pin();
  }));
  onCleanup(() => {
    if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  });

  const observeSize = (target: Element) => {
    if (typeof ResizeObserver === "undefined") return () => undefined;
    // Runs after layout and before paint: pinning here shows the new content already at the bottom, without a lagging frame.
    const observer = new ResizeObserver(() => {
      dispatch({ type: target === options.scroller() ? "resized" : "grew" });
      write();
    });
    observer.observe(target);
    return () => observer.disconnect();
  };

  return {
    attach(scroller) {
      const gesture = () => dispatch({ type: "gesture", at: now() });
      const down = () => dispatch({ type: "hold", held: true, at: now() });
      const up = () => {
        if (local.held) dispatch({ type: "hold", held: false, at: now() });
      };
      const key = (event: KeyboardEvent) => {
        if (NAV_KEYS.has(event.key) && !typing(event.target)) gesture();
      };
      const scroll = () => {
        if (!active()) return;
        dispatch({ type: "scroll", at: now(), top: scroller.scrollTop, distance: distanceOf(scroller) });
        syncAttribute();
      };
      scroller.addEventListener("wheel", gesture, { passive: true });
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
        scroller.removeEventListener("wheel", gesture);
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
    observe: observeSize,
    pin,
    send() {
      dispatch({ type: "send" });
      pin();
    },
    jump() {
      dispatch({ type: "jump" });
      pin();
    },
    detach() {
      dispatch({ type: "detach" });
      syncAttribute();
    },
  };
}
