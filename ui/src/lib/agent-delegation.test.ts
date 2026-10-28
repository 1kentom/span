import { describe, expect, it } from "vitest";
import type { AgentEvent, DelegationEvent, FailureReason } from "../bindings";
import { FAILURE_TEXT, childPermissions, delegationLine, failureText, taskNote, taskStatusKind } from "./agent-delegation";
import { applyDelegationStatus, initialAgentState, reduceAgentEvent, type AgentState } from "./agent-session";

const lead = { connectionId: "c1", sessionId: "s1" };
const child = { connectionId: "c1", sessionId: "k1" };
const delegation = (event: DelegationEvent): AgentEvent => ({ kind: "delegation", event });
const apply = (events: AgentEvent[], state: AgentState = reduceAgentEvent(initialAgentState(true), { kind: "session", sessionId: "s1" })) => events.reduce(reduceAgentEvent, state);
const cards = (state: AgentState) => state.feed.flatMap((item) => (item.kind === "delegation" ? [item.task] : []));
const ask = (sessionId: string, requestId: string): Extract<AgentEvent, { kind: "permission" }> => ({ kind: "permission", sessionId, requestId, toolCallId: "t", title: "Run", options: [] });

describe("delegation reducer", () => {
  it("adds a running card for a delegated task and finishes it in place", () => {
    const running = apply([delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    expect(cards(running)).toEqual([{ taskId: "t1", child, agentName: "Codex", status: "running" }]);
    const done = apply([delegation({ kind: "taskFinished", lead, child, taskId: "t1", status: "completed", reason: null })], running);
    expect(cards(done)).toHaveLength(1);
    expect(cards(done)[0]).toMatchObject({ status: "completed", agentName: "Codex" });
  });

  it("maps a failed task with each reason, and a failed cancel to cancelled", () => {
    const failed = apply([delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Gemini" }), delegation({ kind: "taskFinished", lead, child, taskId: "t1", status: "failed", reason: "budget_exceeded" })]);
    expect(cards(failed)[0]).toMatchObject({ status: "failed", reason: "budget_exceeded" });
    expect(taskNote(cards(failed)[0])).toBe("The task used up its budget");
    const cancelled = apply([delegation({ kind: "taskFinished", lead, child, taskId: "t2", status: "failed", reason: "cancelled" })]);
    expect(cards(cancelled)[0].status).toBe("cancelled");
  });

  it("keeps a finished task finished when the delegated event arrives late", () => {
    const state = apply([delegation({ kind: "taskFinished", lead, child, taskId: "t1", status: "completed", reason: null }), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0]).toMatchObject({ status: "completed", agentName: "Codex" });
  });

  it("shows an unrecognised status as such instead of guessing", () => {
    const state = apply([delegation({ kind: "taskFinished", lead, child, taskId: "t1", status: "paused", reason: null })]);
    expect(cards(state)[0]).toMatchObject({ status: "unknown", rawStatus: "paused" });
    expect(taskNote(cards(state)[0])).toBe("Status reported: paused");
  });

  it("records a decision once at the point it arrived, between other feed items", () => {
    const decision = { id: "d1", chosen: "Use A", why: "Simple", alternatives: ["B", "C"], recordedAt: 1 };
    const state = apply([{ kind: "text", sessionId: "s1", text: "before" }, delegation({ kind: "decision", lead, decision }), delegation({ kind: "decision", lead, decision }), { kind: "thought", sessionId: "s1", text: "after" }]);
    expect(state.feed.map((item) => item.kind)).toEqual(["text", "decision", "thought"]);
  });

  it("ignores delegation events for another lead session", () => {
    const state = apply([delegation({ kind: "delegated", lead: { ...lead, sessionId: "other" }, child, taskId: "t1", agentName: "Codex" }), delegation({ kind: "decision", lead: { ...lead, sessionId: "other" }, decision: { id: "d", chosen: "x", why: "y", alternatives: [], recordedAt: 0 } })]);
    expect(state.feed).toEqual([]);
  });

  it("ignores an event kind it does not know", () => {
    const before = apply([]);
    const unknown = { kind: "somethingNew", lead } as unknown as DelegationEvent;
    expect(apply([delegation(unknown)], before)).toBe(before);
  });

  it("tracks attached, unavailable and detached, and stops running cards when the lead detaches", () => {
    const attached = apply([delegation({ kind: "attached", lead, agentName: "Claude" }), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    expect(delegationLine(attached.delegation, attached.sessionId)).toEqual({ tone: "on", text: "Delegation on" });
    const detached = apply([delegation({ kind: "detached", lead })], attached);
    expect(delegationLine(detached.delegation, detached.sessionId)).toBeUndefined();
    expect(cards(detached)[0]).toMatchObject({ status: "cancelled", detail: "The lead session ended" });
    const unavailable = apply([delegation({ kind: "unavailable", connectionId: "c1", agentName: "Claude", reason: "This agent does not support MCP over HTTP" })]);
    expect(delegationLine(unavailable.delegation, unavailable.sessionId)).toEqual({ tone: "warn", text: "Delegation unavailable: This agent does not support MCP over HTTP" });
  });

  it("shows no status line when attached to a different session or nothing was reported", () => {
    const state = apply([delegation({ kind: "attached", lead: { ...lead, sessionId: "old" }, agentName: "Claude" })]);
    expect(delegationLine(state.delegation, state.sessionId)).toBeUndefined();
    expect(delegationLine({}, "s1")).toBeUndefined();
  });

  it("merges polled status detail into an existing card only", () => {
    const state = apply([delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    const task = (taskId: string) => ({ taskId, lead, child, agentName: "Codex", status: "failed", stopReason: null, reason: "refused" as FailureReason, detail: "It said no" });
    const next = applyDelegationStatus(state, { enabled: true, available: true, reason: null, lead, attached: true, decisions: [], tasks: [task("t1"), task("missing")] });
    expect(cards(next)).toHaveLength(1);
    expect(taskNote(cards(next)[0])).toBe("The agent declined the task. It said no");
  });
});

describe("child permission requests", () => {
  it("keeps requests from other sessions apart and never lets the lead's own flow see them", () => {
    const state = apply([ask("k1", "r1"), ask("s1", "r2")]);
    expect(state.strayPermissions.map((item) => item.requestId)).toEqual(["r1"]);
    expect(state.feed.filter((item) => item.kind === "permission")).toHaveLength(1);
  });

  it("offers only requests whose session belongs to a delegated card, labelled with that agent", () => {
    const state = apply([ask("k1", "r1"), ask("stranger", "r2"), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    const offered = childPermissions(state.strayPermissions, cards(state));
    expect(offered.map((entry) => [entry.event.requestId, entry.agentName, entry.child])).toEqual([["r1", "Codex", child]]);
  });

  it("drops a request when the backend resolves it, and clears everything on disconnect", () => {
    const asked = apply([ask("k1", "r1")]);
    expect(apply([{ kind: "permissionResolved", sessionId: "k1", requestId: "r1" }], asked).strayPermissions).toEqual([]);
    expect(apply([{ kind: "status", state: "disconnected", message: "gone" }], asked).strayPermissions).toEqual([]);
  });
});

describe("failure text table", () => {
  const reasons: FailureReason[] = ["auth_required", "permission_rejected", "refused", "cancelled", "output_limit", "agent_unavailable", "depth_exceeded", "budget_exceeded", "timeout"];
  it("has distinct text for every reason in the closed set", () => {
    expect(Object.keys(FAILURE_TEXT).sort()).toEqual([...reasons].sort());
    expect(new Set(Object.values(FAILURE_TEXT)).size).toBe(reasons.length);
  });
  it("names an unknown reason instead of hiding it", () => {
    expect(failureText("brand_new")).toBe("Failed (brand_new)");
    expect(failureText(null)).toBeUndefined();
  });
  it("reads backend statuses", () => {
    expect(taskStatusKind("queued")).toBe("queued");
    expect(taskStatusKind("failed", "timeout")).toBe("failed");
  });
});
