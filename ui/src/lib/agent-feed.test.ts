import { describe, expect, it } from "vitest";
import type { ToolEvent } from "./agent-feed";
import { formatElapsed, isNearBottom, isNestedTool, relativeTime, subagentChildren, toolSummary } from "./agent-feed";

const tool = (id: string, parent?: string): ToolEvent => ({ kind: "tool", sessionId: "s", toolCallId: id, title: id, status: "pending", toolKind: null, parentToolCallId: parent ?? null, contentJson: "{}" });
const item = (event: ToolEvent) => ({ kind: "tool", event });

describe("agent feed helpers", () => {
  it("summarizes the target of a tool call", () => {
    expect(toolSummary(JSON.stringify({ rawInput: { command: "git  status\n--short" } }))).toBe("git status --short");
    expect(toolSummary(JSON.stringify({ locations: [{ path: "/w/a.ts" }] }))).toBe("/w/a.ts");
    expect(toolSummary("not json")).toBe("");
    expect(toolSummary(JSON.stringify({ rawInput: { command: "x".repeat(400) } })).length).toBe(240);
  });

  it("nests only calls whose parent is present", () => {
    const items = [item(tool("task")), item(tool("child", "task")), item(tool("orphan", "missing"))];
    expect(subagentChildren(items, "task").map((event) => event.toolCallId)).toEqual(["child"]);
    expect(isNestedTool(items, items[1].event)).toBe(true);
    expect(isNestedTool(items, items[2].event)).toBe(false);
    expect(isNestedTool(items, items[0].event)).toBe(false);
  });

  it("detects a scroller that is pinned to the bottom", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false);
  });

  it("formats durations and relative times", () => {
    expect(formatElapsed(4200)).toBe("4s");
    expect(formatElapsed(125000)).toBe("2m 05s");
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(relativeTime("2026-10-28T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-10-26T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("garbage", now)).toBe("");
    expect(relativeTime(null, now)).toBe("");
  });
});
