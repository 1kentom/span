// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, InstalledAgent } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { createAgentsPanels, type AgentsPanels } from "../../lib/agents-page-panels";
import { mount } from "../agent/test-utils";
import { AgentsPage } from "./AgentsPage";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  registry: vi.fn(),
  connect: vi.fn(),
  onEvent: vi.fn(),
  prompt: vi.fn(),
  setConfig: vi.fn(),
  listSessions: vi.fn(),
  live: vi.fn(),
  keyedEvents: vi.fn(),
}));
vi.mock("../../lib/client", () => ({
  isDesktop: true,
  api: {
    agentInstalled: mocks.installed,
    agentRegistry: mocks.registry,
    agentConnect: mocks.connect,
    agentDisconnect: vi.fn(async () => undefined),
    onAgentEvent: mocks.onEvent,
    agentPrompt: mocks.prompt,
    agentCancel: vi.fn(async () => undefined),
    agentSetConfig: mocks.setConfig,
    agentListSessions: mocks.listSessions,
    agentListAllSessions: mocks.listSessions,
    agentResumeSession: vi.fn(async (id: string) => id),
    agentNewSession: vi.fn(async () => "new-thread"),
    writeClipboard: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
  },
  agentSessions: { live: mocks.live, onEvent: mocks.keyedEvents },
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] })),
  sessionMetaList: vi.fn(async () => []),
}));

const WORKSPACE = "/workspace/one";
const managed: InstalledAgent = { id: "codex-acp", version: "2.3.0", launch: { command: "codex-acp", args: [], env: {} } };
const features = { loadSession: true, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const config = {
  kind: "config",
  sessionId: "session-1",
  options: [
    { id: "model", name: "Model", category: "model", currentValue: "m1", groups: [{ name: "", choices: [{ value: "m0", name: "Small model" }, { value: "m1", name: "Large model" }] }] },
    { id: "effort", name: "Effort", category: "thought_level", currentValue: "low", groups: [{ name: "", choices: [{ value: "low", name: "low" }, { value: "medium", name: "medium" }, { value: "high", name: "high" }] }] },
  ],
} as unknown as AgentEvent;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.installed.mockResolvedValue([managed]);
  mocks.registry.mockResolvedValue([]);
  mocks.connect.mockResolvedValue("session-1");
  mocks.onEvent.mockResolvedValue(() => undefined);
  mocks.prompt.mockResolvedValue(undefined);
  mocks.setConfig.mockResolvedValue(undefined);
  mocks.listSessions.mockResolvedValue([]);
  mocks.live.mockResolvedValue([]);
  mocks.keyedEvents.mockResolvedValue(() => undefined);
});
afterEach(() => vi.useRealTimers());

/** The Agents page as App mounts it: a shared panels store, and spies on the only two ways out to Editor mode. */
function harness(options: { windowWidth?: number } = {}) {
  const onOpenEditor = vi.fn();
  const onOpenFile = vi.fn();
  let agent!: AgentController;
  let panels!: AgentsPanels;
  const host = mount(() => {
    agent = createAgentController({ workspacePath: WORKSPACE });
    panels = createAgentsPanels(() => WORKSPACE);
    return <AgentsPage agent={agent} panels={panels} workspaceRoot={WORKSPACE} workspaceName="one" windowWidth={options.windowWidth ?? 1440} onOpenEditor={onOpenEditor} onOpenFile={onOpenFile} />;
  });
  /** Nothing may leave Agents mode or bring up the editor's AI Assistant sidebar. */
  const expectStayed = () => {
    expect(onOpenEditor).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(host.querySelector('section.agent-panel[aria-label="AI Assistant"]')).toBeNull();
    expect(host.querySelector(".assistant-panel")).toBeNull();
    expect(host.querySelector(".ap-page")).not.toBeNull();
  };
  return { host, agent: () => agent, panels: () => panels, expectStayed, onOpenEditor, onOpenFile };
}

async function connect(h: ReturnType<typeof harness>) {
  await flush();
  await vi.waitFor(() => expect(h.host.querySelector("button.ap-agent-card")).not.toBeNull());
  h.host.querySelector<HTMLButtonElement>("button.ap-agent-card")!.click();
  await flush();
  const receive = mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;
  receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
  receive({ kind: "capabilities", canLoadSession: true, canListSessions: true });
  receive(config);
  await flush();
  await vi.waitFor(() => expect(h.host.querySelector(".ap-thread .agent-model-button")).not.toBeNull());
  return receive;
}

describe("Agents mode never opens the editor sidebar", () => {
  it("selecting a model, an effort level and the provider row stays on the page, with popovers in the page composer", async () => {
    const h = harness();
    await connect(h);
    const thread = h.host.querySelector(".ap-thread");
    h.host.querySelector<HTMLButtonElement>(".ap-thread .agent-model-button")!.click();
    await flush();
    const popover = h.host.querySelector<HTMLElement>('.ap-thread .agent-popover-anchor [role="dialog"]')!;
    expect(popover.getAttribute("aria-label")).toBe("Codex model");
    popover.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!.click();
    await flush();
    expect(mocks.setConfig).toHaveBeenCalledWith("model", "m0");
    h.expectStayed();

    const slider = h.host.querySelector<HTMLElement>('.ap-thread [role="slider"]')!;
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mocks.setConfig).toHaveBeenCalledWith("effort", "medium"), { timeout: 2000 });
    h.expectStayed();

    h.host.querySelector<HTMLButtonElement>(".ap-thread .sb-provider")!.click();
    await flush();
    expect(h.host.querySelector('.ap-thread .agent-popover-anchor [role="dialog"][aria-label="Agents"]')).not.toBeNull();
    h.expectStayed();
    expect(h.host.querySelector(".ap-thread")).toBe(thread);
  });

  it("Add agent, the picker's Install or connect and slash views open the connect flow inside the page, with a way back", async () => {
    const h = harness();
    await flush();
    await vi.waitFor(() => expect(h.host.querySelector(".ap-picker")).not.toBeNull());
    [...h.host.querySelectorAll<HTMLButtonElement>(".ap-picker button")].find((button) => button.textContent?.includes("Install or connect another agent"))!.click();
    await flush();
    expect(h.host.querySelector('.ap-thread .ap-setup[aria-label="Connect an agent"]')).not.toBeNull();
    expect(h.host.querySelector(".ap-thread .ap-setup .sb-connect, .ap-thread .ap-setup .agent-body")).not.toBeNull();
    h.expectStayed();
    h.host.querySelector<HTMLButtonElement>('.ap-setup [aria-label="Back to the thread"]')!.click();
    await flush();
    expect(h.host.querySelector(".ap-setup")).toBeNull();

    await connect(h);
    h.host.querySelector<HTMLButtonElement>(".ap-thread .agent-agent-button")!.click();
    await flush();
    [...h.host.querySelectorAll<HTMLButtonElement>(".ap-thread .sb-option")].find((button) => button.textContent?.includes("Add agent"))!.click();
    await flush();
    expect(h.host.querySelector('.ap-thread .ap-setup[aria-label="Connect an agent"]')).not.toBeNull();
    h.expectStayed();

    // "/log" and "/history": the log renders in the thread area; History is the rail, which opens.
    h.agent().setView("logs");
    await flush();
    expect(h.host.querySelector('.ap-thread .ap-setup[aria-label="ACP log"]')).not.toBeNull();
    h.panels().showRail(false);
    await flush();
    h.agent().setView("history");
    await flush();
    expect(h.agent().view()).toBe("session");
    expect(h.host.querySelector(".ap-rail")).not.toBeNull();
    h.expectStayed();
  });

  it("an error banner offers in-page actions only (no Show in sidebar)", async () => {
    const h = harness();
    const receive = await connect(h);
    receive({ kind: "error", sessionId: "session-1", message: "The agent crashed" } as AgentEvent);
    await flush();
    await vi.waitFor(() => expect(h.host.querySelector(".ap-thread-failure")).not.toBeNull());
    const labels = [...h.host.querySelectorAll<HTMLButtonElement>(".ap-thread-failure button")].map((button) => button.textContent?.trim());
    expect(labels.join(" ")).not.toMatch(/sidebar/i);
    const log = [...h.host.querySelectorAll<HTMLButtonElement>(".ap-thread-failure button")].find((button) => button.textContent?.includes("Show ACP log"));
    expect(log).toBeDefined();
    log!.click();
    await flush();
    expect(h.host.querySelector('.ap-setup[aria-label="ACP log"]')).not.toBeNull();
    h.expectStayed();
  });
});

describe("Agents mode panels", () => {
  it("hides and shows the rail from its header, the grip strip and the shared store, keeping the thread mounted and the choice per folder", async () => {
    const h = harness();
    await connect(h);
    const thread = h.host.querySelector(".ap-thread")!;
    h.host.querySelector<HTMLButtonElement>('.ap-rail [aria-label="Hide session list"]')!.click();
    await flush();
    expect(h.host.querySelector(".ap-rail")).toBeNull();
    expect(h.host.querySelector(".ap-rail-restore")?.getAttribute("title")).toBe("Show session list");
    expect(h.host.querySelector(".ap-thread")).toBe(thread);
    expect(window.localStorage.getItem(`span.agents.railOpen:${WORKSPACE}`)).toBe("false");
    h.host.querySelector<HTMLButtonElement>(".ap-rail-restore")!.click();
    await flush();
    expect(h.host.querySelector(".ap-rail")).not.toBeNull();
    h.panels().toggleRail();
    await flush();
    expect(h.host.querySelector(".ap-rail")).toBeNull();
    expect(h.panels().railShown()).toBe(false);
    expect(h.host.querySelector(".ap-thread")).toBe(thread);

    // A fresh page in the same folder starts with the rail hidden.
    const again = harness();
    await flush();
    expect(again.host.querySelector(".ap-rail")).toBeNull();
    expect(again.host.querySelector(".ap-rail-restore")).not.toBeNull();
  });

  it("toggles the side panel from the page and the shared store without remounting the thread", async () => {
    const h = harness();
    await connect(h);
    const thread = h.host.querySelector(".ap-thread")!;
    expect(h.host.querySelector(".ap-side")).not.toBeNull();
    h.panels().toggleSide();
    await flush();
    expect(h.host.querySelector(".ap-side")).toBeNull();
    expect(h.host.querySelector(".ap-thread")).toBe(thread);
    expect(window.localStorage.getItem(`span.agents.sideOpenChosen:${WORKSPACE}`)).toBe("false");
    h.host.querySelector<HTMLButtonElement>('.ap-thread-head [aria-label="Show side panel"]')!.click();
    await flush();
    expect(h.host.querySelector(".ap-side")).not.toBeNull();
    expect(h.host.querySelector(".ap-thread")).toBe(thread);
  });

  it("shows an attention dot on the grip strip when another session waits for the user", async () => {
    mocks.live.mockResolvedValue([
      { key: { connectionId: "c1", sessionId: "other" }, agentName: "Codex", agentId: "codex-acp", parent: null, depth: 0, origin: "user", state: "waitingForApproval", queued: 0, startedAtMs: Date.now(), currentTool: null, title: "Other thread", model: null, mode: null, health: null },
    ]);
    const h = harness();
    await connect(h);
    h.panels().showRail(false);
    await flush();
    await vi.waitFor(() => expect(h.host.querySelector(".ap-rail-restore .ap-attention-dot")).not.toBeNull());
    expect(h.host.querySelector(".ap-rail-restore")?.getAttribute("aria-label")).toBe("Show session list, a session needs you");
    expect(h.panels().attention()).toBe(true);
  });

  it("draws the Agents tab as a tree: the lead, then delegates and running commands, with Stop all and the rules", async () => {
    const h = harness();
    const receive = await connect(h);
    const lead = { connectionId: "c1", sessionId: "session-1" };
    receive({ kind: "delegation", event: { kind: "delegated", lead, child: { connectionId: "c1", sessionId: "k1" }, taskId: "t1", agentName: "Gemini CLI" } } as AgentEvent);
    receive({ kind: "tool", sessionId: "session-1", toolCallId: "cmd", title: "pnpm test", status: "in_progress", toolKind: "execute", parentToolCallId: null, contentJson: "[]" } as AgentEvent);
    await flush();
    h.host.querySelector<HTMLButtonElement>('.ap-tab[data-tab="agents"]')!.click();
    await flush();
    const rows = [...h.host.querySelectorAll<HTMLElement>(".ap-tree .ap-node")].map((node) => [node.dataset.kind, node.classList.contains("child") ? "child" : "lead", node.querySelector(".ap-node-name")?.textContent]);
    expect(rows).toEqual([
      ["agent", "lead", "Codex"],
      ["agent", "child", "Gemini CLI"],
      ["command", "child", "pnpm test"],
    ]);
    expect(h.host.querySelector(".ap-tree .ap-node.child.last .ap-node-name")?.textContent).toBe("pnpm test");
    expect(h.host.querySelector(".ap-tree-title")?.textContent).toBe("2 running");
    expect([...h.host.querySelectorAll(".ap-tree-head button")].map((button) => button.textContent?.trim())).toEqual(["Stop all"]);
    expect(h.host.querySelector(".ap-rules")?.textContent).toContain("Delegated agents can't delegate further (depth 1).");
    h.expectStayed();
  });
});

describe("files nobody clicked", () => {
  it("follow mode opens through onRevealFile, so the app can keep the Agents page in place", async () => {
    const onOpenFile = vi.fn();
    const onRevealFile = vi.fn();
    let agent!: AgentController;
    mount(() => {
      agent = createAgentController({ workspacePath: WORKSPACE, onOpenFile, onRevealFile });
      return null;
    });
    await flush();
    agent.connectInstalled("codex-acp");
    await flush();
    const receive = mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;
    receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
    await flush();
    agent.toggleFollow();
    receive({ kind: "tool", sessionId: "session-1", toolCallId: "edit", title: "Edit", status: "in_progress", toolKind: "edit", parentToolCallId: null, contentJson: "[]", locations: [{ path: `${WORKSPACE}/src/app.ts`, line: 4 }] } as AgentEvent);
    await flush();
    expect(onRevealFile).toHaveBeenCalledWith("src/app.ts", 4);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
