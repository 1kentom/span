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
  },
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
  const open = async () => {
    root
      .querySelector<HTMLButtonElement>(
        '.agent-composer-button[aria-haspopup="dialog"]',
      )!
      .click();
    await flush();
  };
  return { root, button, open, setWorkspace };
}
beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.installed.mockResolvedValue([managed]);
  mocks.registry.mockResolvedValue(entries);
  mocks.remove.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue("session-1");
  mocks.onEvent.mockResolvedValue(() => undefined);
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
describe("agent menu", () => {
  it("shows Claude Code with compact explicit text slots and hides raw executable paths", async () => {
    const { root, open } = mount();
    await open();
    expect(root.textContent).toContain("Claude Code");
    expect(root.textContent).not.toContain("/private/path/node");
    const row = [...root.querySelectorAll(".agent-catalog-row")].find((item) =>
      item.textContent?.includes("Custom ACP command"),
    )!;
    expect(row.children[0].classList.contains("icon")).toBe(true);
    expect(row.children[1].classList.contains("agent-menu-copy")).toBe(true);
    expect(row.children[2].classList.contains("icon")).toBe(true);
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
    const { root, open, button } = mount();
    await open();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage Codex"]')!
      .click();
    button("Uninstall managed adapter").click();
    expect(root.textContent).toContain("Uninstall managed adapter?");
    expect(mocks.remove).not.toHaveBeenCalled();
    button("Cancel").click();
    expect(mocks.remove).not.toHaveBeenCalled();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage Codex"]')!
      .click();
    button("Remove from Span").click();
    button("Remove from Span").click();
    await flush();
    expect(mocks.remove).toHaveBeenCalledWith("codex-acp", false);
  });
  it("blocks removing a connected agent while edits await review", async () => {
    const { root, open, button } = mount();
    await open();
    button("Codex").click();
    await flush();
    const listener = mocks.onEvent.mock.calls[0][0] as (
      event: AgentEvent,
    ) => void;
    listener({
      kind: "proposal",
      sessionId: "session-1",
      proposal: {
        id: "p1",
        path: "file.ts",
        baseRevision: 0,
        hunks: [{ id: "h1", from: 0, to: 0, before: "", after: "x" }],
      },
    });
    await open();
    root
      .querySelector<HTMLButtonElement>('[aria-label="Manage Codex"]')!
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
    const { root, open, button, setWorkspace } = mount();
    await open();
    button("Codex").click();
    await flush();
    setWorkspace("/workspace/two");
    await flush();
    resolve("old-session");
    await flush();
    expect(root.textContent).toContain("No agent connected");
    expect(root.textContent).not.toContain("Connected and ready");
    expect(button("Select agent")).toBeTruthy();
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
    const { root, open, button } = mount();
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
    expect(button("Codex").disabled).toBe(false);
    button("Codex").click();
    await flush();
    expect(mocks.connect).toHaveBeenCalled();

    await open();
    root.querySelector<HTMLButtonElement>(".agent-menu-dismiss")!.click();
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
    expect(claudeRow().disabled).toBe(false);
    expect(claudeRow().textContent).toContain("Installed · 1.0.0");
    claudeRow().click();
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
    const { root, open } = mount();
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
    expect(claudeRow().textContent).toContain("Installed · 1.0.0");
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

    const { root, open } = mount();
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
    expect(row("Codex").textContent).toContain("Installed · 2.3.0");
    expect(row("Claude Code").textContent).toContain("Installed · 1.0.0");

    finishOldRead([codex]);
    await flush();
    expect(row("Codex").textContent).toContain("Installed · 2.3.0");
    expect(row("Claude Code").textContent).toContain("Installed · 1.0.0");
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
    const { root, open, button } = mount();
    await open();
    button("Codex").click();
    await flush();

    await open();
    root.querySelector<HTMLButtonElement>('[aria-label="Manage Codex"]')!.click();
    button("Remove from Span").click();
    button("Remove from Span").click();
    await flush();
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();

    finishDisconnect();
    await flush();
    expect(order).toEqual(["disconnected", "removed"]);
  });
});
