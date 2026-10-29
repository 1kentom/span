// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { AgentEvent, InstalledAgent, RegistryAgent } from "../bindings";
import { AgentPanel } from "./AgentPanel";
import { pillVisible } from "../lib/agent-feed";
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

async function session() {
  const { root, open, connectButton } = mount(); await open(); connectButton("codex-acp").click(); await flush();
  const receive = listener();
  receive({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] });
  receive({ kind: "text", sessionId: "session-1", text: "hello" }); await flush();
  const scroller = root.querySelector<HTMLElement>(".agent-content")!;
  const metrics = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
  for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) Object.defineProperty(scroller, key, { configurable: true, writable: true, value: metrics[key] });
  // The scroll event a browser fires on reaching the bottom, so the feed knows where the reader starts.
  scroller.dispatchEvent(new Event("scroll"));
  // A user scroll: only a gesture on the scroller detaches the feed (feed-follow.ts), so the wheel comes first.
  const scrollTo = async (top: number) => { scroller.dispatchEvent(new Event("wheel")); (scroller as unknown as { scrollTop: number }).scrollTop = top; scroller.dispatchEvent(new Event("scroll")); await flush(); };
  return { root, scroller, scrollTo };
}
const pill = (root: HTMLElement) => root.querySelector<HTMLButtonElement>(".agent-jump")!;
describe("latest pill", () => {
  it("lives inside the feed region, not beside the composer dock", async () => {
    const { root } = await session();
    const region = root.querySelector(".agent-feed-region")!;
    expect(pill(root).parentElement).toBe(region);
    expect(region.contains(root.querySelector(".agent-content"))).toBe(true);
    expect(region.contains(root.querySelector(".agent-footer"))).toBe(false);
  });
  it("is hidden and inert at the bottom, shown only beyond the threshold, with hysteresis", async () => {
    const { root, scrollTo } = await session();
    expect(pill(root).getAttribute("aria-hidden")).toBe("true");
    expect(pill(root).tabIndex).toBe(-1);
    await scrollTo(1500);
    expect(pill(root).classList.contains("shown")).toBe(true);
    expect(pill(root).getAttribute("aria-hidden")).toBeNull();
    expect(pill(root).tabIndex).toBe(0);
    await scrollTo(1530);
    expect(pill(root).classList.contains("shown")).toBe(true);
    await scrollTo(1600);
    expect(pill(root).classList.contains("shown")).toBe(false);
  });
  it("keeps following when a scroll event without a user gesture lands far from the bottom", async () => {
    const { root, scroller } = await session();
    // The echo of a pin read after a big chunk grew the feed, or a frame of an older smooth scroll.
    (scroller as unknown as { scrollHeight: number }).scrollHeight = 2466;
    scroller.dispatchEvent(new Event("scroll"));
    await flush();
    expect(pill(root).classList.contains("shown")).toBe(false);
    expect(scroller.dataset.follow).toBe("following");
  });
  it("scrolls to the very bottom on click and hides again", async () => {
    const { root, scroller, scrollTo } = await session();
    await scrollTo(100);
    const spy = vi.fn();
    scroller.scrollTo = spy as never;
    pill(root).click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ top: 2000 }));
    await flush();
    expect(pill(root).classList.contains("shown")).toBe(false);
  });
});
describe("pillVisible", () => {
  const at = (distance: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - distance });
  it("hides near the bottom, shows far away, and keeps the previous state between", () => {
    expect(pillVisible(true, at(48))).toBe(false);
    expect(pillVisible(false, at(96))).toBe(true);
    expect(pillVisible(false, at(70))).toBe(false);
    expect(pillVisible(true, at(70))).toBe(true);
  });
});
