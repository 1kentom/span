import { createRoot, getOwner, onCleanup } from "solid-js";

/**
 * An app-wide store (ADR 0011 phase 2): one instance while anything holds it, so the sidebar and the Agents page read
 * the same state. The store lives in its own reactive root. It is created by the first `use()` and disposed when the
 * last holder's owner is cleaned up, so a later holder (another workspace window, the next test) starts fresh.
 */
export type SharedStore<T> = {
  /** The shared instance, held until the calling owner is cleaned up. Outside an owner it is held until `release`. */
  use(): T;
  /** Drops one hold taken outside an owner. */
  release(): void;
  /** The live instance, if anything holds one. Never creates it. */
  peek(): T | undefined;
};

export function sharedStore<T>(create: (dispose: () => void) => T): SharedStore<T> {
  let instance: { value: T; dispose: () => void } | undefined;
  let holders = 0;
  const release = () => {
    if (!instance || holders === 0) return;
    holders -= 1;
    if (holders > 0) return;
    const { dispose } = instance;
    instance = undefined;
    dispose();
  };
  return {
    use() {
      if (!instance) {
        // The root's dispose runs the store's own cleanups (timers, subscriptions).
        createRoot((dispose) => {
          instance = { value: create(dispose), dispose };
        });
      }
      holders += 1;
      if (getOwner()) onCleanup(release);
      return instance!.value;
    },
    release,
    peek: () => instance?.value,
  };
}
