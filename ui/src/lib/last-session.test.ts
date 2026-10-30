import { beforeEach, describe, expect, it } from "vitest";
import { noteAgentUsed, readLastSession, readRecentAgents, writeLastSession } from "./last-session";

beforeEach(() => window.localStorage.clear());

describe("last session memory", () => {
  it("keeps one chat per workspace", () => {
    writeLastSession("/a", { agentId: "claude", sessionId: "s1" });
    writeLastSession("/b", { agentId: "codex", sessionId: "s2" });
    expect(readLastSession("/a")).toEqual({ agentId: "claude", sessionId: "s1" });
    expect(readLastSession("/b")).toEqual({ agentId: "codex", sessionId: "s2" });
  });
  it("forgets a workspace and survives bad stored data", () => {
    writeLastSession("/a", { agentId: "claude", sessionId: "s1" });
    writeLastSession("/a", undefined);
    expect(readLastSession("/a")).toBeUndefined();
    window.localStorage.setItem("span.agent.lastSession", "{nope");
    expect(readLastSession("/a")).toBeUndefined();
  });
  it("drops entries and values in old or broken shapes instead of throwing", () => {
    window.localStorage.setItem("span.agent.lastSession", JSON.stringify({ "/a": null, "/b": "s1", "/c": { agentId: "codex" }, "/d": { agentId: "codex", sessionId: "s4", extra: 1 } }));
    expect(readLastSession("/a")).toBeUndefined();
    expect(readLastSession("/b")).toBeUndefined();
    expect(readLastSession("/c")).toBeUndefined();
    expect(readLastSession("/d")).toEqual({ agentId: "codex", sessionId: "s4" });
    window.localStorage.setItem("span.agent.lastSession", "null");
    expect(readLastSession("/d")).toBeUndefined();
    expect(window.localStorage.getItem("span.agent.lastSession")).toBeNull();
    window.localStorage.setItem("span.agent.recent", JSON.stringify({ 0: "codex" }));
    expect(readRecentAgents()).toEqual([]);
    window.localStorage.setItem("span.agent.recent", JSON.stringify(["codex", 7, "claude"]));
    expect(readRecentAgents()).toEqual(["codex", "claude"]);
    noteAgentUsed("claude");
    expect(readRecentAgents()).toEqual(["claude", "codex"]);
  });
});
