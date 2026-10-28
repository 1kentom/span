// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures, SessionMetaPatch_Deserialize as SessionMetaPatch, SessionMeta_Serialize as SessionMeta } from "../bindings";
import { createAgentController, type AgentController } from "./agent-controller";
import { threadRowMeta } from "./session-threads";
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
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentListAllSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentPrompt: vi.fn(async () => undefined),
      agentReview: vi.fn(async () => ({ path: "/w/a.rs", revision: 2 })),
      agentReviewHunks: vi.fn(async () => ({ path: "/w/a.rs", revision: 2 })),
      saveAttachment: vi.fn(async (_dir: string, name: string) => ({ path: name, size: 1, renamed: false })),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    sessionMetaList: vi.fn(async (): Promise<unknown[]> => []),
    sessionMetaSetTitle: vi.fn(),
    sessionMetaSetArchived: vi.fn(),
    sessionMetaUpdate: vi.fn(),
    sessionExportMarkdown: vi.fn(async () => "# Chat\n"),
  };
});
vi.mock("./client", () => ({
  isDesktop: true,
  api: mocks.api,
  agentPresets: mocks.agentPresets,
  agentAuthenticateWith: vi.fn(),
  sessionMetaList: mocks.sessionMetaList,
  sessionMetaSetTitle: mocks.sessionMetaSetTitle,
  sessionMetaSetArchived: mocks.sessionMetaSetArchived,
  sessionMetaUpdate: mocks.sessionMetaUpdate,
  sessionExportMarkdown: mocks.sessionExportMarkdown,
}));

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  agentId: "codex",
  connectionName: "",
  sessionId: "s1",
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

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
const willConnect = (title: string, session: string) =>
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: title.toLowerCase(), agentTitle: title, agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: session } as AgentEvent);
    return session;
  });
/** The store as the mock keeps it: patches merge like the Rust store for the fields these tests use. */
let stored: SessionMeta[] = [];
const keyOf = (entry: { agentId: string; sessionId: string }) => `${entry.agentId}/${entry.sessionId}`;
function upsert(patch: SessionMetaPatch): SessionMeta {
  const existing = stored.find((entry) => keyOf(entry) === keyOf(patch)) ?? meta({ agentId: patch.agentId, sessionId: patch.sessionId });
  const next: SessionMeta = {
    ...existing,
    ...(patch.connectionName ? { connectionName: patch.connectionName } : {}),
    ...(patch.continues ? { continues: { ...patch.continues, title: patch.continues.title ?? null } } : {}),
    ...(patch.filesChanged !== undefined && patch.filesChanged !== null ? { filesChanged: patch.filesChanged, linesAdded: patch.linesAdded ?? 0, linesRemoved: patch.linesRemoved ?? 0 } : {}),
    ...(patch.changesTracked !== undefined && patch.changesTracked !== null ? { changesTracked: patch.changesTracked } : {}),
    ...(patch.stopReasonLast ? { stopReasonLast: patch.stopReasonLast } : {}),
    models: [...existing.models, ...(patch.models ?? []).map((model) => ({ name: model.name, effort: model.effort ?? null, usedMs: 1, turns: model.turns ?? 1, ...(model.subagent ? { subagent: true } : {}) }))],
  };
  stored = [next, ...stored.filter((entry) => keyOf(entry) !== keyOf(next))];
  return next;
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  stored = [];
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentInstalled.mockResolvedValue([agent("codex"), agent("claude-acp")]);
  mocks.sessionMetaList.mockImplementation(async () => stored);
  mocks.sessionMetaUpdate.mockReset();
  mocks.sessionMetaUpdate.mockImplementation(async (patch: SessionMetaPatch) => upsert(patch));
  mocks.sessionMetaSetTitle.mockReset();
  mocks.sessionMetaSetTitle.mockImplementation(async (agentId: string, sessionId: string, title: string) => {
    const next = { ...(stored.find((entry) => keyOf(entry) === `${agentId}/${sessionId}`) ?? meta({ agentId, sessionId })), titleOverride: title };
    stored = [next, ...stored.filter((entry) => keyOf(entry) !== keyOf(next))];
    return next;
  });
  mocks.sessionMetaSetArchived.mockReset();
  mocks.sessionMetaSetArchived.mockImplementation(async (agentId: string, sessionId: string, archived: boolean) => {
    const next = { ...(stored.find((entry) => keyOf(entry) === `${agentId}/${sessionId}`) ?? meta({ agentId, sessionId })), archived };
    stored = [next, ...stored.filter((entry) => keyOf(entry) !== keyOf(next))];
    return next;
  });
});

async function chatWithCodex() {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  await tick();
  willConnect("Codex", "s1");
  a.connectInstalled("codex");
  await tick();
  mocks.emit({ kind: "sessionInfo", sessionId: "s1", title: "Ship path filtering" } as unknown as AgentEvent, { kind: "user", sessionId: "s1", text: "filter by path" } as AgentEvent, { kind: "text", sessionId: "s1", text: "Done" } as AgentEvent);
  await tick();
  return a;
}

describe("chat threads across an agent switch", () => {
  it("links the new session to the one it left, so the thread shows both providers under the old title", async () => {
    const a = await chatWithCodex();
    willConnect("Claude Agent", "s2");
    a.connectInstalled("claude-acp");
    await tick();
    await tick();
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.sessionMetaUpdate).toHaveBeenCalledWith({ agentId: "claude-acp", sessionId: "s2", connectionName: "Claude Agent", continues: { agentId: "codex", sessionId: "s1", title: "Ship path filtering" } });
    const thread = a.threadFor("s2");
    expect(thread.segments.map((segment) => segment.sessionId)).toEqual(["s1", "s2"]);
    expect(threadRowMeta(thread).agents.map((entry) => entry.id)).toEqual(["codex", "claude-acp"]);
    expect(a.currentTitle()).toBe("Ship path filtering");
  });

  it("renames and archives every segment of the thread", async () => {
    const a = await chatWithCodex();
    willConnect("Claude Agent", "s2");
    a.connectInstalled("claude-acp");
    await tick();
    await tick();
    await a.renameChat("s2", "Path filters");
    expect(mocks.sessionMetaSetTitle.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["claude-acp", "s2"],
      ["codex", "s1"],
    ]);
    expect(a.currentTitle()).toBe("Path filters");
    await a.archiveChat("s2", true);
    expect(mocks.sessionMetaSetArchived.mock.calls).toEqual([
      ["claude-acp", "s2", true],
      ["codex", "s1", true],
    ]);
    expect(threadRowMeta(a.threadFor("s2")).archived).toBe(true);
  });
});

describe("session counters and markers", () => {
  it("adds accepted hunks to the file and line totals", async () => {
    const a = await chatWithCodex();
    const proposal = { id: "p1", path: "/w/a.rs", baseRevision: 1, hunks: [{ id: "h1", from: 0, to: 2, before: "1\n2\n", after: "1\n3\n4\n" }, { id: "h2", from: 5, to: 5, before: "", after: "x\n" }] };
    mocks.emit({ kind: "proposal", sessionId: "s1", proposal } as unknown as AgentEvent);
    await tick();
    await a.review(proposal, true);
    await tick();
    expect(mocks.sessionMetaUpdate).toHaveBeenCalledWith({ agentId: "codex", sessionId: "s1", filesChanged: 1, linesAdded: 3, linesRemoved: 1 });
  });

  it("records the stop reason and whether every change was reviewed when a turn completes", async () => {
    await chatWithCodex();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" } as AgentEvent);
    await tick();
    expect(mocks.sessionMetaUpdate).toHaveBeenCalledWith({ agentId: "codex", sessionId: "s1", stopReasonLast: "end_turn", changesTracked: true });
  });

  it("records a delegated child's model on the lead as a subagent use", async () => {
    await chatWithCodex();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead: { connectionId: "c1", sessionId: "s1" }, child: { connectionId: "c2", sessionId: "child" }, taskId: "t", agentName: "gemini" } } as unknown as AgentEvent);
    mocks.emit({ kind: "config", sessionId: "child", options: [{ id: "model", name: "Model", description: null, category: "model", currentValue: "gemini-2.5-pro", groups: [] }] } as AgentEvent);
    await tick();
    expect(mocks.sessionMetaUpdate).toHaveBeenCalledWith({ agentId: "codex", sessionId: "s1", models: [{ name: "gemini-2.5-pro", turns: 0, subagent: true }] });
  });
});

describe("history scope and export", () => {
  it("lists every folder only in the All folders scope", async () => {
    const a = await chatWithCodex();
    await a.loadSessions();
    expect(mocks.api.agentListAllSessions).not.toHaveBeenCalled();
    a.setSessionScope("all");
    await tick();
    expect(mocks.api.agentListAllSessions).toHaveBeenCalledTimes(1);
  });

  it("exports the open chat as a Markdown file in the workspace", async () => {
    const a = await chatWithCodex();
    await a.exportChat("s1");
    expect(mocks.sessionExportMarkdown).toHaveBeenCalledWith(expect.objectContaining({ items: expect.arrayContaining([{ kind: "user", text: "filter by path" }]) }));
    expect(mocks.api.saveAttachment).toHaveBeenCalledWith("", expect.stringMatching(/\.md$/), expect.any(String));
  });
});
