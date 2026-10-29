import { describe, expect, it } from "vitest";
import type { AgentEvent, DelegationEvent, FailureReason } from "../bindings";
import { FAILURE_TEXT, boundedSummary, budgetNote, budgetText, childPermissions, delegationLine, failureText, permissionWaitsOn, taskElapsedMs, taskNote, taskStatusKind } from "./agent-delegation";
import { DOCK_TAB_HINT, TYPING_QUIET_MS, shouldFocusDock } from "./agent-dock-focus";
import { composerHints } from "./agent-hints";
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
    expect(delegationLine(attached.delegation, attached.sessionId)).toBeUndefined();
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
    const task = (taskId: string) => ({ taskId, lead, child, agentName: "Codex", status: "failed", stopReason: null, reason: "refused" as FailureReason, detail: "It said no", startedAtMs: 1, finishedAtMs: 2, progressText: null, resultSummary: null, artifacts: [], budgetUsed: { turns: 1, tokens: null, contextSize: null, cost: null, currency: null, elapsedSeconds: 0 } });
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

describe("typed child permission events", () => {
  const typed = (over: Partial<Extract<DelegationEvent, { kind: "childPermission" }>> = {}): AgentEvent =>
    delegation({ kind: "childPermission", lead, child, taskId: "t1", agentName: "Reviewer", connectionId: "c1", sessionId: "k1", requestId: "r1", requestKind: "permission", ...over });

  it("offers a request the typed event names, with its agent name, child key and task, even before any card exists", () => {
    const state = apply([ask("k1", "r1"), typed()]);
    expect(state.childRequests).toEqual([{ taskId: "t1", child, agentName: "Reviewer", sessionId: "k1", requestId: "r1" }]);
    const offered = childPermissions(state.strayPermissions, cards(state), state.childRequests);
    expect(offered.map((entry) => [entry.event.requestId, entry.agentName, entry.child, entry.taskId])).toEqual([["r1", "Reviewer", child, "t1"]]);
  });

  it("matches in either arrival order and does not need the card's session to line up", () => {
    const later = apply([typed({ sessionId: "k9", requestId: "r5", child: { connectionId: "c1", sessionId: "k9" } }), ask("k9", "r5")]);
    const offered = childPermissions(later.strayPermissions, cards(later), later.childRequests);
    expect(offered.map((entry) => [entry.agentName, entry.child.sessionId])).toEqual([["Reviewer", "k9"]]);
  });

  it("never offers a request from a session that no card and no typed event names", () => {
    const state = apply([ask("stranger", "r2"), typed(), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    expect(childPermissions(state.strayPermissions, cards(state), state.childRequests)).toEqual([]);
  });

  it("does not take a typed event's word for a request with a different id or session", () => {
    const state = apply([ask("k1", "r1"), typed({ requestId: "other" }), typed({ requestId: "r1", sessionId: "elsewhere" })]);
    expect(childPermissions(state.strayPermissions, cards(state), state.childRequests)).toEqual([]);
  });

  it("falls back to a card's session when no typed event arrived, which stays harmless for unknown sessions", () => {
    const state = apply([ask("k1", "r1"), ask("nobody", "r2"), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    expect(childPermissions(state.strayPermissions, cards(state), state.childRequests).map((entry) => [entry.event.requestId, entry.agentName])).toEqual([["r1", "Codex"]]);
  });

  it("ignores typed events for another lead and for an elicitation", () => {
    expect(apply([typed({ lead: { ...lead, sessionId: "old" } })]).childRequests).toEqual([]);
    expect(apply([typed({ requestKind: "elicitation" })]).childRequests).toEqual([]);
  });

  it("forgets the typed event when the request resolves, and on disconnect", () => {
    const asked = apply([ask("k1", "r1"), typed()]);
    expect(apply([{ kind: "permissionResolved", sessionId: "k1", requestId: "r1" }], asked).childRequests).toEqual([]);
    expect(apply([{ kind: "status", state: "disconnected", message: "gone" }], asked).childRequests).toEqual([]);
  });

  it("marks a card as waiting by task id when the typed event has one", () => {
    const state = apply([ask("k1", "r1"), typed(), delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" }), delegation({ kind: "delegated", lead, child, taskId: "t2", agentName: "Codex" })]);
    const [entry] = childPermissions(state.strayPermissions, cards(state), state.childRequests);
    expect(cards(state).map((task) => permissionWaitsOn(entry, task))).toEqual([true, false]);
  });
});

describe("richer task data", () => {
  const budget = { turns: 2, tokens: 1500, contextSize: null, cost: 0.5, currency: "USD", elapsedSeconds: 99 };
  it("folds timing, progress, summary, artifacts and budget from the polled status into the card", () => {
    const state = apply([delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    const artifacts = [{ path: "out/report.md", mimeType: "text/markdown", bytes: 10, sha256: "ab", uri: "file:///w/out/report.md", source: "disk" }];
    const task = { taskId: "t1", lead, child, agentName: "Codex", status: "completed", stopReason: null, reason: null, detail: null, startedAtMs: 1000, finishedAtMs: 4500, progressText: "Writing", resultSummary: "Done", artifacts, budgetUsed: budget };
    const next = applyDelegationStatus(state, { enabled: true, available: true, reason: null, lead, attached: true, decisions: [], tasks: [task] });
    expect(cards(next)[0]).toMatchObject({ startedAtMs: 1000, finishedAtMs: 4500, progressText: "Writing", resultSummary: "Done", artifacts, budgetUsed: budget });
  });
  it("computes elapsed from finish minus start, live while running, and nothing without a start", () => {
    expect(taskElapsedMs({ startedAtMs: 1000, finishedAtMs: 4500, status: "completed" }, 99999)).toBe(3500);
    expect(taskElapsedMs({ startedAtMs: 1000, status: "running" }, 3000)).toBe(2000);
    expect(taskElapsedMs({ status: "running" }, 3000)).toBeUndefined();
    expect(taskElapsedMs({ startedAtMs: 1000, status: "failed" }, 3000)).toBeUndefined();
  });
  it("bounds the summary and formats the budget from reported figures only", () => {
    expect(boundedSummary("  ")).toBeUndefined();
    expect(boundedSummary("short")).toBe("short");
    expect(boundedSummary("x".repeat(900))!.length).toBe(603);
    expect(budgetText(budget)).toBe("2 turns, 1,500 tokens, USD 0.50");
    expect(budgetText({ ...budget, tokens: 31_290, contextSize: 200_000, cost: null })).toBe("2 turns, 31,290 tokens in context");
    expect(budgetText({ turns: 0, tokens: null, contextSize: null, cost: null, currency: null, elapsedSeconds: 7 })).toBeUndefined();
    expect(budgetText(undefined)).toBeUndefined();
  });
  it("reads a completed task's detail as a quiet budget note, never as a failure", () => {
    const state = apply([delegation({ kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" })]);
    const task = { taskId: "t1", lead, child, agentName: "Codex", status: "completed", stopReason: "end_turn", reason: null, detail: "Used about 1500 tokens, over the 1000 token budget", startedAtMs: 1, finishedAtMs: 2, progressText: null, resultSummary: "Done", artifacts: [], budgetUsed: budget };
    const card = cards(applyDelegationStatus(state, { enabled: true, available: true, reason: null, lead, attached: true, decisions: [], tasks: [task] }))[0];
    expect(card.status).toBe("completed");
    expect(taskNote(card)).toBeUndefined();
    expect(budgetNote(card)).toBe("Used about 1500 tokens, over the 1000 token budget");
    expect(budgetNote({ ...card, status: "failed" })).toBeUndefined();
  });
});

describe("focus rules for a new dock", () => {
  const base = { now: 100_000, lastTypedAt: 0, composerFocused: false, composerText: "" };
  it("moves focus when the user is idle", () => {
    expect(shouldFocusDock(base)).toBe(true);
    expect(shouldFocusDock({ ...base, composerFocused: true })).toBe(true);
    expect(shouldFocusDock({ ...base, composerText: "draft" })).toBe(true);
  });
  it("leaves focus alone within 1500 ms of typing", () => {
    expect(shouldFocusDock({ ...base, lastTypedAt: base.now - TYPING_QUIET_MS + 1 })).toBe(false);
    expect(shouldFocusDock({ ...base, lastTypedAt: base.now - TYPING_QUIET_MS })).toBe(true);
  });
  it("leaves focus alone while the focused composer holds unsent text", () => {
    expect(shouldFocusDock({ ...base, composerFocused: true, composerText: "draft" })).toBe(false);
  });
});

describe("hints follow dock focus", () => {
  const options = [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "No", kind: "reject_once" }];
  it("lists Y and N only while the dock has focus and the Tab line otherwise", () => {
    expect(composerHints({ permission: options, dockFocused: true }).permission.map((hint) => hint.keys[0])).toEqual(["Y", "N"]);
    expect(composerHints({ permission: options, dockFocused: false }).permission).toEqual([{ keys: [], label: DOCK_TAB_HINT }]);
    expect(composerHints({ permission: options }).permission).toEqual([{ keys: [], label: DOCK_TAB_HINT }]);
  });
  it("does the same for digits and the URL Enter hint", () => {
    expect(composerHints({ elicitation: { mode: "form" }, field: { options: [1] }, dockFocused: true }).question[0].keys).toEqual(["1-9"]);
    expect(composerHints({ elicitation: { mode: "form" }, field: { options: [1] } }).question).toEqual([{ keys: [], label: DOCK_TAB_HINT }]);
    expect(composerHints({ elicitation: { mode: "url" } }).question).toEqual([{ keys: [], label: DOCK_TAB_HINT }]);
  });
  it("leaves the idle and running rows alone", () => {
    expect(composerHints({}).idle.length).toBe(4);
    expect(composerHints({}).running.map((hint) => hint.label)).toEqual(["Steer", "Queue", "Stop"]);
  });
});
