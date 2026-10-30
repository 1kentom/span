// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DelegationCard } from "./DelegationCard";
import { cardStatus, deliverablesText, failureText, groupProgress, isFinished, mergeTask, taskNote } from "../../lib/agent-delegation";
import { liveAgentsOf } from "../../lib/live-agents";
import { agentTree } from "../../lib/agents-page-tree";
import { mount, text } from "./test-utils";

const child = { connectionId: "c", sessionId: "s" };

describe("DelegationCard deliverables (ADR 0014)", () => {
  it("shows what the lead expects back only when it asked for something", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="running" deliverables={deliverablesText({ files: ["out/review.md", "src/a.rs"], format: "summary" })} />);
    expect(text(host.querySelector(".sb-delegation-deliverables"))).toBe("Expects Summary, files: out/review.md, src/a.rs");
    const plain = mount(() => <DelegationCard agent="Codex" status="running" deliverables={deliverablesText(undefined)} />);
    expect(plain.querySelector(".sb-delegation-deliverables")).toBeNull();
    expect(deliverablesText({ files: [], format: null })).toBeUndefined();
    expect(deliverablesText({ files: [], format: "diff" })).toBe("Diff");
  });
  it("keeps deliverables from the delegated event when a later poll omits them", () => {
    const first = mergeTask(undefined, { taskId: "task-1", child, deliverables: { files: ["a.md"], format: "json" } });
    const polled = mergeTask(first, { taskId: "task-1", child, status: "running", deliverables: null });
    expect(polled.deliverables).toEqual({ files: ["a.md"], format: "json" });
  });
  it("names the new failure reasons in words", () => {
    expect(failureText("permission_required")).toContain("permission request");
    expect(failureText("lost")).toBe("The child session is gone");
    expect(failureText("worktree_unavailable")).toBe("Worktrees are not available yet");
  });
});

describe("DelegationCard states and batches (ADR 0014 stage 2)", () => {
  it("shows queued, needs you and lost with their own glyphs and words", () => {
    const queued = mount(() => <DelegationCard agent="Codex" status="queued" />);
    expect(text(queued.querySelector(".sb-delegation-status"))).toBe("Queued");
    expect(queued.querySelector(".sb-spinner")).toBeNull();
    const asking = mount(() => <DelegationCard agent="Claude" status="needs_user" waiting />);
    expect(text(asking.querySelector(".sb-delegation-status"))).toBe("Needs you");
    expect(asking.querySelector(".sb-delegation-status .warn")).not.toBeNull();
    expect(asking.querySelector(".sb-delegation")!.getAttribute("aria-label")).toBe("Delegated to Claude: Needs you");
    const lost = mount(() => <DelegationCard agent="OpenCode" status="lost" note="The child session is gone" />);
    expect(text(lost.querySelector(".sb-delegation-status"))).toBe("Lost");
    expect(lost.querySelector(".sb-delegation.failed")).not.toBeNull();
    expect(lost.querySelector(".sb-delegation-status .sb-bad")).not.toBeNull();
    expect(lost.querySelector(".sb-delegation-actions")).toBeNull();
    const failed = mount(() => <DelegationCard agent="Codex" status="failed" note="Stopped" />);
    expect(text(failed.querySelector(".sb-delegation-status"))).toBe("Failed");
  });
  it("shows the batch as n of m done only for a grouped task", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="running" group={{ done: 1, total: 3 }} />);
    expect(text(host.querySelector(".sb-delegation-group"))).toBe("Batch 1 of 3 done");
    const single = mount(() => <DelegationCard agent="Codex" status="running" />);
    expect(single.querySelector(".sb-delegation-group")).toBeNull();
  });
  it("derives the card status, the batch progress and lost from reported facts", () => {
    const running = mergeTask(undefined, { taskId: "task-1", child, status: "running", groupId: "group-1", waitingForUser: true });
    expect(cardStatus(running, false)).toBe("needs_user");
    expect(cardStatus({ ...running, waitingForUser: false }, false)).toBe("running");
    expect(cardStatus({ ...running, waitingForUser: false }, true)).toBe("needs_user");
    const lost = mergeTask(undefined, { taskId: "task-2", child, status: "lost", reason: "lost", groupId: "group-1" });
    expect(lost.status).toBe("lost");
    expect(isFinished(lost.status)).toBe(true);
    expect(taskNote(lost)).toBe("The child session is gone");
    const queued = mergeTask(undefined, { taskId: "task-3", child, status: "queued", groupId: "group-1" });
    expect(groupProgress([running, lost, queued], "group-1")).toEqual({ done: 1, total: 3 });
    expect(groupProgress([running], undefined)).toBeUndefined();
  });
});

describe("Agents tree rows (ADR 0014 stage 2)", () => {
  const task = (taskId: string, status: string, agentName: string, extra: Partial<Parameters<typeof mergeTask>[1]> = {}) => mergeTask(undefined, { taskId, child: { connectionId: "c", sessionId: taskId }, status, agentName, groupId: "group-1", ...extra });
  it("labels queued, waiting, failed and lost children and shows the batch", () => {
    const tasks = [task("task-1", "queued", "codex"), task("task-2", "running", "claude", { waitingForUser: true }), task("task-3", "failed", "opencode", { reason: "timeout" }), task("task-4", "lost", "gemini", { reason: "lost" })];
    const agents = liveAgentsOf({ lead: { name: "Claude Lead", state: "Working" }, tasks, health: [] });
    const states = Object.fromEntries(agents.map((agent) => [agent.name, agent.state]));
    expect(states).toMatchObject({ Codex: "Queued", Claude: "Waiting for you", OpenCode: "Failed", Gemini: "Lost" });
    const feed = tasks.map((entry, index) => ({ id: `d${index}`, kind: "delegation" as const, task: entry }));
    const tree = agentTree({ agents, feed: feed as never, showHealth: false, leadRunning: true });
    const row = (name: string) => tree.nodes.find((node) => node.name === name)!;
    expect(row("Codex").state).toBe("Queued");
    expect(row("Codex").tone).toBe("starting");
    expect(row("Codex").canStop).toBe(true);
    expect(row("Codex").meta).toContain("Batch 2 of 4 done");
    expect(row("Gemini").state).toBe("Lost");
    expect(row("Gemini").tone).toBe("error");
    expect(row("Claude").state).toBe("Waiting for you");
  });
});
