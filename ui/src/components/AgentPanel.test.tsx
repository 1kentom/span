// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { AgentEvent, InstalledAgent, RegistryAgent } from "../bindings";
import { AgentPanel } from "./AgentPanel";
const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  registry: vi.fn(),
  remove: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  install: vi.fn(),
  onEvent: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  setConfig: vi.fn(),
  listSessions: vi.fn(),
  resumeSession: vi.fn(),
  newSession: vi.fn(),
}));
vi.mock("../lib/client", () => ({
  isDesktop: true,
  api: {
    agentInstalled: mocks.installed,
    agentRegistry: mocks.registry,
    agentRemove: mocks.remove,
    agentConnect: mocks.connect,
    agentDisconnect: mocks.disconnect,
    agentInstall: mocks.install,
    onAgentEvent: mocks.onEvent,
    agentPrompt: mocks.prompt,
    agentCancel: mocks.cancel,
    agentSetConfig: mocks.setConfig,
    agentListSessions: mocks.listSessions,
    agentResumeSession: mocks.resumeSession,
    agentNewSession: mocks.newSession,
    writeClipboard: vi.fn(async () => undefined),
  },
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
}));
const managed: InstalledAgent = {
  id: "codex-acp",
  version: "2.3.0",
  launch: { command: "/private/path/node", args: [], env: {} },
};
const entries: RegistryAgent[] = ["codex-acp", "claude-acp", "cursor"].map(
  (id) => ({
    id,
    name: id,
    version: "1.0.0",
    description: "ACP",
    repository: null,
    icon: null,
    package: null,
    installable: id !== "cursor",
  }),
);
const features = { loadSession: true, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const disposers: (() => void)[] = [];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  const [workspace, setWorkspace] = createSignal("/workspace/one");
  disposers.push(
    render(
      () => (
        <AgentPanel workspacePath={workspace()} removeAgent={mocks.remove} />
      ),
      root,
    ),
  );
  const button = (text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(text),
    )!;
  /** Shows the connect screen with the curated catalog. Before any session it is already the panel body. */
  const open = async () => {
    await flush();
    if (!root.querySelector(".agent-catalog")) {
      root.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')!.click();
      await flush();
      button("Connect another agent").click();
      await flush();
    }
  };
  /** Leaves the connect screen for the session, the way the old menu's dismiss layer closed it. */
  const close = async () => {
    root.querySelector<HTMLButtonElement>('[aria-label="Back to session"]')!.click();
    await flush();
  };
  /** The single row of an installed agent, under Found on this computer. Installed agents are not repeated in the curated list. */
  const found = (name: string) =>
    [...root.querySelectorAll<HTMLElement>('[aria-label="Found on this computer"] .sb-found-entry')].find((entry) =>
      entry.querySelector(".sb-agent-name")?.textContent === name,
    );
  const connectButton = (name: string) => root.querySelector<HTMLButtonElement>(`[aria-label="Connect ${name}"]`)!;
  return { root, button, open, close, setWorkspace, found, connectButton };
}
const listener = () => mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;
beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.installed.mockResolvedValue([managed]);
  mocks.registry.mockResolvedValue(entries);
  mocks.remove.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue("session-1");
  mocks.onEvent.mockResolvedValue(() => undefined);
  mocks.prompt.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.setConfig.mockResolvedValue(undefined);
  mocks.listSessions.mockResolvedValue([{ sessionId: "earlier-chat", title: "Earlier fixture chat", updatedAt: null }]);
  mocks.resumeSession.mockResolvedValue("earlier-chat");
  mocks.newSession.mockResolvedValue("new-chat");
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
describe("agent menu", () => {
  it("preserves model selection, streamed Markdown, queued follow-ups and chat resume after connecting a curated agent", async () => {
    const { root, open, button, connectButton } = mount(); await open(); connectButton("codex-acp").click(); await flush();
    const receive = listener();
    receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
    receive({ kind: "capabilities", canLoadSession: true, canListSessions: true });
    receive({ kind: "config", sessionId: "session-1", options: [{ id: "model", name: "Model", category: "model", currentValue: "fast", groups: [{ name: "", choices: [{ value: "fast", name: "Fast model" }, { value: "deep", name: "Deep model" }] }] }] } as AgentEvent);
    await flush();
    root.querySelector<HTMLButtonElement>('[aria-label^="Model:"]')!.click(); await flush();
    button("Deep model").click(); await flush();
    expect(mocks.setConfig).toHaveBeenCalledWith("model", "deep");
    const input = root.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
    const type = (text: string) => { input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); };
    type("first question"); root.querySelector<HTMLButtonElement>('[aria-label="Send prompt"]')!.click(); await flush();
    receive({ kind: "text", sessionId: "session-1", text: "**Streamed result**\n\n- preserved formatting" }); await flush();
    // Streamed text is revealed at a steady pace over a few frames, so wait for it rather than expecting it at once.
    await vi.waitFor(() => expect(root.querySelector(".agent-markdown strong")?.textContent).toBe("Streamed result"));
    type("follow up while busy"); root.querySelector<HTMLButtonElement>('[aria-label="Queue follow-up"]')!.click(); await flush();
    expect(root.querySelector('[aria-label="Queued messages"]')?.textContent).toContain("follow up while busy");
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    receive({ kind: "complete", sessionId: "session-1", stopReason: "end_turn" }); await flush();
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(String(mocks.prompt.mock.lastCall?.[0])).toContain("follow up while busy");
    receive({ kind: "complete", sessionId: "session-1", stopReason: "end_turn" }); await flush();
    root.querySelector<HTMLButtonElement>('[aria-label="Earlier sessions"]')!.click(); await flush();
    button("Earlier fixture chat").click(); await flush();
    expect(mocks.resumeSession).toHaveBeenCalledWith("earlier-chat");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("leaves health check sessions renamed by the agent out of Recent in this workspace", async () => {
    mocks.listSessions.mockResolvedValue([
      { sessionId: "h1", title: "Health check response", updatedAt: null },
      { sessionId: "h2", title: "Health check response request", updatedAt: null },
      { sessionId: "ci", title: "Health check of the CI pipeline", updatedAt: null },
      { sessionId: "earlier-chat", title: "Earlier fixture chat", updatedAt: null },
    ]);
    const { root, open, connectButton } = mount(); await open(); connectButton("codex-acp").click(); await flush();
    const receive = listener();
    receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
    receive({ kind: "capabilities", canLoadSession: true, canListSessions: true });
    await flush();
    // Opening History lists the sessions (renamed health sessions left out); going back shows the empty state's recents.
    root.querySelector<HTMLButtonElement>('button[aria-label="Earlier sessions"]')!.click(); await flush();
    await vi.waitFor(() => expect(root.querySelector('section[aria-label="Earlier sessions"]')?.textContent ?? "").toContain("Earlier fixture chat"));
    expect(root.querySelector('section[aria-label="Earlier sessions"]')?.textContent).not.toContain("Health check response");
    root.querySelector<HTMLButtonElement>('[aria-label="Back to session"]')!.click(); await flush();
    await vi.waitFor(() => expect(root.querySelector('[aria-label="Recent in this workspace"]')?.textContent ?? "").toContain("Earlier fixture chat"));
    const recents = root.querySelector('[aria-label="Recent in this workspace"]')!.textContent ?? "";
    expect(recents).toContain("Health check of the CI pipeline");
    expect(recents).not.toContain("Health check response");
  });
  it("shows Claude Code with compact explicit text slots and hides raw executable paths", async () => {
    const { root, open } = mount();
    await open();
    expect(root.textContent).toContain("Claude Code");
    expect(root.textContent).not.toContain("/private/path/node");
    const row = [...root.querySelectorAll(".agent-catalog-row")].find((item) =>
      item.textContent?.includes("Claude Code"),
    )!;
    expect(row.children[0].classList.contains("brand-icon") || row.children[0].classList.contains("icon")).toBe(true);
    expect(row.children[1].classList.contains("agent-menu-copy")).toBe(true);
    expect(row.children[2].classList.contains("agent-menu-trailing")).toBe(true);
    // The custom command row keeps its three slots too: icon, text, chevron.
    const custom = root.querySelector(".sb-custom-toggle")!;
    expect(custom.textContent).toContain("Custom ACP command");
    expect(custom.children[0].classList.contains("icon")).toBe(true);
    expect(custom.children[1].classList.contains("sb-agent-text")).toBe(true);
    expect(custom.children[2].classList.contains("icon")).toBe(true);
    const search = root.querySelector<HTMLInputElement>(
      '[placeholder="Search agents"]',
    )!;
    search.value = "Claude";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelectorAll(".agent-catalog-entry")).toHaveLength(1);
    expect(root.textContent).toContain("Claude Code");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("requires explicit removal confirmation and cancellation never deletes", async () => {
    const { root, open, button, found } = mount();
    await open();
    // The installed agent has one row, under Found on this computer, and its manage menu lives there.
    expect(root.querySelectorAll('[data-agent-id="codex-acp"]')).toHaveLength(1);
    expect(found("codex-acp")?.querySelector('[aria-label="Manage codex-acp"]')).not.toBeNull();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage codex-acp"]')!
      .click();
    button("Uninstall managed adapter").click();
    expect(root.textContent).toContain("Uninstall managed adapter?");
    expect(mocks.remove).not.toHaveBeenCalled();
    button("Cancel").click();
    expect(mocks.remove).not.toHaveBeenCalled();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage codex-acp"]')!
      .click();
    button("Remove from Span").click();
    button("Remove from Span").click();
    await flush();
    expect(mocks.remove).toHaveBeenCalledWith("codex-acp", false);
  });
  it("blocks removing a connected agent while edits await review", async () => {
    const { root, open, button, connectButton } = mount();
    await open();
    connectButton("codex-acp").click();
    await flush();
    listener()({
      kind: "proposal",
      sessionId: "session-1",
      proposal: {
        id: "p1",
        path: "file.ts",
        baseRevision: 0,
        hunks: [{ id: "h1", from: 0, to: 0, before: "", after: "x" }],
      },
    } as AgentEvent);
    await open();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage codex-acp"]')!
      .click();
    button("Remove from Span").click();
    expect(root.textContent).toContain("Review or reject");
    expect(button("Remove from Span").disabled).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
  it("ignores a connection result from the previous workspace", async () => {
    let resolve!: (id: string) => void;
    mocks.connect.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const { root, open, setWorkspace, connectButton } = mount();
    await open();
    connectButton("codex-acp").click();
    await flush();
    setWorkspace("/workspace/two");
    await flush();
    resolve("old-session");
    await flush();
    expect(root.textContent).not.toContain("Connected and ready");
    expect(root.querySelector(".agent-catalog")).not.toBeNull();
    expect(root.querySelector('[aria-label="Select agent"]')).not.toBeNull();
    expect(root.querySelector('[aria-label^="Model:"]')).toBeNull();
    expect(root.querySelector('[aria-label^="Agent:"]')).toBeNull();
  });

  it("keeps installation state on its row while search, close, and other agents stay usable", async () => {
    let finishInstall!: (agent: InstalledAgent) => void;
    mocks.install.mockReturnValue(
      new Promise<InstalledAgent>((resolve) => {
        finishInstall = resolve;
      }),
    );
    const claude: InstalledAgent = {
      id: "claude-acp",
      version: "1.0.0",
      launch: { command: "/managed/claude", args: [], env: {} },
    };
    const { root, open, close, found, connectButton } = mount();
    await open();

    const claudeRow = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".agent-catalog-row")].find(
        (row) => row.textContent?.includes("Claude Code"),
      )!;
    claudeRow().click();
    claudeRow().click();
    await flush();

    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(claudeRow().disabled).toBe(true);
    expect(claudeRow().closest(".agent-catalog-entry")?.getAttribute("aria-busy")).toBe("true");
    expect(claudeRow().textContent).toContain("Installing…");

    const search = root.querySelector<HTMLInputElement>(
      '[placeholder="Search agents"]',
    )!;
    search.value = "Codex";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(connectButton("codex-acp").disabled).toBe(false);
    connectButton("codex-acp").click();
    await flush();
    expect(mocks.connect).toHaveBeenCalled();

    await open();
    await close();
    expect(root.querySelector(".agent-catalog")).toBeNull();
    await open();
    const reopenedSearch = root.querySelector<HTMLInputElement>(
      '[placeholder="Search agents"]',
    )!;
    reopenedSearch.value = "";
    reopenedSearch.dispatchEvent(new Event("input", { bubbles: true }));
    expect(claudeRow().textContent).toContain("Installing…");

    mocks.installed.mockResolvedValue([managed, claude]);
    finishInstall(claude);
    await flush();
    // Installed, the agent leaves the curated list and has one row under Found on this computer.
    expect(claudeRow()).toBeUndefined();
    expect(found("claude-acp")?.textContent).toContain("Installed · 1.0.0");
    connectButton("claude-acp").click();
    await flush();
    expect(mocks.connect).toHaveBeenLastCalledWith(
      claude.launch,
      "/workspace/one",
    );
  });

  it("shows install errors and lets the same row retry", async () => {
    const claude: InstalledAgent = {
      id: "claude-acp",
      version: "1.0.0",
      launch: { command: "/managed/claude", args: [], env: {} },
    };
    mocks.install
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockResolvedValueOnce(claude);
    const { root, open, found } = mount();
    await open();
    const claudeRow = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".agent-catalog-row")].find(
        (row) => row.textContent?.includes("Claude Code"),
      )!;

    claudeRow().click();
    await flush();
    expect(root.textContent).toContain("registry unavailable");
    expect(claudeRow().textContent).toContain("Retry");
    expect(claudeRow().disabled).toBe(false);

    claudeRow().click();
    await flush();
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(claudeRow()).toBeUndefined();
    expect(found("claude-acp")?.textContent).toContain("Installed · 1.0.0");
  });

  it("keeps completed parallel installs when an older installed-agent read returns last", async () => {
    const codex: InstalledAgent = {
      id: "codex-acp",
      version: "2.3.0",
      launch: { command: "/managed/codex", args: [], env: {} },
    };
    const claude: InstalledAgent = {
      id: "claude-acp",
      version: "1.0.0",
      launch: { command: "/managed/claude", args: [], env: {} },
    };
    let finishOldRead!: (agents: InstalledAgent[]) => void;
    let finishCodexInstall!: (agent: InstalledAgent) => void;
    let finishClaudeInstall!: (agent: InstalledAgent) => void;
    mocks.installed.mockResolvedValueOnce([]).mockImplementationOnce(
      () => new Promise<InstalledAgent[]>((resolve) => (finishOldRead = resolve)),
    );
    mocks.install.mockImplementation((id: string) => {
      if (id === "codex-acp")
        return new Promise<InstalledAgent>((resolve) => (finishCodexInstall = resolve));
      return new Promise<InstalledAgent>((resolve) => (finishClaudeInstall = resolve));
    });

    const { root, open, found } = mount();
    await open();
    root.querySelector<HTMLButtonElement>('[aria-label="Refresh agent registry"]')!.click();
    const row = (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>(".agent-catalog-row")].find(
        (item) => item.textContent?.includes(name),
      )!;
    row("Codex").click();
    row("Claude Code").click();

    finishCodexInstall(codex);
    await flush();
    finishClaudeInstall(claude);
    await flush();
    expect(found("codex-acp")?.textContent).toContain("Installed · 2.3.0");
    expect(found("claude-acp")?.textContent).toContain("Installed · 1.0.0");
    expect(row("Codex")).toBeUndefined();
    expect(row("Claude Code")).toBeUndefined();

    finishOldRead([codex]);
    await flush();
    expect(found("codex-acp")?.textContent).toContain("Installed · 2.3.0");
    expect(found("claude-acp")?.textContent).toContain("Installed · 1.0.0");
    expect(row("Codex")).toBeUndefined();
    expect(row("Claude Code")).toBeUndefined();
    expect(mocks.install).toHaveBeenCalledTimes(2);
  });

  it("waits for disconnect before removing an active managed adapter", async () => {
    let finishDisconnect!: () => void;
    const order: string[] = [];
    mocks.disconnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = () => {
            order.push("disconnected");
            resolve();
          };
        }),
    );
    mocks.remove.mockImplementation(async () => {
      order.push("removed");
    });
    const { root, open, button, connectButton } = mount();
    await open();
    connectButton("codex-acp").click();
    await flush();

    await open();
    root.querySelector<HTMLButtonElement>('[aria-label="Manage codex-acp"]')!.click();
    expect(root.textContent).not.toContain("The connected session will disconnect first.");
    button("Remove from Span").click();
    expect(root.textContent).toContain("The connected session will disconnect first.");
    button("Remove from Span").click();
    await flush();
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();

    finishDisconnect();
    await flush();
    expect(order).toEqual(["disconnected", "removed"]);
  });

  it("puts a curated agent's local command in the custom row for review instead of running it", async () => {
    mocks.registry.mockResolvedValue([{ ...entries[2], installable: false }]);
    const { root, open, button } = mount();
    await open();
    button("Cursor").click();
    await flush();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLInputElement>('[aria-label="ACP command"]')?.value).toBe("cursor-agent acp");
  });

  it("explains a command that cannot start an ACP session", async () => {
    mocks.connect.mockRejectedValue(new Error("JSON-RPC error -32601: Method not found"));
    const { root, open, connectButton } = mount();
    await open();
    connectButton("codex-acp").click();
    await flush();
    expect(root.textContent).toContain("This command could not start an ACP session.");
  });
});
