// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../bindings";
import { key, mount, text } from "./agent/test-utils";
import AgentPanel from "./AgentPanel";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async () => [{ id: "gemini", version: "1", launch: { command: "gemini", args: ["--acp"], env: {} } }]),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(() => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => [{ sessionId: "s0", title: "Earlier chat", updatedAt: null }]),
      agentElicitation: vi.fn(async () => undefined),
      writeClipboard: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    agentAuthenticateWith: vi.fn(async () => "s1"),
    agentChildPermission: vi.fn(async () => undefined),
    agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
  };
});
vi.mock("../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: mocks.agentAuthenticateWith, agentChildPermission: mocks.agentChildPermission, agentDelegationStatus: mocks.agentDelegationStatus }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Mounts the whole panel, connects through the Connect button and starts a turn from the composer. */
async function runningPanel() {
  Element.prototype.scrollTo = () => undefined;
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" }, { kind: "capabilities", canLoadSession: true, canListSessions: true });
    return "s1";
  });
  const outside = document.createElement("button");
  outside.textContent = "Editor";
  document.body.append(outside);
  const host = mount(() => <AgentPanel workspacePath="/w" workspaceGeneration={1} />);
  await tick();
  await tick();
  host.querySelector<HTMLButtonElement>("[aria-label='Connect gemini']")!.click();
  await tick();
  await tick();
  const area = host.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
  area.value = "work";
  area.dispatchEvent(new InputEvent("input", { bubbles: true }));
  area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick();
  expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
  expect(host.querySelector("[aria-label='Stop agent']")).not.toBeNull();
  return { host, area, outside };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentCancel.mockClear();
  mocks.api.agentPrompt.mockClear();
  mocks.api.agentElicitation.mockClear();
});

describe("Escape stops the turn only from inside the agent panel", () => {
  it("ignores Escape pressed outside the panel", async () => {
    const { outside } = await runningPanel();
    outside.focus();
    key("Escape", {}, outside);
    key("Escape", {}, document.body);
    key("Escape");
    await tick();
    expect(mocks.api.agentCancel).not.toHaveBeenCalled();
  });

  it("stops the turn on Escape from the composer", async () => {
    const { area } = await runningPanel();
    key("Escape", {}, area);
    await tick();
    expect(mocks.api.agentCancel).toHaveBeenCalledTimes(1);
  });

  it("lets the URL dock decline on Escape without also stopping the turn", async () => {
    const { host } = await runningPanel();
    mocks.emit({ kind: "elicitation", requestId: "e1", sessionId: "s1", toolCallId: null, mode: "url", message: "Sign in.", schemaJson: null, url: "https://example.com/x", elicitationId: "x" });
    await tick();
    const dock = host.querySelector<HTMLElement>(".sb-dock")!;
    key("Escape", {}, dock.querySelector("button")!);
    await tick();
    expect(mocks.api.agentElicitation).toHaveBeenCalledWith("e1", "decline", null);
    expect(mocks.api.agentCancel).not.toHaveBeenCalled();
  });
});

describe("history scope", () => {
  it("offers no folder scope toggle while the list is always filtered to this workspace", async () => {
    const { host } = await runningPanel();
    host.querySelector<HTMLButtonElement>("[aria-label='Earlier sessions']")!.click();
    await tick();
    await tick();
    expect(text(host.querySelector(".sb-history"))).toContain("Earlier chat");
    expect(host.querySelector("[aria-label='Session scope']")).toBeNull();
    expect(host.textContent).not.toContain("All folders");
  });
});
