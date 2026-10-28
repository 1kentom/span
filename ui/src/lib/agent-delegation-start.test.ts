import { describe, expect, it } from "vitest";
import type { AgentEvent, DelegationEvent } from "../bindings";
import { STATUS_TEXT, isFinished, knownDelegation, taskNote } from "./agent-delegation";
import { initialAgentState, reduceAgentEvent, type AgentState } from "./agent-session";

const lead = { connectionId: "c1", sessionId: "s1" };
const delegation = (event: DelegationEvent): AgentEvent => ({ kind: "delegation", event });
const opened = () => reduceAgentEvent(initialAgentState(true), { kind: "session", sessionId: "s1" });
const apply = (events: AgentEvent[], state: AgentState = opened()) => events.reduce(reduceAgentEvent, state);
const cards = (state: AgentState) => state.feed.flatMap((item) => (item.kind === "delegation" ? [item.task] : []));
const notes = (state: AgentState) => state.feed.flatMap((item) => (item.kind === "note" ? [item.text] : []));
const attached = delegation({ kind: "attached", lead, agentName: "OpenCode" });
const starting = delegation({ kind: "starting", lead, agentId: "claude-acp" });
const started = (launched: boolean) => delegation({ kind: "startFinished", lead, agentId: "claude-acp", connectionId: "c2", agentName: "Claude", launched, reason: null, detail: null });

describe("starting an installed agent for a delegation", () => {
  it("knows the start events", () => {
    expect(knownDelegation({ kind: "starting", lead, agentId: "a" })).toBe(true);
    expect(knownDelegation({ kind: "startFinished", lead, agentId: "a", connectionId: null, agentName: null, launched: false, reason: null, detail: null })).toBe(true);
  });

  it("shows a starting card at once, without a prompt", () => {
    const state = apply([attached, starting]);
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0]).toMatchObject({ status: "starting", agentName: "claude-acp", startingAgentId: "claude-acp" });
    expect(STATUS_TEXT.starting).toBe("Starting");
    expect(isFinished("starting")).toBe(false);
    expect(state.feed.some((item) => item.kind === "permission")).toBe(false);
  });

  it("replaces the starting card with a one line note when Span started the agent, then the delegated card follows", () => {
    const state = apply([attached, starting, started(true), delegation({ kind: "delegated", lead, child: { connectionId: "c2", sessionId: "k1" }, taskId: "t1", agentName: "Claude" })]);
    expect(cards(state).map((task) => task.status)).toEqual(["running"]);
    expect(notes(state)).toEqual(["Started Claude for OpenCode"]);
  });

  it("adds no note when another request had started the agent", () => {
    const state = apply([attached, starting, started(false)]);
    expect(cards(state)).toEqual([]);
    expect(notes(state)).toEqual([]);
  });

  it("turns the starting card into a failed card with the closed reason when the start fails", () => {
    const state = apply([attached, starting, delegation({ kind: "startFinished", lead, agentId: "claude-acp", connectionId: null, agentName: null, launched: false, reason: "auth_required", detail: "claude-acp needs the user to sign in first" })]);
    expect(cards(state)).toHaveLength(1);
    expect(cards(state)[0]).toMatchObject({ status: "failed", reason: "auth_required" });
    expect(taskNote(cards(state)[0])).toBe("The agent needs you to sign in. claude-acp needs the user to sign in first");
  });

  it("ignores starts for another lead session", () => {
    const other = { connectionId: "c1", sessionId: "other" };
    const state = apply([attached, delegation({ kind: "starting", lead: other, agentId: "claude-acp" })]);
    expect(cards(state)).toEqual([]);
  });
});
