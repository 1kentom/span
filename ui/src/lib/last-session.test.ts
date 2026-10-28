import { beforeEach, describe, expect, it } from "vitest";
import { readLastSession, writeLastSession } from "./last-session";

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
});
