// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ContextHint, ContextMeter, ContextPopover, createCompaction, createStaleTracker } from "./ContextMeter";
import type { ContextUsage } from "../../lib/context-usage";
import type { DelegationTaskState } from "../../lib/agent-delegation";
import { key, mount, text } from "./test-utils";

const popover = (over: Partial<Parameters<typeof ContextPopover>[0]> = {}) => ({
  agent: { id: "claude", name: "Claude" },
  state: "live" as const,
  usage: { used: 84_000, size: 200_000 },
  now: 0,
  tasks: [],
  busy: false,
  onCompact: () => {},
  onClose: () => {},
  ...over,
});

describe("ContextMeter", () => {
  it("is a button with the numbers in its name and the tone of the window", () => {
    const toggle = vi.fn();
    const host = mount(() => <ContextMeter state="live" usage={{ used: 42_000, size: 100_000 }} agent="Claude" expanded={false} onToggle={toggle} />);
    const button = host.querySelector<HTMLButtonElement>("button.sb-ctx")!;
    expect(text(button)).toBe("42% context");
    expect(button.getAttribute("aria-label")).toBe("Context 42% used, 42,000 of 100,000 tokens. Show usage details");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.classList.contains("neutral")).toBe(true);
    expect(button.classList.contains("sb-ring")).toBe(true);
    button.click();
    expect(toggle).toHaveBeenCalledWith(button);
  });
  it("tones attention from 70% and danger over 90%", () => {
    const at = (used: number) => mount(() => <ContextMeter state="live" usage={{ used, size: 100 }} agent="A" expanded={false} onToggle={() => {}} />).querySelector("button")!;
    expect(at(69).classList.contains("neutral")).toBe(true);
    expect(at(70).classList.contains("attention")).toBe(true);
    expect(at(90).classList.contains("attention")).toBe(true);
    expect(at(91).classList.contains("danger")).toBe(true);
  });
  it("shows unknown, not reported and stale honestly", () => {
    const unknown = mount(() => <ContextMeter state="unknown" agent="A" expanded={false} onToggle={() => {}} />).querySelector("button")!;
    expect(text(unknown)).toBe("Context unknown");
    expect(unknown.classList.contains("unknown")).toBe(true);
    expect(unknown.querySelector(".sb-ring-value")).toBeNull();
    const unreported = mount(() => <ContextMeter state="unreported" agent="Codex" expanded={false} onToggle={() => {}} />).querySelector("button")!;
    expect(text(unreported)).toBe("Context not reported");
    expect(unreported.getAttribute("aria-label")).toContain("Codex has not reported context usage");
    const stale = mount(() => <ContextMeter state="stale" usage={{ used: 95, size: 100 }} agent="A" expanded={false} onToggle={() => {}} />).querySelector("button")!;
    expect(stale.classList.contains("stale")).toBe(true);
    expect(stale.classList.contains("danger")).toBe(false);
    expect(stale.getAttribute("aria-label")).toContain("from before the model switch");
  });
});

describe("ContextHint", () => {
  it("suggests Compact and sends it on click", () => {
    const compact = vi.fn();
    const dismiss = vi.fn();
    const host = mount(() => <ContextHint pct={86} showHint onCompact={compact} onDismiss={dismiss} />);
    expect(text(host.querySelector(".sb-ctx-hint-text"))).toBe("Context is 86% full. Compact?");
    const [go, close] = host.querySelectorAll("button");
    go.click();
    close.click();
    expect(compact).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it("shows nothing when the hint does not apply", () => {
    const host = mount(() => <ContextHint pct={86} showHint={false} onCompact={() => {}} onDismiss={() => {}} />);
    expect(host.querySelector(".sb-ctx-hint")).toBeNull();
  });
  it("shows the running, settled and failed run, with retry only on failure", () => {
    const retry = vi.fn();
    const running = mount(() => <ContextHint run={{ phase: "running", before: 86 }} showHint onCompact={retry} onDismiss={() => {}} />);
    expect(text(running)).toContain("Compacting context");
    expect(running.querySelector("button")).toBeNull();
    const done = mount(() => <ContextHint run={{ phase: "done", before: 86, after: 31 }} showHint onCompact={retry} onDismiss={() => {}} />);
    expect(text(done.querySelector(".sb-ctx-hint-text"))).toBe("Compacted, 86% to 31%");
    expect(done.querySelector("[role=status]")).not.toBeNull();
    const failed = mount(() => <ContextHint run={{ phase: "failed", error: "boom" }} showHint onCompact={retry} onDismiss={() => {}} />);
    expect(failed.querySelector("[role=alert]")!.classList.contains("failed")).toBe(true);
    failed.querySelector<HTMLButtonElement>("button")!.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("ContextPopover", () => {
  it("shows the window with a progressbar, cost, model and the advertised compact command", () => {
    const compact = vi.fn();
    const host = mount(() => <ContextPopover {...popover({ usage: { used: 172_000, size: 200_000, cost: { amount: 1.25, currency: "USD" } }, model: "Opus", compactCommand: "/compact", onCompact: compact })} />);
    const dialog = host.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Claude context usage");
    expect(dialog.classList.contains("sb-popover")).toBe(true);
    const bar = host.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("86");
    expect(bar.classList.contains("attention")).toBe(true);
    expect(text(host.querySelector(".sb-ctx-figures"))).toContain("172k of 200k tokens");
    expect(text(host.querySelector(".sb-ctx-facts"))).toContain("Session cost$1.25");
    expect(text(host.querySelector(".sb-ctx-facts"))).toContain("ModelOpus");
    const button = host.querySelector<HTMLButtonElement>(".sb-ctx-compact")!;
    expect(text(button)).toBe("Compact");
    button.click();
    expect(compact).toHaveBeenCalledOnce();
  });
  it("has no Compact button without a command, no cost without one and no limit line without a limit", () => {
    const host = mount(() => <ContextPopover {...popover()} />);
    expect(host.querySelector(".sb-ctx-compact")).toBeNull();
    expect(host.textContent).not.toContain("Session cost");
    expect(host.textContent).not.toContain("Limit");
  });
  it("shows a known limit with its reset", () => {
    const host = mount(() => <ContextPopover {...popover({ limit: { provider: "Anthropic", resetsAtMs: 7_200_000 }, now: 0 })} />);
    expect(text(host.querySelector(".sb-ctx-facts .danger"))).toBe("Anthropic limitLimit reached, resets in 2h");
  });
  it("disables Compact while running and offers retry after a failure", () => {
    const busy = mount(() => <ContextPopover {...popover({ compactCommand: "/compact", run: { phase: "running", before: 86 } })} />);
    const running = busy.querySelector<HTMLButtonElement>(".sb-ctx-compact")!;
    expect(running.disabled).toBe(true);
    expect(running.getAttribute("aria-busy")).toBe("true");
    expect(text(running)).toBe("Compacting");
    const failed = mount(() => <ContextPopover {...popover({ compactCommand: "/compact", run: { phase: "failed", error: "boom" } })} />);
    expect(text(failed.querySelector(".sb-ctx-compact"))).toBe("Retry compact");
    expect(text(failed.querySelector("[role=alert]"))).toBe("Compaction failed: boom");
  });
  it("explains unknown, unreported and stale", () => {
    expect(mount(() => <ContextPopover {...popover({ state: "unknown", usage: undefined })} />).textContent).toContain("No usage reported yet");
    expect(mount(() => <ContextPopover {...popover({ state: "unreported", usage: undefined })} />).textContent).toContain("Claude does not report context usage");
    const stale = mount(() => <ContextPopover {...popover({ state: "stale" })} />);
    expect(stale.textContent).toContain("From before the model switch");
    expect(stale.querySelector("[role=progressbar]")!.classList.contains("neutral")).toBe(true);
  });
  it("lists each live delegated agent with its own numbers after the lead", () => {
    const tasks = [
      { taskId: "a", child: {} as DelegationTaskState["child"], status: "running", agentName: "Codex", budgetUsed: { turns: 1, elapsedSeconds: 1, tokens: 20_000, contextSize: 200_000 } },
      { taskId: "b", child: {} as DelegationTaskState["child"], status: "completed", agentName: "Gone" },
    ] as DelegationTaskState[];
    const host = mount(() => <ContextPopover {...popover({ tasks })} />);
    const rows = host.querySelectorAll(".sb-ctx-row");
    expect(rows).toHaveLength(1);
    expect(text(rows[0].querySelector(".sb-ctx-row-name"))).toBe("Codex");
    expect(text(rows[0].querySelector(".sb-ctx-row-note"))).toBe("Peak 20k of 200k");
    expect(rows[0].querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("10");
    expect(rows[0].querySelector(".brand-icon")).not.toBeNull();
    expect(host.querySelectorAll("[role=progressbar]")[0].getAttribute("aria-valuenow")).toBe("42");
  });
  it("closes on Escape", () => {
    const close = vi.fn();
    mount(() => <ContextPopover {...popover({ onClose: close })} />);
    key("Escape");
    expect(close).toHaveBeenCalledOnce();
  });
});

/** Builds inside a reactive root and returns, so effects are live before the test acts. */
function inRoot<T>(build: () => T): T & { dispose: () => void } {
  return createRoot((dispose) => ({ ...build(), dispose }));
}

describe("createCompaction", () => {
  it("sends the command, then settles with before and after from the next usage update", () => {
    const send = vi.fn();
    const t = inRoot(() => {
      const [usage, setUsage] = createSignal<ContextUsage | undefined>({ used: 86, size: 100 });
      const [running, setRunning] = createSignal(false);
      return { setUsage, setRunning, run: createCompaction({ usage, running, failure: () => undefined, compactions: () => [], send }) };
    });
    t.run.start("/compact");
    expect(send).toHaveBeenCalledWith("/compact");
    expect(t.run.run()).toEqual({ phase: "running", before: 86 });
    t.setRunning(true);
    t.setUsage({ used: 31, size: 100 });
    t.setRunning(false);
    expect(t.run.run()).toEqual({ phase: "done", before: 86, after: 31 });
    t.dispose();
  });
  it("fails when the turn ends with a new failure, and follows ACP compaction updates", () => {
    const t = inRoot(() => {
      const [running, setRunning] = createSignal(false);
      const [failure, setFailure] = createSignal<{ message: string }>();
      const [items, setItems] = createSignal<{ compactionId: string; status: string; error?: string }[]>([{ compactionId: "old", status: "failed" }]);
      return { setRunning, setFailure, items, setItems, run: createCompaction({ usage: () => ({ used: 90, size: 100 }), running, failure, compactions: items, send: () => {} }) };
    });
    t.run.start("/compact");
    expect(t.run.run()!.phase).toBe("running");
    t.setRunning(true);
    t.setFailure({ message: "Prompt failed: offline" });
    t.setRunning(false);
    expect(t.run.run()).toMatchObject({ phase: "failed", error: "Prompt failed: offline" });
    t.run.start("/compact");
    expect(t.run.run()!.phase).toBe("running");
    t.setItems([...t.items(), { compactionId: "c-2", status: "failed", error: "too large" }]);
    expect(t.run.run()).toMatchObject({ phase: "failed", error: "too large" });
    t.dispose();
  });
});

describe("createStaleTracker", () => {
  it("marks usage stale after a model switch until the next report", () => {
    const t = inRoot(() => {
      const [usage, setUsage] = createSignal<ContextUsage | undefined>({ used: 1, size: 10 });
      const [model, setModel] = createSignal<string | undefined>("Opus");
      return { setUsage, setModel, stale: createStaleTracker(usage, model) };
    });
    expect(t.stale()).toBe(false);
    t.setModel("Sonnet");
    expect(t.stale()).toBe(true);
    t.setUsage({ used: 2, size: 10 });
    expect(t.stale()).toBe(false);
    t.dispose();
  });
});
