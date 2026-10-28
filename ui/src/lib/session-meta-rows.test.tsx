// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures, ConfigOption_Serialize as ConfigOption, SessionMeta_Serialize as SessionMeta } from "../bindings";
import { createAgentController, type AgentController } from "./agent-controller";
import { delegationMetaPatch, rowMeta, turnMetaPatch } from "./agent-chats";
import { writeLastSession } from "./last-session";
import { mount } from "../components/agent/test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async (): Promise<unknown[]> => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentResumeSession: vi.fn(async (id: string) => id),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentPrompt: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    sessionMetaList: vi.fn(async (): Promise<unknown[]> => []),
    sessionMetaSetTitle: vi.fn(),
    sessionMetaUpdate: vi.fn(),
  };
});
vi.mock("./client", () => ({
  isDesktop: true,
  api: mocks.api,
  agentPresets: mocks.agentPresets,
  agentAuthenticateWith: vi.fn(),
  sessionMetaList: mocks.sessionMetaList,
  sessionMetaSetTitle: mocks.sessionMetaSetTitle,
  sessionMetaUpdate: mocks.sessionMetaUpdate,
}));

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  agentId: "codex",
  connectionName: "",
  sessionId: "old",
  titleOverride: null,
  archived: false,
  firstSeenMs: 1,
  lastActiveMs: 2,
  models: [],
  agents: [],
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  stopReasonLast: null,
  parent: null,
  ...patch,
});

describe("rowMeta", () => {
  it("returns nothing for a session without stored metadata", () => {
    expect(rowMeta(undefined)).toEqual({ agents: [], models: [] });
  });
  it("keeps only the agents and models the metadata names", () => {
    expect(rowMeta(meta())).toEqual({ agents: [], models: [] });
    const full = meta({
      connectionName: "Codex",
      titleOverride: "Parser fix",
      models: [
        { name: "gpt-5.1-codex", effort: "high", usedMs: 3, turns: 2 },
        { name: "gpt-5.1-codex-mini", effort: null, usedMs: 2, turns: 1 },
        { name: "", effort: null, usedMs: 1, turns: 0 },
      ],
      agents: [
        { agentId: "codex", name: "Codex", role: null, subagent: false },
        { agentId: "gemini", name: "gemini", role: "delegated", subagent: false },
        { agentId: "blank", name: "", role: null, subagent: false },
      ],
    });
    expect(rowMeta(full)).toEqual({
      title: "Parser fix",
      agents: [
        { id: "codex", name: "Codex" },
        { id: "gemini", name: "gemini" },
      ],
      models: ["gpt-5.1-codex · high", "gpt-5.1-codex-mini"],
    });
  });
});

describe("rowMeta counters", () => {
  it("adds file and line counts only when the store has them", () => {
    expect(rowMeta(meta({ filesChanged: 3, linesAdded: 10, linesRemoved: 0 }))).toEqual({ agents: [], models: [], files: 3, delta: { add: 10, del: 0 } });
    expect(rowMeta(meta({ linesRemoved: 2 }))).toEqual({ agents: [], models: [], delta: { add: 0, del: 2 } });
    expect(rowMeta(meta())).toEqual({ agents: [], models: [] });
  });
});

describe("metadata patches", () => {
  const option = (category: string, currentValue: string, choices: [string, string][]): ConfigOption => ({
    id: category,
    name: category,
    description: null,
    category,
    currentValue,
    groups: [{ name: "", choices: choices.map(([value, name]) => ({ value, name, description: null })) }],
  });

  it("records the model and effort a turn ran with, by the names the pickers show", () => {
    const config = [option("mode", "code", [["code", "Code"]]), option("model", "opus", [["opus", "Opus 4.5"]]), option("thought_level", "hi", [["hi", "high"]])];
    expect(turnMetaPatch({ agentId: "claude", sessionId: "s", connectionName: "Claude Code", config })).toEqual({
      agentId: "claude",
      sessionId: "s",
      connectionName: "Claude Code",
      models: [{ name: "Opus 4.5", effort: "high", turns: 1 }],
    });
    expect(turnMetaPatch({ agentId: "claude", sessionId: "s", connectionName: "Claude Code", config: [option("model", "raw-id", [])] })?.models).toEqual([{ name: "raw-id", effort: null, turns: 1 }]);
  });

  it("records no model when the agent reports none, and nothing without an agent id or session", () => {
    expect(turnMetaPatch({ agentId: "claude", sessionId: "s", connectionName: "Claude Code", config: [] })).toEqual({ agentId: "claude", sessionId: "s", connectionName: "Claude Code" });
    expect(turnMetaPatch({ agentId: undefined, sessionId: "s", connectionName: "x", config: [] })).toBeUndefined();
    expect(turnMetaPatch({ agentId: "claude", sessionId: undefined, connectionName: "x", config: [] })).toBeUndefined();
  });

  it("records a delegated agent on the lead session", () => {
    expect(delegationMetaPatch("claude", "lead", "codex")).toEqual({ agentId: "claude", sessionId: "lead", agents: [{ agentId: "codex", name: "codex", role: "delegated", subagent: false }] });
    expect(delegationMetaPatch(undefined, "lead", "codex")).toBeUndefined();
  });
});

describe("history metadata wiring", () => {
  const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(() => {
    Element.prototype.scrollTo = () => undefined;
    window.localStorage.clear();
    mocks.listeners.splice(0);
    mocks.api.agentConnect.mockReset();
    mocks.api.agentConnect.mockImplementation(async () => {
      mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "fresh" } as AgentEvent);
      return "fresh";
    });
    mocks.api.agentListSessions.mockReset();
    mocks.api.agentListSessions.mockResolvedValue([{ sessionId: "old", title: "Earlier chat", cwd: "/w", updatedAt: null }]);
    mocks.api.agentInstalled.mockResolvedValue([{ id: "codex", version: "1", launch: { command: "codex", args: ["acp"], env: {} } }]);
    mocks.sessionMetaList.mockReset();
    mocks.sessionMetaSetTitle.mockReset();
    mocks.sessionMetaUpdate.mockReset();
  });

  async function open() {
    writeLastSession("/w", { agentId: "codex", sessionId: "fresh" });
    let a!: AgentController;
    mount(() => {
      a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <div />;
    });
    await tick();
    await tick();
    return a;
  }

  it("reads stored metadata for the connected agent only", async () => {
    mocks.sessionMetaList.mockResolvedValue([meta({ connectionName: "Codex", models: [{ name: "gpt-5.1-codex", effort: null, usedMs: 1, turns: 1 }] }), meta({ agentId: "gemini", connectionName: "Gemini" })]);
    const a = await open();
    await a.loadSessions();
    await tick();
    expect(a.sessionMetaOf("old")?.agentId).toBe("codex");
    expect(rowMeta(a.sessionMetaOf("old")).models).toEqual(["gpt-5.1-codex"]);
    expect(a.sessionMetaOf("missing")).toBeUndefined();
  });

  it("treats a failed metadata read as no metadata", async () => {
    mocks.sessionMetaList.mockRejectedValue(new Error("no folder"));
    const a = await open();
    await a.loadSessions();
    await tick();
    expect(a.sessionMetaOf("old")).toBeUndefined();
    expect(a.sessionsError()).toBe("");
  });

  it("renames through the metadata store and shows the stored title", async () => {
    mocks.sessionMetaList.mockResolvedValue([]);
    mocks.sessionMetaSetTitle.mockImplementation(async (agentId: string, sessionId: string, title: string) => meta({ agentId, sessionId, titleOverride: title }));
    const a = await open();
    expect(a.canRename()).toBe(true);
    await a.renameChat("old", "Parser fix");
    expect(mocks.sessionMetaSetTitle).toHaveBeenCalledWith("codex", "old", "Parser fix");
    expect(rowMeta(a.sessionMetaOf("old")).title).toBe("Parser fix");
  });

  it("reports a failed rename in the history error line", async () => {
    mocks.sessionMetaList.mockResolvedValue([]);
    mocks.sessionMetaSetTitle.mockRejectedValue(new Error("disk full"));
    const a = await open();
    await a.renameChat("old", "Parser fix");
    expect(a.sessionsError()).toContain("Could not rename that chat");
    expect(a.sessionMetaOf("old")).toBeUndefined();
  });

  it("records the model of each finished turn in the metadata store and shows it", async () => {
    mocks.sessionMetaList.mockResolvedValue([]);
    mocks.sessionMetaUpdate.mockImplementation(async (patch: { agentId: string; sessionId: string }) =>
      meta({ agentId: patch.agentId, sessionId: patch.sessionId, models: [{ name: "gpt-5.1-codex", effort: null, usedMs: 1, turns: 1 }] }),
    );
    const a = await open();
    mocks.emit({ kind: "config", sessionId: "fresh", options: [{ id: "model", name: "Model", description: null, category: "model", currentValue: "gpt-5.1-codex", groups: [] }] } as AgentEvent);
    a.sendText("hello");
    await tick();
    expect(mocks.sessionMetaUpdate).toHaveBeenCalledWith({ agentId: "codex", sessionId: "fresh", connectionName: "Codex", models: [{ name: "gpt-5.1-codex", effort: null, turns: 1 }] });
    expect(rowMeta(a.sessionMetaOf("fresh")).models).toEqual(["gpt-5.1-codex"]);
  });

  it("keeps the chat working when the metadata store refuses a write", async () => {
    mocks.sessionMetaList.mockResolvedValue([]);
    mocks.sessionMetaUpdate.mockRejectedValue(new Error("Open a folder to use session history"));
    const a = await open();
    a.sendText("hello");
    await tick();
    expect(mocks.sessionMetaUpdate).toHaveBeenCalled();
    expect(a.state().failure).toBeUndefined();
    expect(a.sessionMetaOf("fresh")).toBeUndefined();
  });
});
