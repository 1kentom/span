import { describe, expect, it } from "vitest";
import type { AgentHealth } from "./agent-health";
import type { DelegationTaskState } from "./agent-delegation";
import { bareAgentId, friendlyAgentName, liveAgentsOf, liveStateText, liveSummary, liveTone, orderByUrgency, resolveInstalled, stackOf, type LiveAgent, type LiveState } from "./live-agents";

const agent = (name: string, state: LiveState, extra: Partial<LiveAgent> = {}): LiveAgent => ({ key: name.toLowerCase(), name, state, ...extra });
const health = (state: AgentHealth["state"]): AgentHealth => ({ agentId: "x", state, latencyMs: null, checkedAtMs: 0, detail: null });

describe("friendly agent names", () => {
  it("cleans ids and package names, never showing a scoped package", () => {
    expect(friendlyAgentName("@agentclientprotocol/claude-agent-acp")).toBe("Claude Agent");
    expect(friendlyAgentName("@zed-industries/codex-acp@0.4.1")).toBe("Codex");
    expect(friendlyAgentName("gemini-cli")).toBe("Gemini CLI");
    expect(friendlyAgentName("opencode")).toBe("OpenCode");
    expect(friendlyAgentName("/usr/local/bin/qwen-code")).toBe("Qwen Code");
    expect(friendlyAgentName("acp")).toBe("ACP");
  });

  it("keeps display names and never returns an empty name", () => {
    expect(friendlyAgentName("Claude Agent")).toBe("Claude Agent");
    expect(friendlyAgentName("OpenCode")).toBe("OpenCode");
    expect(friendlyAgentName("GitHub Copilot")).toBe("GitHub Copilot");
    expect(friendlyAgentName("")).toBe("Agent");
    expect(friendlyAgentName(undefined)).toBe("Agent");
  });

  it("strips scope, path and version for matching", () => {
    expect(bareAgentId("@agentclientprotocol/claude-agent-acp@1.2.0")).toBe("claude-agent-acp");
    expect(bareAgentId("C:\\tools\\codex-acp.exe")).toBe("codex-acp");
  });

  it("resolves a reported package name to the installed agent and its catalog name", () => {
    const installed = [{ id: "claude-acp", name: "Claude Agent" }, { id: "codex-acp" }];
    expect(resolveInstalled("@agentclientprotocol/claude-agent-acp", installed)).toEqual({ id: "claude-acp", name: "Claude Agent" });
    expect(resolveInstalled("CODEX-ACP", installed)).toEqual({ id: "codex-acp", name: "Codex" });
    expect(resolveInstalled("gemini-cli", installed)).toBeUndefined();
  });
});

describe("states, urgency and summary", () => {
  it("maps each state and health result to a badge tone", () => {
    expect(liveTone(agent("A", "Failed"))).toBe("error");
    expect(liveTone(agent("A", "Waiting for you"))).toBe("waiting");
    expect(liveTone(agent("A", "Working", { health: health("unreachable") }))).toBe("working");
    expect(liveTone(agent("A", "Starting"))).toBe("starting");
    expect(liveTone(agent("A", "Idle", { health: health("unreachable") }))).toBe("error");
    expect(liveTone(agent("A", "Idle", { health: health("unreachable") }), false)).toBe("idle");
    expect(liveTone(agent("A", "Done", { health: health("signedOut") }))).toBe("waiting");
    expect(liveTone(agent("A", "Done", { health: health("slow") }))).toBe("done");
    expect(liveStateText(agent("A", "Idle", { health: health("unreachable") }))).toBe("Unreachable");
    expect(liveStateText(agent("A", "Idle", { health: health("signedOut") }))).toBe("Signed out");
    expect(liveStateText(agent("A", "Working"))).toBe("Working");
  });

  it("orders the stack most urgent first and keeps the original order among equals", () => {
    const list = [agent("Lead", "Idle", { lead: true }), agent("B", "Working"), agent("C", "Done"), agent("D", "Waiting for you"), agent("E", "Working"), agent("F", "Failed")];
    expect(orderByUrgency(list).map((entry) => entry.name)).toEqual(["F", "D", "B", "E", "Lead", "C"]);
  });

  it("summarises in one phrase with the most urgent state winning", () => {
    expect(liveSummary([agent("A", "Working"), agent("B", "Working"), agent("C", "Idle")])).toEqual({ tone: "working", text: "2 working" });
    expect(liveSummary([agent("A", "Working"), agent("B", "Waiting for you")])).toEqual({ tone: "waiting", text: "1 waiting" });
    expect(liveSummary([agent("A", "Waiting for you"), agent("B", "Failed")])).toEqual({ tone: "error", text: "1 failed" });
    expect(liveSummary([agent("A", "Idle", { health: health("unreachable") }), agent("B", "Idle")])).toEqual({ tone: "error", text: "1 unreachable" });
    expect(liveSummary([agent("A", "Idle", { health: health("unreachable") }), agent("B", "Failed")])).toEqual({ tone: "error", text: "2 need attention" });
    expect(liveSummary([agent("A", "Done", { health: health("signedOut") }), agent("B", "Idle")])).toEqual({ tone: "waiting", text: "1 signed out" });
    expect(liveSummary([agent("A", "Starting"), agent("B", "Idle")])).toEqual({ tone: "starting", text: "1 starting" });
    expect(liveSummary([agent("A", "Idle"), agent("B", "Done")])).toEqual({ tone: "idle", text: "All idle" });
    expect(liveSummary([agent("A", "Done"), agent("B", "Done")])).toEqual({ tone: "done", text: "All done" });
  });
});

describe("token budget overruns", () => {
  const child = { connectionId: "c2", sessionId: "s2" };
  const task = (extra: Partial<DelegationTaskState>): DelegationTaskState => ({ taskId: "t1", child, agentName: "Claude Agent", status: "completed", ...extra }) as DelegationTaskState;
  it("keeps a completed task that went over its budget Done, with the note in the tooltip and out of the failed count", () => {
    const over = task({ detail: "Used about 1500 tokens, over the 1000 token budget", resultSummary: "Hi" });
    const agents = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [over], health: [] });
    expect(agents[1]).toMatchObject({ state: "Done", detail: "Used about 1500 tokens, over the 1000 token budget. Hi" });
    expect(liveSummary(agents)).toEqual({ tone: "idle", text: "All idle" });
  });
  it("still counts a task that was stopped for really exceeding its budget as failed", () => {
    const stopped = task({ status: "failed", reason: "budget_exceeded", detail: "used about 1500 tokens since it started, over the 1000 token budget" });
    const agents = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [stopped], health: [] });
    expect(agents[1]).toMatchObject({ state: "Failed", detail: "used about 1500 tokens since it started, over the 1000 token budget" });
    expect(liveSummary(agents)).toEqual({ tone: "error", text: "1 failed" });
  });
});

describe("overflow", () => {
  it("shows up to five whole, then four and a chip that never says +1", () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `A${index}`);
    expect(stackOf(names(2))).toEqual({ visible: ["A0", "A1"], hidden: [] });
    expect(stackOf(names(5)).hidden).toEqual([]);
    const six = stackOf(names(6));
    expect(six.visible).toHaveLength(4);
    expect(six.hidden).toEqual(["A4", "A5"]);
    expect(stackOf(names(9), 3)).toEqual({ visible: ["A0", "A1"], hidden: ["A2", "A3", "A4", "A5", "A6", "A7", "A8"] });
  });
});
