import { describe, expect, it } from "vitest";
import {
  agentUsageRows,
  compactCommand,
  compactHint,
  compactRunText,
  compactStep,
  compactionMessage,
  contextPercent,
  contextTone,
  formatCost,
  formatTokens,
  formatWait,
  limitText,
  meterAria,
  meterLabel,
  meterState,
  showCompactHint,
  startCompaction,
} from "./context-usage";
import type { DelegationTaskState } from "./agent-delegation";

const task = (over: Partial<DelegationTaskState>): DelegationTaskState => ({
  taskId: "t1",
  child: { connectionId: "c", sessionId: "s" } as DelegationTaskState["child"],
  status: "running",
  ...over,
});
const budget = (over: Partial<NonNullable<DelegationTaskState["budgetUsed"]>>) => ({ turns: 1, elapsedSeconds: 1, ...over });

describe("percent and tone", () => {
  it("rounds, clamps and refuses unusable sizes", () => {
    expect(contextPercent(42_000, 100_000)).toBe(42);
    expect(contextPercent(250, 200)).toBe(100);
    expect(contextPercent(-5, 100)).toBe(0);
    expect(contextPercent(5, 0)).toBeUndefined();
    expect(contextPercent(5, Number.NaN)).toBeUndefined();
    expect(contextPercent(undefined, 100)).toBeUndefined();
  });
  it("is neutral under 70, attention from 70 to 90, danger over 90", () => {
    expect(contextTone(undefined)).toBe("neutral");
    expect(contextTone(69)).toBe("neutral");
    expect(contextTone(70)).toBe("attention");
    expect(contextTone(90)).toBe("attention");
    expect(contextTone(91)).toBe("danger");
  });
});

describe("formatting", () => {
  it("shortens token counts without rounding up", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_900)).toBe("12k");
    expect(formatTokens(128_000)).toBe("128k");
    expect(formatTokens(999_999)).toBe("999k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_560_000)).toBe("1.5M");
  });
  it("shows cost only with a currency", () => {
    expect(formatCost({ amount: 1.5, currency: "USD" })).toBe("$1.50");
    expect(formatCost({ amount: 0.0123, currency: "USD" })).toBe("$0.0123");
    expect(formatCost({ amount: 1.5, currency: null })).toBeUndefined();
    expect(formatCost({ amount: null, currency: "USD" })).toBeUndefined();
    expect(formatCost(undefined)).toBeUndefined();
    expect(formatCost({ amount: 2, currency: "not-a-code" })).toBe("2 not-a-code");
  });
  it("rounds waits up", () => {
    expect(formatWait(30_000)).toBe("1m");
    expect(formatWait(45 * 60_000)).toBe("45m");
    expect(formatWait(61 * 60_000)).toBe("2h");
    expect(formatWait(3 * 24 * 3_600_000)).toBe("3d");
  });
});

describe("meter state and labels", () => {
  it("separates unknown, unreported, stale and live", () => {
    expect(meterState({ turnFinished: false, stale: false })).toBe("unknown");
    expect(meterState({ turnFinished: true, stale: false })).toBe("unreported");
    expect(meterState({ usage: { used: 1, size: 0 }, turnFinished: true, stale: false })).toBe("unreported");
    expect(meterState({ usage: { used: 1, size: 10 }, turnFinished: false, stale: true })).toBe("stale");
    expect(meterState({ usage: { used: 1, size: 10 }, turnFinished: false, stale: false })).toBe("live");
  });
  it("labels each state and puts the numbers in the accessible name", () => {
    expect(meterLabel("live", 42)).toBe("42% context");
    expect(meterLabel("stale", 42)).toBe("42% context");
    expect(meterLabel("unknown", undefined)).toBe("Context unknown");
    expect(meterLabel("unreported", undefined)).toBe("Context not reported");
    const aria = meterAria("live", { used: 42_000, size: 100_000, cost: { amount: 0.5, currency: "USD" } }, "Claude");
    expect(aria).toBe("Context 42% used, 42,000 of 100,000 tokens, cost $0.50. Show usage details");
    expect(meterAria("stale", { used: 1, size: 10 }, "Claude")).toContain("from before the model switch");
    expect(meterAria("unreported", undefined, "Codex")).toContain("Codex has not reported");
  });
});

describe("compaction", () => {
  it("finds only an advertised compact command", () => {
    expect(compactCommand([{ name: "review" }])).toBeUndefined();
    expect(compactCommand([{ name: "compact" }])).toBe("/compact");
    expect(compactCommand([{ name: "/compact" }])).toBe("/compact");
  });
  it("hints from 80% only when the agent can compact and nothing is in the way", () => {
    const base = { pct: 80, canCompact: true, dismissed: false, running: false, stale: false, compacting: false };
    expect(showCompactHint(base)).toBe(true);
    expect(showCompactHint({ ...base, pct: 79 })).toBe(false);
    expect(showCompactHint({ ...base, canCompact: false })).toBe(false);
    expect(showCompactHint({ ...base, dismissed: true })).toBe(false);
    expect(showCompactHint({ ...base, running: true })).toBe(false);
    expect(showCompactHint({ ...base, stale: true })).toBe(false);
    expect(showCompactHint({ ...base, pct: undefined })).toBe(false);
    expect(compactHint(86)).toBe("Context is 86% full. Compact?");
  });
  it("says both numbers only when both are known", () => {
    expect(compactionMessage(86, 31)).toBe("Compacted, 86% to 31%");
    expect(compactionMessage(86, undefined)).toBe("Compacted");
    expect(compactionMessage(undefined, 31)).toBe("Compacted");
  });
  it("follows usage, compaction updates and the turn end", () => {
    let run = startCompaction(86);
    expect(compactRunText(run)).toBe("Compacting context");
    run = compactStep(run, { kind: "usage", pct: 31 });
    run = compactStep(run, { kind: "turnEnd" });
    expect(run).toEqual({ phase: "done", before: 86, after: 31 });
    expect(compactRunText(run)).toBe("Compacted, 86% to 31%");
    expect(compactStep(run, { kind: "usage", pct: 50 }).after).toBe(31);
  });
  it("takes a usage update that lands after the turn ended", () => {
    const done = compactStep(startCompaction(86), { kind: "compaction", status: "completed" });
    expect(done.phase).toBe("done");
    expect(compactStep(done, { kind: "usage", pct: 30 }).after).toBe(30);
  });
  it("fails on a failed or cancelled compaction or a turn error", () => {
    expect(compactStep(startCompaction(90), { kind: "compaction", status: "failed", error: "boom" })).toMatchObject({ phase: "failed", error: "boom" });
    expect(compactStep(startCompaction(90), { kind: "compaction", status: "cancelled" }).phase).toBe("failed");
    const failed = compactStep(startCompaction(90), { kind: "turnEnd", error: "Prompt failed" });
    expect(compactRunText(failed)).toBe("Compaction failed: Prompt failed");
    expect(compactStep(failed, { kind: "turnEnd" })).toBe(failed);
    expect(compactStep(startCompaction(90), { kind: "compaction", status: "in_progress" }).phase).toBe("running");
  });
});

describe("limits", () => {
  it("names the reset only when it is known and ahead", () => {
    expect(limitText({ provider: "Anthropic", resetsAtMs: 2 * 3_600_000 }, 0)).toBe("Limit reached, resets in 2h");
    expect(limitText({ provider: "Anthropic" }, 0)).toBe("Limit reached");
    expect(limitText({ resetsAtMs: 10 }, 20)).toBe("Limit reached");
  });
});

describe("agent rows", () => {
  it("puts the lead first and keeps each agent's own numbers", () => {
    const rows = agentUsageRows({
      lead: { id: "claude", name: "Claude", usage: { used: 92_000, size: 100_000, cost: { amount: 1, currency: "USD" } } },
      tasks: [
        task({ taskId: "a", agentName: "Codex", budgetUsed: budget({ tokens: 20_000, contextSize: 200_000 }) }),
        task({ taskId: "b", agentName: "Gemini", budgetUsed: budget({ tokens: 500_000, contextSize: 200_000 }) }),
        task({ taskId: "c", agentName: "OpenCode" }),
        task({ taskId: "d", agentName: "Done", status: "completed", budgetUsed: budget({ tokens: 1, contextSize: 10 }) }),
      ],
    });
    expect(rows.map((row) => row.name)).toEqual(["Claude", "Codex", "Gemini", "OpenCode"]);
    expect(rows[0]).toMatchObject({ lead: true, pct: 92, tone: "danger", cost: "$1.00", note: "92k of 100k" });
    expect(rows[1]).toMatchObject({ lead: false, pct: 10, tone: "neutral", note: "Peak 20k of 200k" });
    // Summed turn totals over the window are not a context share.
    expect(rows[2]).toMatchObject({ pct: undefined, note: "500k tokens reported" });
    expect(rows[3]).toMatchObject({ pct: undefined, note: "Not reported" });
  });
  it("marks a stale lead and never tones it", () => {
    const [lead] = agentUsageRows({ lead: { name: "Claude", usage: { used: 95, size: 100 }, stale: true }, tasks: [] });
    expect(lead.tone).toBe("neutral");
    expect(lead.note).toBe("95 of 100, before model switch");
    expect(agentUsageRows({ lead: { name: "Claude" }, tasks: [] })[0].note).toBe("Not reported");
  });
});
