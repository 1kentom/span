import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionUsageRow_Serialize as SessionUsageRow, UsageCost } from "../bindings";
import { assignSlots, chartColumns, compactTokens, costShort, costText, createUsageRecorder, deltaText, percentChange, previousRangeFor, providerKey, rangeFor, relativeTime, shareText, sparkline, sumTotals, turnTokenCounts, usageCsv, usdShort } from "./usage";

const cost = (patch: Partial<UsageCost>): UsageCost => ({ usd: 0, reportedUsd: 0, estimatedUsd: 0, unpricedTokens: 0, known: false, complete: true, ...patch });

describe("usage recorder", () => {
  it("turns a finished turn into one patch with tokens, cumulative cost and context, and nothing per update", () => {
    const recorder = createUsageRecorder();
    const usage = { kind: "usage", sessionId: "s1", used: 42_000, size: 200_000, costAmount: 0.125, costCurrency: "USD" } as AgentEvent;
    expect(recorder.observe(usage, { agentId: "claude" })).toBeUndefined();
    const complete = { kind: "complete", sessionId: "s1", stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 9000, totalTokens: 10_500 } } as AgentEvent;
    const patch = recorder.observe(complete, { agentId: "claude", model: "claude-opus-5-5", day: "2026-10-29" });
    expect(patch).toEqual({
      agentId: "claude",
      sessionId: "s1",
      usage: {
        day: "2026-10-29",
        model: "claude-opus-5-5",
        tokens: { input: 1200, output: 300, cacheRead: 9000, cacheWrite: 0, thought: 0, total: 10_500 },
        costTotal: { micros: 125_000, currency: "USD" },
        context: { used: 42_000, size: 200_000 },
      },
    });
  });

  it("records a turn without tokens or cost, and nothing without an agent id", () => {
    const recorder = createUsageRecorder();
    const complete = { kind: "complete", sessionId: "s2", stopReason: "end_turn" } as AgentEvent;
    expect(recorder.observe(complete, { agentId: undefined })).toBeUndefined();
    expect(recorder.observe(complete, { agentId: "codex", day: "2026-10-29" })).toEqual({ agentId: "codex", sessionId: "s2", usage: { day: "2026-10-29" } });
  });

  it("reads snake case token fields and ignores junk", () => {
    expect(turnTokenCounts({ input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 7 })).toEqual({ input: 5, output: 2, cacheRead: 0, cacheWrite: 7, thought: 0, total: 0 });
    expect(turnTokenCounts({ inputTokens: -1, outputTokens: "9" })).toBeUndefined();
    expect(turnTokenCounts(null)).toBeUndefined();
  });
});

describe("usage formatting", () => {
  it("never shows an unknown price as zero and marks partial totals", () => {
    expect(costText(cost({ known: false })).text).toBe("No price");
    expect(costText(cost({ known: true, usd: 0 })).text).toBe("$0.00");
    const partial = costText(cost({ known: true, usd: 12.5, estimatedUsd: 12.5, complete: false, unpricedTokens: 400 }));
    expect(partial.text).toBe("$12.50+");
    expect(partial.title).toContain("400 tokens without a price");
    expect(partial.title).toContain("Not your subscription bill");
  });

  it("compacts token counts", () => {
    expect([0, 950, 12_345, 4_560_000, 1_200_000_000].map(compactTokens)).toEqual(["0", "950", "12.3k", "4.56M", "1.2B"]);
  });

  it("builds local day ranges ending today", () => {
    const now = new Date(2026, 9, 29, 15, 0);
    const offset = -now.getTimezoneOffset();
    expect(rangeFor("today", now)).toEqual({ from: "2026-10-29", to: "2026-10-29", utcOffsetMinutes: offset });
    expect(rangeFor("7d", now)).toMatchObject({ from: "2026-10-23", to: "2026-10-29" });
    expect(rangeFor("30d", now)).toMatchObject({ from: "2026-09-30", to: "2026-10-29" });
    expect(rangeFor("all", now)).toEqual({ utcOffsetMinutes: offset });
    expect(rangeFor("all", now, "imported")).toEqual({ utcOffsetMinutes: offset, source: "imported" });
  });
});

describe("usage series slots", () => {
  it("keeps common agents on their own slot and folds a sixth agent into Other", () => {
    const slots = assignSlots(["zed-agent", "codex", "claude", "alpha", "beta", "gamma"]);
    expect(slots.get("claude")).toBe(1);
    expect(slots.get("codex")).toBe(2);
    expect(slots.get("alpha")).toBe(3);
    expect(slots.get("beta")).toBe(4);
    expect(slots.get("gamma")).toBe(5);
    expect(slots.get("zed-agent")).toBe("other");
    // Colour follows the agent: a filter that drops others keeps Codex on slot 2.
    expect(assignSlots(["codex"]).get("codex")).toBe(2);
  });
});

describe("usage CSV", () => {
  it("quotes fields, neutralises formulas and leaves unknown costs empty", () => {
    const row: SessionUsageRow = {
      imported: false,
      agentId: "claude",
      agentName: "Claude, Code",
      sessionId: "s-1",
      title: "=SUM(A1)",
      firstSeenMs: 0,
      lastActiveMs: Date.UTC(2026, 9, 29),
      models: ["opus"],
      totals: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thought: 0, total: 10 }, turns: 1, turnsWithTokens: 1, sessions: 1, cost: cost({ known: false, complete: false }) },
      contextPeak: 0,
      contextSize: 0,
    };
    const [header, line] = usageCsv([row]).trim().split("\n");
    expect(header.split(",")).toContain("cost_usd_estimate");
    expect(line).toBe(`tracked,"Claude, Code",claude,s-1,'=SUM(A1),,2026-10-29T00:00:00.000Z,opus,1,1,2,3,4,0,10,,,`);
  });
});

describe("usage aggregation helpers", () => {
  const totals = (input: number, c: UsageCost, sessions = 1) => ({ tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, thought: 0, total: input }, turns: 1, turnsWithTokens: 1, sessions, cost: c });

  it("sums totals, keeps unknown cost out of the dollars and marks the sum partial", () => {
    const sum = sumTotals([totals(10, cost({ known: true, usd: 2, estimatedUsd: 2 })), totals(5, cost({ known: false, complete: false, unpricedTokens: 5 }), 2)]);
    expect(sum.tokens.total).toBe(15);
    expect(sum.sessions).toBe(3);
    expect(sum.cost).toMatchObject({ known: true, usd: 2, complete: false, unpricedTokens: 5 });
    expect(sumTotals([]).cost.known).toBe(false);
  });

  it("groups imported and tracked agents of one family into one provider", () => {
    expect(["claude", "claude-acp", "claude-code-logs", "codex-logs", "codex-acp", "gemini-cli", "opencode", "zed-agent"].map(providerKey)).toEqual(["claude", "claude", "claude", "codex", "codex", "gemini", "opencode", "zed-agent"]);
  });

  it("builds even chart columns, fills gaps, filters series and folds long ranges into weeks", () => {
    const priced = cost({ known: true, usd: 1, estimatedUsd: 1 });
    const days = [
      { day: "2026-10-01", agents: [{ agentId: "claude", tokens: 10, cost: priced }, { agentId: "claude-code-logs", tokens: 5, cost: priced }, { agentId: "codex", tokens: 3, cost: priced }] },
      { day: "2026-10-03", agents: [{ agentId: "codex", tokens: 7, cost: priced }] },
    ];
    const { columns, weekly } = chartColumns(days, providerKey);
    expect(weekly).toBe(false);
    expect(columns.map((column) => column.start)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(columns[0].values.get("claude")).toMatchObject({ tokens: 15, cost: { usd: 2 } });
    expect(columns[1].values.size).toBe(0);
    expect(chartColumns(days, providerKey, new Set(["codex"])).columns[0].values.has("claude")).toBe(false);
    const long = Array.from({ length: 130 }, (_, index) => ({ day: `2026-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`, agents: [] }));
    expect(chartColumns(long, providerKey, undefined, 120).weekly).toBe(true);
  });

  it("finds the previous period of equal length and formats deltas", () => {
    const now = new Date(2026, 9, 29, 15, 0);
    expect(previousRangeFor("7d", now)).toMatchObject({ from: "2026-10-16", to: "2026-10-22" });
    expect(previousRangeFor("today", now)).toMatchObject({ from: "2026-10-28", to: "2026-10-28" });
    expect(previousRangeFor("all", now)).toBeUndefined();
    expect(rangeFor("90d", now)).toMatchObject({ from: "2026-08-01", to: "2026-10-29" });
    expect(percentChange(112, 100)).toBe(12);
    expect(percentChange(5, 0)).toBeUndefined();
    expect(deltaText(12)).toBe("+12%");
    expect(deltaText(-4)).toBe("\u22124%");
    expect(deltaText(0)).toBe("No change");
  });

  it("formats short costs, shares, sparklines and relative times", () => {
    expect(usdShort(0.1291)).toBe("$0.13");
    expect(usdShort(0.004)).toBe("<$0.01");
    expect(costShort(cost({ known: true, usd: 3.456, complete: false, unpricedTokens: 1 })).text).toBe("$3.46+");
    expect(costShort(cost({ known: false })).text).toBe("No price");
    expect(shareText(1, 1000)).toBe("<1%");
    expect(shareText(0, 10)).toBe("0%");
    expect(shareText(27, 100)).toBe("27%");
    expect(sparkline([1, 2, 3, 4], 2)).toEqual([3, 7]);
    expect(sparkline([1, 2], 24)).toEqual([1, 2]);
    const now = Date.UTC(2026, 9, 29, 12);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
  });
});

describe("usage styles", () => {
  it("use theme tokens only: no hex colours in usage.css, and every chart slot defined for Dark and Light", () => {
    const root = resolve(__dirname, "../..");
    const source = readFileSync(resolve(root, "src/styles/usage.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    const workbench = readFileSync(resolve(root, "src/styles/workbench.css"), "utf8").split("\n");
    for (const selector of [".ide{--viz-1", ".ide.theme-light{--viz-1"]) {
      const line = workbench.find((entry) => entry.startsWith(selector)) ?? "";
      for (const slot of ["--viz-1", "--viz-2", "--viz-3", "--viz-4", "--viz-5", "--viz-other", "--viz-grid"]) expect(line).toContain(`${slot}:`);
    }
  });
});
