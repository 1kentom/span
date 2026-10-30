import { describe, expect, it } from "vitest";
import type { FeedItem } from "./agent-session";
import type { LiveAgent } from "./live-agents";
import { agentTree, compactTokens, runningCommands, usageMeta } from "./agents-page-tree";

const lead: LiveAgent = { key: "claude", id: "claude-acp", name: "Claude", state: "Working", lead: true, detail: "Opus" };
const codex: LiveAgent = { key: "codex", id: "codex-acp", name: "Codex", state: "Working", taskId: "t1", detail: "Running the UI tests" };
const gemini: LiveAgent = { key: "gemini", id: "gemini-cli", name: "Gemini CLI", state: "Failed", taskId: "t2", detail: "Budget exceeded" };
const child = { connectionId: "c", sessionId: "k" };
const feed = [
  { id: 1, kind: "delegation", task: { taskId: "t1", child, agentName: "Codex", model: "GPT-5 mini", status: "running", budgetUsed: { turns: 3, tokens: 12_400, elapsedSeconds: 80 } } },
  { id: 2, kind: "delegation", task: { taskId: "t2", child, agentName: "Gemini CLI", status: "failed" } },
  { id: 3, kind: "tool", event: { kind: "tool", sessionId: "s", toolCallId: "a", title: "pnpm test", status: "in_progress", toolKind: "execute", parentToolCallId: null, contentJson: "[]" } },
  { id: 4, kind: "tool", event: { kind: "tool", sessionId: "s", toolCallId: "b", title: "ls", status: "completed", toolKind: "execute", parentToolCallId: null, contentJson: "[]" } },
  { id: 5, kind: "tool", event: { kind: "tool", sessionId: "s", toolCallId: "c", title: "read", status: "in_progress", toolKind: "read", parentToolCallId: null, contentJson: "[]" } },
] as unknown as FeedItem[];

describe("Agents tab tree", () => {
  it("puts the lead first, then delegates and running commands as nested rows, the last one ending the line", () => {
    const tree = agentTree({ agents: [lead, codex, gemini], feed, showHealth: true, leadRunning: true });
    expect(tree.nodes.map((node) => [node.kind, node.child, node.last, node.name, node.role, node.state])).toEqual([
      ["agent", false, false, "Claude", "Lead", "Working"],
      ["agent", true, false, "Codex", "Delegated", "Working"],
      ["agent", true, false, "Gemini CLI", "Delegated", "Failed"],
      ["command", true, true, "pnpm test", "", "Running"],
    ]);
    expect(tree.nodes[0]).toMatchObject({ model: "Opus", meta: "3 tool calls", live: true });
    expect(tree.nodes[1]).toMatchObject({ model: "GPT-5 mini", meta: "12k tokens · 3 turns · 1m 20s", note: "Running the UI tests", canStop: true, taskId: "t1" });
    expect(tree.nodes[2]).toMatchObject({ tone: "error", canStop: false, note: "Budget exceeded" });
    expect(tree.nodes[2].model).toBeUndefined();
    expect(tree.nodes[3]).toMatchObject({ tone: "running", toolCallId: "a" });
    expect(tree.head).toBe("3 running");
    expect(tree.sub).toBe("depth 1 of 1");
    expect(tree.canStopAll).toBe(true);
  });

  it("summarises an idle or finished crew and has no rows without a lead", () => {
    expect(agentTree({ agents: [], feed: [], showHealth: true, leadRunning: false }).nodes).toEqual([]);
    const idle = agentTree({ agents: [{ ...lead, state: "Idle" }], feed: [], showHealth: true, leadRunning: false });
    expect([idle.head, idle.canStopAll, idle.nodes[0].last]).toEqual(["Idle", false, true]);
    const done = agentTree({ agents: [{ ...lead, state: "Idle" }, { ...codex, state: "Done" }], feed: [], showHealth: true, leadRunning: false });
    expect(done.head).toBe("All done");
    const waiting = agentTree({ agents: [lead, { ...codex, state: "Waiting for you" }], feed: [], showHealth: true, leadRunning: true });
    expect([waiting.head, waiting.sub]).toEqual(["1 running", "1 waiting for you · depth 1 of 1"]);
  });

  it("formats usage and lists only unfinished execute calls", () => {
    expect(compactTokens(980)).toBe("980");
    expect(compactTokens(1200)).toBe("1.2k");
    expect(compactTokens(45_600)).toBe("46k");
    expect(usageMeta(undefined)).toBeUndefined();
    expect(runningCommands(feed).map((item) => item.event.toolCallId)).toEqual(["a"]);
  });
});
