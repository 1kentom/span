// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { setAgentLimit } from "../../lib/agent-errors";
import { AgentComposer } from "./AgentComposer";
import { mount, text } from "./test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async () => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(() => new Promise(() => undefined)),
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
const click = (element: Element | null | undefined) => (element as HTMLElement).click();

async function open() {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let a!: AgentController;
  const host = mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <AgentComposer agent={a} brand={{ id: "g", name: "G" }} label="G" />;
  });
  await tick();
  a.connectCustom("agent");
  await tick();
  mocks.emit({ kind: "usage", sessionId: "s1", used: 10, size: 100, costAmount: null, costCurrency: null } as AgentEvent);
  await tick();
  click(host.querySelector(".sb-ctx"));
  await tick();
  return { a, host };
}
const line = (host: HTMLElement) => {
  expect(host.querySelector(".sb-ctx-pop")).not.toBeNull();
  const row = host.querySelector(".sb-ctx-facts .danger");
  return row ? text(row) : "";
};

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  setAgentLimit(undefined);
});
afterEach(() => setAgentLimit(undefined));

describe("the context popover limit line", () => {
  it("shows the provider, the kind and a known reset after a quota error", async () => {
    const { a, host } = await open();
    expect(line(host)).toBe("");
    setAgentLimit({ kind: "quota", provider: "Anthropic", resetAt: Date.now() + 2 * 3_600_000 - 1000, freeTier: false, agentId: a.agentId() ?? a.agentName() });
    await tick();
    expect(line(host)).toBe("Anthropic limitLimit reached, resets in 2h");
  });

  it("says Rate limited, and leaves the reset out when it is unknown", async () => {
    const { a, host } = await open();
    setAgentLimit({ kind: "rate_limit", provider: "OpenAI", freeTier: false, agentId: a.agentId() ?? a.agentName() });
    await tick();
    expect(line(host)).toBe("OpenAI limitRate limited");
  });

  it("clears after the next successful turn", async () => {
    const { a, host } = await open();
    setAgentLimit({ kind: "quota", provider: "Anthropic", freeTier: false, agentId: a.agentId() ?? a.agentName() });
    await tick();
    expect(line(host)).toContain("Limit reached");
    setAgentLimit(undefined);
    await tick();
    expect(line(host)).toBe("");
  });

  it("is hidden for another agent's event", async () => {
    const { host } = await open();
    setAgentLimit({ kind: "quota", provider: "Anthropic", freeTier: false, agentId: "someone-else" });
    await tick();
    expect(line(host)).toBe("");
  });

  it("disappears once the reset time passes", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const { a, host } = await open();
      setAgentLimit({ kind: "quota", provider: "Anthropic", resetAt: Date.now() + 20_000, freeTier: false, agentId: a.agentId() ?? a.agentName() });
      await tick();
      expect(line(host)).toBe("Anthropic limitLimit reached, resets in 1m");
      vi.advanceTimersByTime(30_000);
      await tick();
      expect(line(host)).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
