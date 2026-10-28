import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentFeatures } from "../bindings";
import { canCompact, initialAgentState, mergeTool, openPermission, reduceAgentEvent, type AgentState, type ToolEvent } from "./agent-session";

const features: AgentFeatures = { loadSession: true, image: false, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const apply = (events: AgentEvent[], state: AgentState = initialAgentState(true)) => events.reduce(reduceAgentEvent, state);
const live = () => apply([{ kind: "session", sessionId: "s1" }]);
const tool = (patch: Partial<ToolEvent>): ToolEvent => ({ kind: "tool", sessionId: "s1", toolCallId: "t1", title: null, status: null, toolKind: null, parentToolCallId: null, contentJson: "{}", ...patch });

describe("agent session reducer", () => {
  it("records the ready event identity, features and session capabilities", () => {
    const state = apply([{ kind: "ready", agentName: "agent", agentTitle: "Agent", agentVersion: "2.1", features, authMethods: [] }]);
    expect(state.agent).toEqual({ name: "agent", title: "Agent", version: "2.1", features });
    expect(state.canLoad).toBe(true);
    expect(state.canList).toBe(true);
  });

  it("keeps auth methods from authRequired until a session arrives", () => {
    const methods = [{ id: "login", name: "Log in", description: null, kind: "agent", supported: true }];
    const waiting = apply([{ kind: "authRequired", message: "Authentication required: sign in", authMethods: methods }]);
    expect(waiting.auth).toEqual({ message: "Authentication required: sign in", methods });
    expect(waiting.sessionId).toBeUndefined();
    const signedIn = reduceAgentEvent(waiting, { kind: "session", sessionId: "s1" });
    expect(signedIn.auth).toBeUndefined();
    expect(signedIn.sessionId).toBe("s1");
  });

  it("stores usage with cost only when both amount and currency are reported", () => {
    expect(apply([{ kind: "usage", sessionId: "s1", used: 10, size: 100, costAmount: 0.5, costCurrency: "USD" }], live()).usage).toEqual({ used: 10, size: 100, cost: { amount: 0.5, currency: "USD" } });
    expect(apply([{ kind: "usage", sessionId: "s1", used: 10, size: 100, costAmount: 0.5, costCurrency: null }], live()).usage?.cost).toBeUndefined();
  });

  it("replaces the advertised commands and detects a compact command", () => {
    const state = apply([{ kind: "availableCommands", sessionId: "s1", commands: [{ name: "compact", description: "Compact", inputHint: null }] }], live());
    expect(state.commands.map((command) => command.name)).toEqual(["compact"]);
    expect(canCompact(state.commands)).toBe(true);
    expect(canCompact([{ name: "review", description: "", inputHint: null }])).toBe(false);
  });

  it("moves the current value of the mode option when the agent reports a mode change", () => {
    const state = apply(
      [
        { kind: "config", sessionId: "s1", options: [{ id: "mode", name: "Mode", category: "mode", currentValue: "a", groups: [{ name: "", choices: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] }] },
        { kind: "currentMode", sessionId: "s1", modeId: "b" },
        { kind: "currentMode", sessionId: "s1", modeId: "unknown" },
      ],
      live(),
    );
    expect(state.config[0].currentValue).toBe("b");
  });

  it("tracks elicitations, including ones without a session id, until they resolve", () => {
    const opened = apply(
      [
        { kind: "elicitation", requestId: "e1", sessionId: null, toolCallId: null, mode: "url", message: "Open", schemaJson: null, url: "https://example.com/a", elicitationId: "x" },
        { kind: "elicitation", requestId: "e2", sessionId: "s1", toolCallId: null, mode: "form", message: "Pick", schemaJson: "{}", url: null, elicitationId: null },
      ],
      live(),
    );
    expect(opened.elicitations.map((item) => item.requestId)).toEqual(["e1", "e2"]);
    const resolved = apply([{ kind: "elicitationResolved", requestId: "e1" }, { kind: "elicitationComplete", elicitationId: "x" }], opened);
    expect(resolved.elicitations.map((item) => item.requestId)).toEqual(["e2"]);
    expect(resolved.feed.at(-1)).toMatchObject({ kind: "signin", requestId: "e1", status: "cancelled" });
  });

  it("ignores updates for another session", () => {
    const state = apply([{ kind: "text", sessionId: "other", text: "stray" }], live());
    expect(state.feed).toEqual([]);
  });

  it("adds a stop card only for the stop reasons that need one", () => {
    const running = { ...live(), running: true };
    for (const reason of ["max_tokens", "max_turn_requests", "refusal"]) {
      const state = reduceAgentEvent(running, { kind: "complete", sessionId: "s1", stopReason: reason });
      expect(state.running).toBe(false);
      expect(state.feed.at(-1)).toMatchObject({ kind: "stop", reason });
    }
    expect(reduceAgentEvent(running, { kind: "complete", sessionId: "s1", stopReason: "end_turn" }).feed).toEqual([]);
    expect(reduceAgentEvent(running, { kind: "complete", sessionId: "s1", stopReason: "cancelled" }).feed.at(-1)).toMatchObject({ kind: "note", text: "Stopped" });
  });

  it("turns an unexpected disconnect into a process exit failure with the stderr tail", () => {
    const state = apply(
      [
        { kind: "log", direction: "Stderr", line: "panic: out of memory" },
        { kind: "error", message: "Agent did not acknowledge Stop within five seconds. Its connection was terminated." },
        { kind: "status", state: "disconnected", message: "Agent process disconnected" },
      ],
      { ...live(), running: true },
    );
    expect(state.sessionId).toBeUndefined();
    expect(state.running).toBe(false);
    expect(state.failure).toEqual({ phase: "exit", message: "Agent did not acknowledge Stop within five seconds. Its connection was terminated.", log: ["panic: out of memory"] });
  });

  it("updates notices, compaction progress and summary chunks in place", () => {
    const state = apply(
      [
        { kind: "notice", sessionId: "s1", severity: "warning", title: "Quota low", description: "10% left" },
        { kind: "compaction", sessionId: "s1", compactionId: "c1", status: "in_progress", summary: null, error: null },
        { kind: "compactionSummary", sessionId: "s1", compactionId: "c1", text: "Kept " },
        { kind: "compactionSummary", sessionId: "s1", compactionId: "c1", text: "the plan." },
        { kind: "compaction", sessionId: "s1", compactionId: "c1", status: "completed", summary: null, error: null },
      ],
      live(),
    );
    expect(state.feed).toEqual([
      { id: 1, kind: "notice", severity: "warning", title: "Quota low", description: "10% left" },
      { id: 2, kind: "compaction", compactionId: "c1", status: "completed", summary: "Kept the plan.", error: undefined },
    ]);
  });

  it("merges partial tool updates without losing earlier fields", () => {
    const first = tool({ title: "Edit a.ts", toolKind: "edit", status: "pending", contentJson: JSON.stringify({ rawInput: { path: "a.ts" } }) });
    const merged = mergeTool(first, tool({ status: "completed", contentJson: JSON.stringify({ status: "completed", rawInput: null }) }));
    expect(merged).toMatchObject({ title: "Edit a.ts", toolKind: "edit", status: "completed" });
    expect(JSON.parse(merged.contentJson)).toEqual({ rawInput: { path: "a.ts" }, status: "completed" });
  });

  it("finds the oldest open permission", () => {
    const state = apply(
      [
        { kind: "permission", sessionId: "s1", requestId: "r1", toolCallId: "t1", title: "One", options: [] },
        { kind: "permission", sessionId: "s1", requestId: "r2", toolCallId: "t1", title: "Two", options: [] },
        { kind: "permissionResolved", sessionId: "s1", requestId: "r1" },
      ],
      live(),
    );
    expect(openPermission(state.feed)?.event.requestId).toBe("r2");
  });
});
