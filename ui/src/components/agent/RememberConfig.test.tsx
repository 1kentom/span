// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { readLastConfig, writeLastConfig } from "../../lib/last-config";
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
      agentNewSession: vi.fn(),
      agentResumeSession: vi.fn(async (id: string) => id),
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]) => new Promise(() => undefined)),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const choices = (values: string[]) => [{ name: "", choices: values.map((value) => ({ value, name: value, description: null })) }];
const model = (current: string) => ({ id: "model", name: "Model", description: null, category: "model", currentValue: current, groups: choices(["gpt", "luna"]) });
const configEvent = (session: string, current = "gpt") => ({ kind: "config", sessionId: session, options: [model(current)] }) as unknown as AgentEvent;
const opened = (session: string) => ({ kind: "session", sessionId: session }) as AgentEvent;

function start(): AgentController {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  return a;
}
/** Connects codex so a session with a model option is ready. */
async function connected(a: AgentController) {
  await tick();
  a.connectInstalled("codex");
  await tick();
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentConnect.mockImplementation(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, opened("s1"), configEvent("s1"));
    return "s1";
  });
  mocks.api.agentNewSession.mockReset();
  mocks.api.agentNewSession.mockImplementation(async () => {
    mocks.emit(opened("s2"), configEvent("s2"));
    return "s2";
  });
  mocks.api.agentResumeSession.mockClear();
  mocks.api.agentSetConfig.mockReset();
  mocks.api.agentSetConfig.mockImplementation(async () => undefined);
  mocks.api.agentInstalled.mockResolvedValue([{ id: "codex", version: "1", launch: { command: "codex", args: ["acp"], env: {} } }]);
});

describe("remembered config", () => {
  it("applies the saved model once when a fresh session of that agent starts", async () => {
    writeLastConfig("codex", "model", "luna");
    await connected(start());
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });

  it("applies it again to a new chat", async () => {
    const a = start();
    await connected(a);
    writeLastConfig("codex", "model", "luna");
    await a.newChat();
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });

  it("leaves a resumed session alone", async () => {
    const a = start();
    await connected(a);
    writeLastConfig("codex", "model", "luna");
    mocks.api.agentResumeSession.mockImplementationOnce(async (id: string) => {
      mocks.emit(opened(id), configEvent(id));
      return id;
    });
    await a.resumeChat("old");
    await tick();
    expect(mocks.api.agentResumeSession).toHaveBeenCalled();
    expect(mocks.api.agentSetConfig).not.toHaveBeenCalled();
  });

  it("saves a user change only after the agent accepted it", async () => {
    const a = start();
    await connected(a);
    await a.setConfig("model", "luna");
    expect(readLastConfig("codex")).toEqual({ model: "luna" });
    mocks.api.agentSetConfig.mockRejectedValueOnce(new Error("no"));
    await a.setConfig("model", "gpt");
    expect(readLastConfig("codex")).toEqual({ model: "luna" });
  });

  it("does not save changes the agent makes itself", async () => {
    const a = start();
    await connected(a);
    mocks.emit(configEvent("s1", "luna"));
    await tick();
    expect(readLastConfig("codex")).toEqual({});
  });

  it("stays silent when restoring fails", async () => {
    mocks.api.agentSetConfig.mockRejectedValue(new Error("refused"));
    writeLastConfig("codex", "model", "luna");
    const a = start();
    await connected(a);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(a.state().failure).toBeUndefined();
    expect(a.state().status).toBe("ready");
  });

  it("never restores a mode that skips approval", async () => {
    writeLastConfig("codex", "mode", "agent-full-access");
    mocks.api.agentConnect.mockImplementation(async () => {
      const mode = { id: "mode", name: "Mode", description: null, category: "mode", currentValue: "default", groups: choices(["default", "agent-full-access"]) };
      mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, opened("s1"), { kind: "config", sessionId: "s1", options: [mode] } as unknown as AgentEvent);
      return "s1";
    });
    await connected(start());
    expect(mocks.api.agentSetConfig).not.toHaveBeenCalled();
  });

  it("stores nothing for an agent without a known id", async () => {
    const a = start();
    await tick();
    mocks.api.agentInstalled.mockResolvedValue([]);
    a.connectCustom("mycli --acp");
    await tick();
    await a.setConfig("model", "luna");
    expect(window.localStorage.getItem("span.agent.lastConfig")).toBeNull();
  });
});
