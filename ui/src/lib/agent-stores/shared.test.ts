import { createRoot, createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { sharedStore } from "./shared";

describe("sharedStore", () => {
  it("gives every holder the same instance while one is held", () => {
    const create = vi.fn(() => createSignal(0));
    const store = sharedStore(create);
    const first = createRoot((dispose) => ({ value: store.use(), dispose }));
    const second = createRoot((dispose) => ({ value: store.use(), dispose }));
    expect(second.value).toBe(first.value);
    expect(create).toHaveBeenCalledTimes(1);
    first.value[1](3);
    expect(second.value[0]()).toBe(3);
    first.dispose();
    expect(store.peek()).toBe(first.value);
    second.dispose();
  });

  it("disposes the store with its last holder, and the next holder starts fresh", () => {
    const cleaned = vi.fn();
    const store = sharedStore(() => {
      onCleanup(cleaned);
      return createSignal(0);
    });
    const held = createRoot((dispose) => ({ value: store.use(), dispose }));
    held.value[1](5);
    held.dispose();
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(store.peek()).toBeUndefined();
    const next = createRoot((dispose) => ({ value: store.use(), dispose }));
    expect(next.value).not.toBe(held.value);
    expect(next.value[0]()).toBe(0);
    next.dispose();
  });

  it("holds outside an owner until release", () => {
    const store = sharedStore(() => ({}));
    const value = store.use();
    expect(store.peek()).toBe(value);
    store.release();
    expect(store.peek()).toBeUndefined();
    store.release();
    expect(store.peek()).toBeUndefined();
  });
});
