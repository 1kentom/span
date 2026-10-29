// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Show, createSignal } from "solid-js";
import type { AgentEvent, InstalledAgent } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import AgentPanel from "../AgentPanel";
import { mount } from "../agent/test-utils";
import { AgentsPage } from "./AgentsPage";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  registry: vi.fn(),
  connect: vi.fn(),
  onEvent: vi.fn(),
  prompt: vi.fn(),
  listSessions: vi.fn(),
  resumeSession: vi.fn(),
  newSession: vi.fn(),
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
    agentSetConfig: vi.fn(async () => undefined),
    agentListSessions: mocks.listSessions,
    agentListAllSessions: mocks.listSessions,
    agentResumeSession: mocks.resumeSession,
    agentNewSession: mocks.newSession,
    writeClipboard: vi.fn(async () => undefined),
  },
  agentSessions: { live: mocks.live, onEvent: mocks.keyedEvents },
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
  sessionMetaList: vi.fn(async () => []),
}));

const managed: InstalledAgent = { id: "codex-acp", version: "2.3.0", launch: { command: "codex-acp", args: [], env: {} } };
const features = { loadSession: true, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
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
  mocks.listSessions.mockResolvedValue([{ sessionId: "earlier", title: "Earlier fixture thread", updatedAt: new Date().toISOString(), cwd: "/workspace/one" }]);
  mocks.resumeSession.mockResolvedValue("earlier");
  mocks.newSession.mockResolvedValue("new-thread");
  mocks.live.mockResolvedValue([]);
  mocks.keyedEvents.mockResolvedValue(() => undefined);
});
afterEach(() => vi.useRealTimers());

function harness() {
  const [mode, setMode] = createSignal<"editor" | "agents">("editor");
  let agent!: AgentController;
  const host = mount(() => {
    agent = createAgentController({ workspacePath: "/workspace/one" });
    return (
      <Show when={mode() === "agents"} fallback={<AgentPanel workspacePath="/workspace/one" controller={agent} />}>
        <AgentsPage agent={agent} workspaceRoot="/workspace/one" workspaceName="one" windowWidth={1440} onOpenEditor={() => setMode("editor")} onOpenFile={() => undefined} />
      </Show>
    );
  });
  return { host, setMode, agent: () => agent };
}

describe("Editor and Agents share one thread", () => {
  it("keeps the sidebar in Editor mode and shows the same thread, feed and composer draft in Agents mode without reloading", async () => {
    const { host, setMode, agent } = harness();
    await flush();
    // Editor mode: the sidebar is there, the page is not.
    expect(host.querySelector('section.agent-panel[aria-label="AI Assistant"]')).not.toBeNull();
    expect(host.querySelector(".ap-page")).toBeNull();
    host.querySelector<HTMLButtonElement>('[aria-label="Connect codex-acp"]')!.click();
    await flush();
    const receive = mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;
    receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
    receive({ kind: "capabilities", canLoadSession: true, canListSessions: true });
    await flush();
    const input = () => host.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
    input().value = "Explain the cache key";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click();
    await flush();
    receive({ kind: "text", sessionId: "session-1", text: "The key hashes the toolchain file." });
    await vi.waitFor(() => expect(host.textContent).toContain("hashes the toolchain file"));
    input().value = "draft kept across views";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    const thread = agent().focusedThread();

    setMode("agents");
    await flush();
    expect(host.querySelector('section.agent-panel[aria-label="AI Assistant"]')).toBeNull();
    const page = host.querySelector(".ap-page")!;
    expect(page).not.toBeNull();
    expect(page.querySelector(".ap-thread")?.textContent).toContain("Explain the cache key");
    await vi.waitFor(() => expect(page.querySelector(".ap-thread")?.textContent).toContain("hashes the toolchain file"));
    expect(input().value).toBe("draft kept across views");
    // The open thread is the rail's selected row, and it is still running the same turn.
    expect(page.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-row-id")).toBe("session-1");
    expect(agent().focusedThread()).toBe(thread);
    expect(agent().running()).toBe(true);

    // Streaming continues into the page, and switching back shows it in the sidebar.
    receive({ kind: "text", sessionId: "session-1", text: " It changes when rust-toolchain.toml changes." });
    await vi.waitFor(() => expect(page.textContent).toContain("rust-toolchain.toml"));
    setMode("editor");
    await flush();
    await vi.waitFor(() => expect(host.querySelector('section.agent-panel[aria-label="AI Assistant"]')?.textContent).toContain("rust-toolchain.toml"));
    expect(agent().focusedThread()).toBe(thread);
    // Switching view never starts, stops or reloads a session.
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it("lists the agent's sessions in the rail and focuses one through the controller's chat switching", async () => {
    const { host, setMode } = harness();
    await flush();
    host.querySelector<HTMLButtonElement>('[aria-label="Connect codex-acp"]')!.click();
    await flush();
    const receive = mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;
    receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
    receive({ kind: "capabilities", canLoadSession: true, canListSessions: true });
    await flush();
    setMode("agents");
    await flush();
    await vi.waitFor(() => expect(host.querySelector('[role="option"][data-row-id="earlier"]')).not.toBeNull());
    expect(mocks.live).toHaveBeenCalled();
    host.querySelector<HTMLElement>('[role="option"][data-row-id="earlier"]')!.click();
    await flush();
    expect(mocks.resumeSession).toHaveBeenCalledWith("earlier");
  });
});
