// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { writeLastSession } from "../../lib/last-session";
import { mount } from "./test-utils";

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
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const summary = (sessionId: string) => ({ sessionId, title: "Earlier chat", cwd: "/w", updatedAt: null });

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentConnect.mockImplementation(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "fresh" } as AgentEvent);
    return "fresh";
  });
  mocks.api.agentResumeSession.mockClear();
  mocks.api.agentListSessions.mockReset();
  mocks.api.agentInstalled.mockResolvedValue([{ id: "codex", version: "1", launch: { command: "codex", args: ["acp"], env: {} } }]);
});

async function open() {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  await tick();
  await tick();
  return a;
}

describe("reopening the last chat on app start", () => {
  it("reconnects the agent and resumes the chat it still lists", async () => {
    writeLastSession("/w", { agentId: "codex", sessionId: "old" });
    mocks.api.agentListSessions.mockResolvedValue([summary("old")]);
    await open();
    expect(mocks.api.agentConnect).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentResumeSession).toHaveBeenCalledWith("old");
  });

  it("skips a chat the agent no longer lists, without an error", async () => {
    writeLastSession("/w", { agentId: "codex", sessionId: "gone" });
    mocks.api.agentListSessions.mockResolvedValue([summary("other")]);
    const a = await open();
    expect(mocks.api.agentResumeSession).not.toHaveBeenCalled();
    expect(a.state().failure).toBeUndefined();
  });

  it("does nothing when no chat was saved for this workspace", async () => {
    writeLastSession("/elsewhere", { agentId: "codex", sessionId: "old" });
    await open();
    expect(mocks.api.agentConnect).not.toHaveBeenCalled();
  });
});
