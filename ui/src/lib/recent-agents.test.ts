import { beforeEach, describe, expect, it } from "vitest";
import { noteAgentUsed, readRecentAgents } from "./last-session";

beforeEach(() => window.localStorage.clear());

describe("recently used agents for warm start", () => {
  it("keeps agent ids most recently used first, once each", () => {
    noteAgentUsed("claude-acp");
    noteAgentUsed("codex-acp");
    noteAgentUsed("claude-acp");
    expect(readRecentAgents()).toEqual(["claude-acp", "codex-acp"]);
  });
  it("keeps a short list and survives bad stored data", () => {
    for (let n = 0; n < 12; n++) noteAgentUsed(`agent-${n}`);
    expect(readRecentAgents()).toHaveLength(8);
    expect(readRecentAgents()[0]).toBe("agent-11");
    window.localStorage.setItem("span.agent.recent", "{nope");
    expect(readRecentAgents()).toEqual([]);
    window.localStorage.setItem("span.agent.recent", JSON.stringify(["a", 3, "b"]));
    expect(readRecentAgents()).toEqual(["a", "b"]);
  });
});
