import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLimits } from "./limits";
import { agentLimit } from "../agent-errors";

const held = () => createRoot((dispose) => ({ limits: agentLimits.use(), dispose }));

afterEach(() => vi.useRealTimers());

describe("agent limits store", () => {
  it("marks a quota-limited model for every holder until a turn succeeds", () => {
    const sidebar = held();
    const page = held();
    expect(page.limits).toBe(sidebar.limits);
    sidebar.limits.markLimited({ kind: "quota", message: "out" } as never, "codex", "gpt");
    expect([...page.limits.limitedValues("codex")]).toEqual(["gpt"]);
    expect([...page.limits.limitedValues("claude")]).toEqual([]);
    expect(agentLimit()?.agentId).toBe("codex");
    page.limits.clearAfterSuccess("codex", "gpt");
    expect([...sidebar.limits.limitedValues("codex")]).toEqual([]);
    expect(agentLimit()).toBeUndefined();
    sidebar.dispose();
    page.dispose();
  });

  it("lifts the mark at the reset time, and drops its timer with the store", () => {
    vi.useFakeTimers();
    const first = held();
    first.limits.markLimited({ kind: "quota", message: "out", resetAt: Date.now() + 1000 } as never, "codex", "gpt");
    vi.advanceTimersByTime(1000);
    expect([...first.limits.limitedValues("codex")]).toEqual([]);
    first.limits.markLimited({ kind: "quota", message: "out", resetAt: Date.now() + 1000 } as never, "codex", "gpt");
    first.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const next = held();
    expect(next.limits.limitedModels()).toEqual({});
    next.dispose();
  });
});
