import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { stepReveal, type RevealState } from "./stream-reveal";

/** A message that mounts mid stream with more than this already received shows it at once instead of replaying it. */
export const REPLAY_LIMIT = 400;
/** No new text for this long counts as a pause: the held back tail (half a word, an open bold run) is shown. */
export const STALL_MS = 300;

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const frame = (callback: (now: number) => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : (setTimeout(() => callback(clock()), 16) as unknown as number);
const cancelFrame = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

export interface StreamReveal {
  /** The prefix of the received text to render this frame. */
  shown: Accessor<string>;
  /** True while the shown text trails the received text. */
  revealing: Accessor<boolean>;
  /** True when newly shown text should fade in (streaming, motion allowed). */
  animate: Accessor<boolean>;
}

/**
 * Paces streamed text onto the screen, at most one update per animation frame. Text that is not streaming is shown in
 * full immediately; when streaming ends, the hidden rest is flushed within FLUSH_MS.
 */
export function createStreamReveal(text: Accessor<string>, streaming: Accessor<boolean>, options: { reducedMotion?: boolean } = {}): StreamReveal {
  const reduced = options.reducedMotion ?? prefersReducedMotion();
  const initial = untrack(text);
  const startHidden = untrack(streaming) && initial.length <= REPLAY_LIMIT;
  let state: RevealState = { revealed: startHidden ? 0 : initial.length, rate: 0 };
  const [shown, setShown] = createSignal(startHidden ? "" : initial);
  const [revealing, setRevealing] = createSignal(false);
  let pending: number | undefined;
  let last = 0;
  let lastArrival = clock();
  let lastLength = initial.length;
  /** Streamed at some point and not yet fully shown: keeps pacing through the end of the turn. */
  let flushing = untrack(streaming);

  const tick = (now: number) => {
    pending = undefined;
    const source = untrack(text);
    const elapsed = last ? Math.min(now - last, 100) : 16;
    last = now;
    const done = !untrack(streaming) || now - lastArrival >= STALL_MS;
    state = stepReveal(source, state, elapsed, { done, reducedMotion: reduced });
    setShown(source.slice(0, state.revealed));
    const behind = state.revealed < source.length;
    setRevealing(behind);
    if (behind) pending = frame(tick);
    else {
      last = 0;
      if (!untrack(streaming)) flushing = false;
    }
  };

  createEffect(() => {
    const source = text();
    const live = streaming();
    if (source.length !== lastLength) lastArrival = clock();
    lastLength = source.length;
    // Replaced text (a new chat, an edit) or text that never streamed is shown as it is, at once.
    const continues = source.startsWith(untrack(shown));
    if (!continues || !(live || flushing)) {
      if (pending !== undefined) cancelFrame(pending);
      pending = undefined;
      last = 0;
      state = { revealed: source.length, rate: 0 };
      setShown(source);
      setRevealing(false);
      flushing = live;
      return;
    }
    flushing = true;
    if (pending === undefined && (state.revealed < source.length || !live)) pending = frame(tick);
  });

  onCleanup(() => {
    if (pending !== undefined) cancelFrame(pending);
  });

  return { shown, revealing, animate: () => !reduced && (streaming() || revealing()) };
}
