import { describe, expect, it } from "vitest";
import type { AgentEvent, SessionUsageRow_Serialize as SessionUsageRow, UsageCost } from "../bindings";
import { assignSlots, compactTokens, costText, createUsageRecorder, rangeFor, turnTokenCounts, usageCsv } from "./usage";

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
