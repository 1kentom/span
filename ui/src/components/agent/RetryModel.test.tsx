// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { AgentFeed } from "./AgentFeed";
import { mount, text } from "./test-utils";

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
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]) => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
/** The next agentConnect starts `title` and opens `session`. */
const willConnect = (title: string, session: string) =>
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: title.toLowerCase(), agentTitle: title, agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: session } as AgentEvent);
    return session;
  });

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockClear();
  mocks.api.agentSetConfig.mockClear();
  mocks.api.agentInstalled.mockResolvedValue([agent("opencode")]);
});

describe("retry with another model after a refused prompt", () => {
  it("switches the model on the same session and sends the refused prompt again", async () => {
    let a!: AgentController;
    mount(() => {
      a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <div />;
    });
    await tick();
    willConnect("OpenCode", "s1");
    a.connectInstalled("opencode");
    await tick();
    const model = { id: "model", name: "Model", description: null, category: "model", currentValue: "a", groups: [{ name: "", choices: [{ value: "a", name: "A", description: null }, { value: "b", name: "B", description: null }] }] };
    mocks.emit(
      { kind: "config", sessionId: "s1", options: [model] } as unknown as AgentEvent,
      { kind: "user", sessionId: "s1", text: "hello there" } as AgentEvent,
      { kind: "authRequired", message: "Authentication required", authMethods: [], hint: "runOpencodeAuthLogin" } as unknown as AgentEvent,
    );
    await tick();
    expect(a.state().auth).toBeDefined();
    await a.retryWithModel("b");
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "b");
    expect(a.state().auth).toBeUndefined();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    expect(String(mocks.api.agentPrompt.mock.calls[0][0])).toContain("hello there");
  });
});
