// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { noteAgentUsed, readRecentAgents } from "../../lib/last-session";
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
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentWarmStart: vi.fn(async (_recent: string[]) => 2),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentWarmStart.mockReset();
  mocks.api.agentWarmStart.mockResolvedValue(2);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentConnect.mockImplementation(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "fresh" } as AgentEvent);
    return "fresh";
  });
  mocks.api.agentInstalled.mockResolvedValue([
    { id: "codex-acp", version: "1", launch: { command: "codex", args: ["acp"], env: {} } },
    { id: "claude-acp", version: "1", launch: { command: "claude", args: [], env: {} } },
  ]);
});

async function open(workspacePath: string | null = "/w") {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: workspacePath ?? undefined, workspaceGeneration: 1 });
    return <div />;
  });
  await tick();
  await tick();
  return a;
}

describe("warm start when a folder opens", () => {
  it("asks the backend once to start installed agents, most recently used first, without connecting any", async () => {
    noteAgentUsed("claude-acp");
    noteAgentUsed("codex-acp");
    await open();
    expect(mocks.api.agentWarmStart).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentWarmStart).toHaveBeenCalledWith(["codex-acp", "claude-acp"]);
    expect(mocks.api.agentConnect).not.toHaveBeenCalled();
  });

  it("stays quiet when the warm start fails", async () => {
    mocks.api.agentWarmStart.mockRejectedValue(new Error("not signed in"));
    const a = await open();
    expect(a.state().failure).toBeUndefined();
    expect(a.state().feed).toEqual([]);
  });

  it("does not warm start without a folder", async () => {
    await open(null);
    expect(mocks.api.agentWarmStart).not.toHaveBeenCalled();
  });

  it("remembers the agent the user connects as the most recently used", async () => {
    const a = await open();
    a.connectInstalled("claude-acp");
    await tick();
    expect(readRecentAgents()[0]).toBe("claude-acp");
  });
});
