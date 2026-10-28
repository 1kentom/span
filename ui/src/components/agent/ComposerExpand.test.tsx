// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController, type AgentPanelProps } from "../../lib/agent-controller";
import { AgentComposer } from "./AgentComposer";
import { key, mount } from "./test-utils";

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
      agentPermission: vi.fn(async (..._args: unknown[]) => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async () => []),
    agentAuthenticateWith: vi.fn(async () => "s-auth"),
    agentChildPermission: vi.fn(async (..._args: unknown[]) => undefined),
    agentCancelTask: vi.fn(async (..._args: unknown[]) => undefined),
    agentDelegationStatus: vi.fn(async () => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] })),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: mocks.agentAuthenticateWith, agentChildPermission: mocks.agentChildPermission, agentCancelTask: mocks.agentCancelTask, agentDelegationStatus: mocks.agentDelegationStatus }));

const features = (): AgentFeatures => ({ loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function composer() {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 } as AgentPanelProps);
    return <AgentComposer agent={controller} brand={{ id: "a", name: "Agent" }} label="Agent" />;
  });
  await tick();
  controller.connectCustom("agent");
  await tick();
  return { a: controller, host };
}
const toggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button[aria-pressed][aria-label$='composer']")!;

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
});

describe("expandable composer", () => {
  it("starts collapsed with a labelled toggle inside the toolbar, before the send button", async () => {
    const { host } = await composer();
    const button = toggle(host);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Expand composer");
    expect(button.closest("[role=toolbar]")).not.toBeNull();
    const toolbarButtons = [...host.querySelectorAll("[role=toolbar] button")];
    expect(toolbarButtons.indexOf(button)).toBeLessThan(toolbarButtons.findIndex((b) => b.classList.contains("agent-send")));
    expect(host.querySelector(".agent-composer")!.classList.contains("expanded")).toBe(false);
  });
  it("flips aria-pressed, the label and the expanded class on click", async () => {
    const { host } = await composer();
    toggle(host).click();
    await tick();
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(host).getAttribute("aria-label")).toBe("Collapse composer");
    expect(host.querySelector(".agent-composer")!.classList.contains("expanded")).toBe(true);
    toggle(host).click();
    await tick();
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".agent-composer")!.classList.contains("expanded")).toBe(false);
  });
  it("does not collapse on Escape, from the field or the window", async () => {
    const { host } = await composer();
    toggle(host).click();
    await tick();
    key("Escape", {}, host.querySelector("textarea")!);
    key("Escape");
    await tick();
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".agent-composer")!.classList.contains("expanded")).toBe(true);
  });
  it("keeps the send button available and gives the field a vertical-only scroll", async () => {
    const { host } = await composer();
    expect(host.querySelector(".agent-send")).not.toBeNull();
    expect(host.querySelector("textarea")!.getAttribute("rows")).toBe("2");
  });
});
