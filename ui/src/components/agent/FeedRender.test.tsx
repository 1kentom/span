// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { AgentFeed } from "./AgentFeed";
import { mount } from "./test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async (): Promise<unknown[]> => [{ id: "codex", version: "1", launch: { command: "codex", args: [], env: {} } }]),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(() => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async () => undefined),
      agentSessionStates: vi.fn(async () => ({ connectionId: "c1", sessions: [] })),
    },
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: vi.fn(async () => []), agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tool = (id: string, lines: number): AgentEvent =>
  ({
    kind: "tool", sessionId: "s1", toolCallId: id, title: `build ${id}`, status: "completed", toolKind: "execute", parentToolCallId: null,
    contentJson: JSON.stringify({ rawInput: { command: ["cargo", "build"] }, rawOutput: { stdout: Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"), exit_code: 0 } }),
  }) as AgentEvent;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockImplementation(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" } as AgentEvent);
    return "s1";
  });
});

describe("streaming into a long feed", () => {
  it("re-renders only the streaming message: earlier work groups, rows and messages keep their DOM", async () => {
    let a!: AgentController;
    const host = mount(() => {
      a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <AgentFeed agent={a} />;
    });
    await tick();
    a.connectInstalled("codex");
    await tick();
    for (let turn = 0; turn < 3; turn++)
      mocks.emit({ kind: "user", sessionId: "s1", text: `question ${turn}` } as AgentEvent, tool(`t${turn}`, 2000), { kind: "text", sessionId: "s1", text: `answer ${turn}` } as AgentEvent);
    await tick();
    const groups = [...host.querySelectorAll(".sb-work")];
    const rows = [...host.querySelectorAll(".sb-step-row")];
    const messages = [...host.querySelectorAll(".agent-message")];
    expect(groups).toHaveLength(3);
    const parse = vi.spyOn(JSON, "parse");
    for (let token = 0; token < 20; token++) mocks.emit({ kind: "text", sessionId: "s1", text: ` more ${token}` } as AgentEvent);
    await tick();
    // No tool output was parsed again for tokens streamed into another message.
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect([...host.querySelectorAll(".sb-work")]).toEqual(groups);
    expect([...host.querySelectorAll(".sb-step-row")]).toEqual(rows);
    expect([...host.querySelectorAll(".agent-message")]).toEqual(messages);
    // A changed tool call is the one step rebuilt.
    mocks.emit({ ...(tool("t2", 3) as object), title: "build t2 again" } as AgentEvent);
    await tick();
    expect(host.querySelectorAll(".sb-step-row")[2].textContent).toContain("build t2 again");
    expect(host.querySelectorAll(".sb-step-row")[0]).toBe(rows[0]);
  });
});
