import { describe, expect, it } from "vitest";
import { otherFreeModels, rankAlternatives, shortAgentName, shortModelName } from "./agent-alternatives";
import type { AgentHealth } from "./agent-health";
import { modelCost } from "./model-cost";

const health = (agentId: string, state: AgentHealth["state"]): AgentHealth => ({ agentId, state, latencyMs: 10, checkedAtMs: 0, detail: null });
const agents = [
  { id: "opencode", name: "OpenCode" },
  { id: "gemini", name: "Gemini CLI" },
  { id: "claude-acp", name: "Claude Code" },
  { id: "codex-acp", name: "Codex" },
  { id: "qwen", name: "Qwen" },
];

describe("rankAlternatives", () => {
  it("puts running agents first, then installed ones, and flags signed out and unreachable agents", () => {
    const ranked = rankAlternatives(agents, [health("codex-acp", "live"), health("claude-acp", "slow"), health("gemini", "signedOut"), health("qwen", "unreachable")], { id: "opencode", name: "OpenCode" });
    expect(ranked.map((entry) => [entry.id, entry.readiness, entry.note])).toEqual([
      ["codex-acp", "live", undefined],
      ["claude-acp", "slow", undefined],
      ["gemini", "signedOut", "Signed out"],
      ["qwen", "unreachable", "Not responding"],
    ]);
  });

  it("never offers the agent that just failed, matched by id or name", () => {
    expect(rankAlternatives(agents, [], { name: "codex" }).map((entry) => entry.id)).not.toContain("codex-acp");
    expect(rankAlternatives(agents, [], { id: "claude-acp" }).map((entry) => entry.id)).not.toContain("claude-acp");
  });

  it("keeps the installed order between agents with no health result", () => {
    expect(rankAlternatives(agents, [], { id: "opencode" }).map((entry) => entry.id)).toEqual(["gemini", "claude-acp", "codex-acp", "qwen"]);
  });
});

describe("otherFreeModels", () => {
  it("lists the other free models, without the current or limited ones", () => {
    const choices = [
      { value: "opencode/big-pickle", name: "Big Pickle" },
      { value: "opencode/grok-code-free", name: "Grok Code Free" },
      { value: "opencode/kimi-free", name: "Kimi Free" },
      { value: "opencode/claude-sonnet", name: "Claude Sonnet" },
    ];
    const free = (choice: { value: string; name: string }) => modelCost(choice) === "free";
    expect(otherFreeModels(choices, "opencode/big-pickle", free, new Set(["opencode/kimi-free"])).map((choice) => choice.value)).toEqual(["opencode/grok-code-free"]);
  });
});

describe("short names", () => {
  it("names agents the way a sentence does", () => {
    expect(["Claude Agent", "Codex CLI", "Gemini CLI", "OpenCode", "@agentclientprotocol/claude-agent-acp", "codex-acp", "Qwen Code", "GitHub Copilot"].map(shortAgentName)).toEqual(["Claude", "Codex", "Gemini", "OpenCode", "Claude", "Codex", "Qwen", "GitHub Copilot"]);
    expect(shortAgentName("Agent")).toBe("Agent");
  });

  it("drops the provider prefix from model names only", () => {
    expect(["opencode/Beam Free", "Big Pickle", "openrouter/DeepSeek V4.1 Flash Free", "gpt-5.1"].map(shortModelName)).toEqual(["Beam Free", "Big Pickle", "DeepSeek V4.1 Flash Free", "gpt-5.1"]);
  });
});
