// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController, type AgentPanelProps } from "../../lib/agent-controller";
import { composerHints } from "../../lib/agent-hints";
import { DOCK_TAB_HINT } from "../../lib/agent-dock-focus";
import { AgentComposer } from "./AgentComposer";
import { AgentFeed } from "./AgentFeed";
import { HistoryList } from "./HistoryList";
import { AttachmentTray } from "../attachments";
import { key, mount, text } from "./test-utils";

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

const features = (patch: Partial<AgentFeatures> = {}): AgentFeatures => ({ loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function composer(agentFeatures = features(), props: Partial<AgentPanelProps> = {}) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: agentFeatures, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1, ...props });
    return <AgentComposer agent={controller} brand={{ id: "a", name: "Agent" }} label="Agent" />;
  });
  await tick();
  controller.connectCustom("agent");
  await tick();
  return { a: controller, host };
}
const openMenu = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[aria-label^='Attach files and context']")!.click();
const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
const label = (item: HTMLElement) => item.querySelector(".att-menu-label")?.textContent;

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentCancel.mockClear();
  mocks.api.agentPermission.mockClear();
  mocks.api.agentPrompt.mockClear();
});

describe("attach menu wiring", () => {
  it("offers only items with a real handler, and gives the reason for disabled ones", async () => {
    const { host } = await composer();
    openMenu(host);
    expect(items(host).map(label)).toEqual(["Upload files", "Add image", "Current file", "Selection"]);
    const byName = Object.fromEntries(items(host).map((item) => [label(item), item]));
    expect(byName["Current file"].getAttribute("aria-disabled")).toBe("true");
    expect(byName["Current file"].textContent).toContain("No file is open");
    expect(byName["Selection"].textContent).toContain("Nothing is selected");
    expect(byName["Upload files"].getAttribute("aria-disabled")).toBeNull();
    expect(host.textContent).not.toContain("Paste screenshot");
    expect(host.textContent).not.toContain("Folder");
    expect(host.textContent).not.toContain("Earlier session");
  });

  it("enables Current file and Selection from the editor state and disables images the agent cannot read", async () => {
    const { a, host } = await composer(features({ image: false }), { activePath: "src/a.ts", selectionContext: { path: "src/a.ts", text: "x", startLine: 1, endLine: 1 } });
    openMenu(host);
    let byName = Object.fromEntries(items(host).map((item) => [label(item), item]));
    expect(byName["Current file"].getAttribute("aria-disabled")).toBeNull();
    expect(byName["Add image"].getAttribute("aria-disabled")).toBe("true");
    expect(byName["Add image"].textContent).toContain("does not accept images");
    // The controller hides a selection that existed before the panel mounted, so it can be brought back here.
    expect(a.selection()).toBeUndefined();
    expect(byName["Selection"].getAttribute("aria-disabled")).toBeNull();
    byName["Current file"].click();
    expect(a.contextPaths()).toEqual(["src/a.ts"]);
    openMenu(host);
    byName = Object.fromEntries(items(host).map((item) => [label(item), item]));
    expect(byName["Current file"].textContent).toContain("Already added");
    byName["Selection"].click();
    expect(a.selection()?.text).toBe("x");
    openMenu(host);
    byName = Object.fromEntries(items(host).map((item) => [label(item), item]));
    expect(byName["Selection"].textContent).toContain("Already included");
  });
});

describe("composer keys", () => {
  it("Enter steers and Tab queues while a turn runs, and the hints match", async () => {
    const { a, host } = await composer();
    a.setPrompt("first");
    await a.send();
    expect([...host.querySelectorAll(".sb-hint")].map((hint) => text(hint))).toEqual(["Enter Steer", "Tab Queue", "Esc Stop"]);
    const area = host.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
    a.setPrompt("queued one");
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    area.dispatchEvent(tab);
    await tick();
    expect(tab.defaultPrevented).toBe(true);
    expect(a.queue().map((entry) => entry.text)).toEqual(["queued one"]);
    expect(mocks.api.agentCancel).not.toHaveBeenCalled();
    a.setPrompt("redirect");
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();
    expect(mocks.api.agentCancel).toHaveBeenCalledTimes(1);
    const empty = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    a.setPrompt("");
    area.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(false);
  });

  it("shows idle hints and no hint for permission when no option matches", async () => {
    const { host } = await composer();
    expect(host.querySelectorAll(".sb-hint-key .key-enter").length).toBe(3);
    expect(host.textContent).not.toMatch(/[\u21b5\u21a9\u23ce]/);
    expect([...host.querySelectorAll(".sb-hint")].map((hint) => text(hint))).toEqual(["Enter Send", "⇧Enter Newline", "/ Commands", "⌥Enter Attach"]);
    expect(composerHints({ dockFocused: true, permission: [] }).permission).toEqual([]);
  });
});

describe("composerHints", () => {
  it("lists only bound keys per mode", () => {
    expect(composerHints({ dockFocused: true, permission: [{ optionId: "a", name: "Allow", kind: "allow_once" }] }).permission).toEqual([{ keys: ["Y"], label: "Allow" }]);
    expect(composerHints({ dockFocused: true, permission: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "No", kind: "reject_once" }] }).permission.map((hint) => hint.keys[0])).toEqual(["Y", "N"]);
    expect(composerHints({ dockFocused: true, elicitation: { mode: "form" }, field: { options: [1] } }).question).toEqual([{ keys: ["1-9"], label: "Pick an option" }, { keys: ["Esc"], label: "Decline" }]);
    expect(composerHints({ dockFocused: true, elicitation: { mode: "form" }, field: { options: [] } }).question).toEqual([{ keys: ["Esc"], label: "Decline" }]);
    expect(composerHints({ dockFocused: true, elicitation: { mode: "url" } }).question).toEqual([{ keys: ["↵"], label: "Open browser" }, { keys: ["Esc"], label: "Decline" }]);
    expect(composerHints({ dockFocused: true }).question).toEqual([]);
  });
});

describe("history delete confirm", () => {
  const rows = [{ id: "a", title: "Chat A", updatedAt: Date.now(), inWorkspace: true, current: true }, { id: "b", title: "Chat B", updatedAt: Date.now(), inWorkspace: true }];
  const base = { query: "", onQuery: () => undefined, scope: "workspace" as const, onScope: () => undefined, onOpen: () => undefined };
  it("asks before deleting, cancels with Escape, and offers Close only on the current row", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const host = mount(() => <HistoryList {...base} rows={rows} onDelete={onDelete} onClose={onClose} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat A']")!.click();
    expect([...host.querySelectorAll("[role=menuitem] .sb-menu-label")].map((item) => text(item))).toEqual(["Close session", "Delete"]);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    expect([...host.querySelectorAll("[role=menuitem] .sb-menu-label")].map((item) => text(item))).toEqual(["Delete"]);
    host.querySelector<HTMLButtonElement>("[role=menuitem].danger")!.click();
    expect(onDelete).not.toHaveBeenCalled();
    expect(host.querySelector(".sb-confirm")).not.toBeNull();
    key("Escape");
    expect(host.querySelector(".sb-confirm")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    host.querySelector<HTMLButtonElement>("[role=menuitem].danger")!.click();
    host.querySelector<HTMLButtonElement>(".sb-confirm .danger")!.click();
    expect(onDelete).toHaveBeenCalledWith("b");
    expect(host.querySelector(".sb-confirm")).toBeNull();
  });
  it("shows no menu on a locked row when no callback is supplied", () => {
    const host = mount(() => <HistoryList {...base} rows={rows.map((row) => ({ ...row, locked: true }))} />);
    expect(host.querySelector(".row-menu")).toBeNull();
  });
});

describe("attachment tray", () => {
  it("renders a loading tile with a progress bar and a link tile", () => {
    const loading = { id: "1", kind: "file" as const, name: "big.zip", mime: "application/zip", size: 10, source: "picked" as const, status: "loading" as const };
    const link = { id: "2", kind: "file" as const, name: "notes.md", mime: "text/markdown", size: 4, source: "workspace-file" as const, path: "notes.md", status: "ready" as const };
    const host = mount(() => <AttachmentTray items={[loading, link]} capabilities={{ image: true, audio: false, embeddedContext: true }} onOpen={() => undefined} onRemove={() => undefined} />);
    const tiles = [...host.querySelectorAll<HTMLElement>(".att-tile")];
    expect(tiles.map((tile) => tile.dataset.state)).toEqual(["uploading", "link"]);
    expect(host.querySelector("[role=progressbar]")).not.toBeNull();
  });
});

describe("delegation in the sidebar", () => {
  const lead = { connectionId: "c1", sessionId: "s1" };
  const child = { connectionId: "c1", sessionId: "k1" };
  const options = [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }];

  it("shows nothing about delegation while it is off", async () => {
    const { host } = await composer();
    expect(host.querySelector(".agent-delegation-line")).toBeNull();
  });

  it("shows the status line when attached and the reason when the agent cannot get the tools", async () => {
    const { host } = await composer();
    mocks.emit({ kind: "delegation", event: { kind: "attached", lead, agentName: "Agent" } });
    expect(text(host.querySelector(".agent-delegation-line"))).toBe("Delegation on");
    mocks.emit({ kind: "delegation", event: { kind: "detached", lead } }, { kind: "delegation", event: { kind: "unavailable", connectionId: "c1", agentName: "Agent", reason: "This agent does not offer MCP over HTTP" } });
    expect(text(host.querySelector(".agent-delegation-line"))).toBe("Delegation unavailable: This agent does not offer MCP over HTTP");
    expect(host.querySelector(".agent-delegation-line.warn")).not.toBeNull();
  });

  it("docks a delegated child's request with the agent name and answers it through the child command", async () => {
    const { host } = await composer();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" } }, { kind: "permission", sessionId: "k1", requestId: "r1", toolCallId: "t", title: "Run pnpm test", options });
    const dock = host.querySelector(".sb-dock")!;
    expect(dock.getAttribute("aria-label")).toBe("Codex asks permission: Run pnpm test");
    expect(text(dock.querySelector(".sb-dock-from"))).toContain("Codex");
    expect(mocks.agentChildPermission).not.toHaveBeenCalled();
    [...dock.querySelectorAll<HTMLButtonElement>("button.sb-btn")].find((button) => button.textContent?.startsWith("Allow"))!.click();
    await tick();
    expect(mocks.agentChildPermission).toHaveBeenCalledWith("c1", "k1", "r1", "ok");
    expect(host.querySelector(".sb-dock")).toBeNull();
  });

  it("does not dock a request from a session no delegation card names", async () => {
    const { host } = await composer();
    mocks.emit({ kind: "permission", sessionId: "unknown", requestId: "r9", toolCallId: "t", title: "Run it", options });
    expect(host.querySelector(".sb-dock")).toBeNull();
  });

  it("renders decision and delegation cards in the feed where they arrived", async () => {
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s1" });
      return "s1";
    });
    let controller!: AgentController;
    const host = mount(() => {
      controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <AgentFeed agent={controller} />;
    });
    await tick();
    controller.connectCustom("agent");
    await tick();
    mocks.emit(
      { kind: "text", sessionId: "s1", text: "Plan" },
      { kind: "delegation", event: { kind: "decision", lead, decision: { id: "d1", chosen: "Use Codex", why: "It has tests", alternatives: ["Do it myself"], recordedAt: 1 } } },
      { kind: "delegation", event: { kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" } },
      { kind: "delegation", event: { kind: "taskFinished", lead, child, taskId: "t1", status: "failed", reason: "timeout" } },
    );
    const order = [...host.querySelectorAll(".agent-feed > *")].map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["agent-message", "sb-decision", "sb-delegation"]);
    expect(text(host.querySelector(".sb-decision"))).toContain("Decision · Agent");
    expect(text(host.querySelector(".sb-delegation"))).toContain("The task timed out");
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Failed");
  });
});

describe("queued messages after an error", () => {
  it("shows the held queue with a one-click Send queued that sends it", async () => {
    const { a, host } = await composer();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("second");
    await a.send();
    mocks.emit({ kind: "error", message: "rate limited" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    const button = host.querySelector<HTMLButtonElement>("[aria-label='Send 1 queued message']")!;
    expect(button).not.toBeNull();
    button.click();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("second", []);
  });
});

describe("typed child events and cancel in the sidebar", () => {
  const lead = { connectionId: "c1", sessionId: "s1" };
  const child = { connectionId: "c1", sessionId: "k1" };
  const options = [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }];

  it("docks a request the typed childPermission event names, with no card, and answers with the typed child key", async () => {
    const { host } = await composer();
    mocks.emit(
      { kind: "permission", sessionId: "k1", requestId: "r1", toolCallId: "t", title: "Run pnpm test", options },
      { kind: "delegation", event: { kind: "childPermission", lead, child, taskId: "t1", agentName: "Reviewer", connectionId: "c1", sessionId: "k1", requestId: "r1", requestKind: "permission" } },
    );
    const dock = host.querySelector(".sb-dock")!;
    expect(dock.getAttribute("aria-label")).toBe("Reviewer asks permission: Run pnpm test");
    [...dock.querySelectorAll<HTMLButtonElement>("button.sb-btn")].find((button) => button.textContent?.startsWith("Allow"))!.click();
    await tick();
    expect(mocks.agentChildPermission).toHaveBeenCalledWith("c1", "k1", "r1", "ok");
  });

  it("never docks a request from a session no typed event or card names", async () => {
    const { host } = await composer();
    mocks.emit(
      { kind: "permission", sessionId: "k5", requestId: "r5", toolCallId: "t", title: "Run it", options },
      { kind: "delegation", event: { kind: "childPermission", lead, child, taskId: "t1", agentName: "Reviewer", connectionId: "c1", sessionId: "k1", requestId: "other", requestKind: "permission" } },
    );
    expect(host.querySelector(".sb-dock")).toBeNull();
  });

  it("cancels a running task from the card's Cancel button only, and refreshes the status", async () => {
    mocks.agentCancelTask.mockClear();
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s1" });
      return "s1";
    });
    let controller!: AgentController;
    const host = mount(() => {
      controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <AgentFeed agent={controller} />;
    });
    await tick();
    controller.connectCustom("agent");
    await tick();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead, child, taskId: "t1", agentName: "Codex" } });
    await tick();
    expect(mocks.agentCancelTask).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>(".sb-delegation-actions button")!.click();
    await tick();
    expect(mocks.agentCancelTask).toHaveBeenCalledExactlyOnceWith("t1");
    mocks.emit({ kind: "delegation", event: { kind: "taskFinished", lead, child, taskId: "t1", status: "failed", reason: "cancelled" } });
    expect(host.querySelector(".sb-delegation-actions")).toBeNull();
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Cancelled");
  });
});

describe("focus and hints for the permission, question and URL docks", () => {
  const options = [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }];
  const ask = (requestId = "p1") => mocks.emit({ kind: "permission", sessionId: "s1", requestId, toolCallId: "t", title: "Run ls", options });
  const hints = (host: HTMLElement) => [...host.querySelectorAll(".sb-hint")].map((hint) => text(hint));
  const area = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
  const typeInto = (host: HTMLElement, value: string) => {
    area(host).focus();
    area(host).value = value;
    area(host).dispatchEvent(new Event("input", { bubbles: true }));
  };
  afterEach(() => vi.useRealTimers());

  it("moves focus to the primary control when the user is idle, with no Tab line and the key hints shown", async () => {
    const { host } = await composer();
    ask();
    await tick();
    const allow = host.querySelector<HTMLButtonElement>(".sb-dock .sb-btn.primary")!;
    expect(document.activeElement).toBe(allow);
    expect(host.querySelector(".sb-dock-tabhint")).toBeNull();
    expect(hints(host)).toEqual(["Y Allow", "N Reject"]);
    expect(mocks.api.agentPermission).not.toHaveBeenCalled();
  });

  it("does not steal focus within 1500 ms of typing, and shows the same Tab line in the dock and the hints row", async () => {
    const { host } = await composer();
    typeInto(host, "x");
    area(host).value = "";
    area(host).dispatchEvent(new Event("input", { bubbles: true }));
    ask();
    await tick();
    expect(document.activeElement).toBe(area(host));
    expect(text(host.querySelector(".sb-dock-tabhint"))).toBe(DOCK_TAB_HINT);
    expect(hints(host)).toEqual([DOCK_TAB_HINT]);
  });

  it("does not steal focus while the focused composer holds unsent text, even when the typing was long ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { host } = await composer();
    typeInto(host, "half a sentence");
    vi.setSystemTime(1_010_000);
    ask();
    await tick();
    expect(document.activeElement).toBe(area(host));
    expect(host.querySelector(".sb-dock-tabhint")).not.toBeNull();
  });

  it("takes focus once the typing pause has passed and the composer is empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { host } = await composer();
    typeInto(host, "a");
    typeInto(host, "");
    vi.setSystemTime(1_001_600);
    ask();
    await tick();
    expect(document.activeElement).toBe(host.querySelector(".sb-dock .sb-btn.primary"));
  });

  it("answers y only with dock focus: not from the composer, then yes after Tab moves into the dock", async () => {
    const { host } = await composer();
    typeInto(host, "x");
    ask();
    await tick();
    key("y", {}, area(host));
    key("y");
    expect(mocks.api.agentPermission).not.toHaveBeenCalled();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    area(host).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector(".sb-dock .sb-btn.primary"));
    expect(hints(host)).toEqual(["Y Allow", "N Reject"]);
    expect(host.querySelector(".sb-dock-tabhint")).toBeNull();
    key("y", {}, document.activeElement!);
    await tick();
    expect(mocks.api.agentPermission).toHaveBeenCalledWith("p1", "ok");
  });

  it("goes back to the Tab hint when focus leaves the dock", async () => {
    const { host } = await composer();
    ask();
    await tick();
    expect(hints(host)).toEqual(["Y Allow", "N Reject"]);
    area(host).focus();
    expect(hints(host)).toEqual([DOCK_TAB_HINT]);
    expect(text(host.querySelector(".sb-dock-tabhint"))).toBe(DOCK_TAB_HINT);
  });

  it("focuses the first option of a question dock and the Open browser button of a URL dock when idle", async () => {
    const { host } = await composer();
    mocks.emit({ kind: "elicitation", sessionId: "s1", requestId: "q1", mode: "form", message: "Which?", schemaJson: JSON.stringify({ type: "object", properties: { db: { type: "string", enum: ["pg", "sq"] } } }) });
    await tick();
    expect(document.activeElement).toBe(host.querySelector(".sb-dock .sb-q-option"));
    mocks.emit({ kind: "elicitationResolved", requestId: "q1" });
    mocks.emit({ kind: "elicitation", sessionId: "s1", requestId: "u1", mode: "url", message: "Sign in", url: "https://example.com/login" });
    await tick();
    expect(document.activeElement).toBe(host.querySelector(".sb-dock .sb-btn.primary"));
    expect(host.querySelector(".sb-dock .sb-btn.primary")!.textContent).toContain("Open browser");
  });
});
