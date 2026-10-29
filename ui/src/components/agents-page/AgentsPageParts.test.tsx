// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { AgentController } from "../../lib/agent-controller";
import type { FeedItem } from "../../lib/agent-session";
import type { RailRow } from "../../lib/agents-page";
import type { LiveAgent } from "../../lib/live-agents";
import { AgentModeSwitch } from "../AgentModeSwitch";
import { mount, text } from "../agent/test-utils";
import { SessionsRail } from "./SessionsRail";
import { SidePanel, sessionFiles, type SideTab } from "./SidePanel";

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const key = (target: Element, name: string, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));

describe("AgentModeSwitch", () => {
  it("is a radio group with one tab stop that clicks and arrow keys switch", async () => {
    const [mode, setMode] = createSignal<"editor" | "agents">("editor");
    const onChange = vi.fn(setMode);
    const host = mount(() => <AgentModeSwitch mode={mode()} onChange={onChange} shortcut="⌘⇧A" />);
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Layout");
    const [editor, agents] = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(editor.getAttribute("aria-checked")).toBe("true");
    expect([editor.tabIndex, agents.tabIndex]).toEqual([0, -1]);
    expect(agents.title).toBe("Agents layout (⌘⇧A)");
    agents.click();
    expect(onChange).toHaveBeenLastCalledWith("agents");
    expect(agents.getAttribute("aria-checked")).toBe("true");
    expect([editor.tabIndex, agents.tabIndex]).toEqual([-1, 0]);
    key(agents, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("editor");
    key(editor, "End");
    expect(mode()).toBe("agents");
    // Clicking the chosen option changes nothing.
    onChange.mockClear();
    agents.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});

const NOW = Date.now();
const row = (id: string, patch: Partial<RailRow> = {}): RailRow => ({ id, sessionId: id, title: `Thread ${id}`, updatedAt: NOW - 120_000, state: "idle", statusText: "Idle", agents: [{ id: "codex-acp", name: "Codex" }], ...patch });

describe("SessionsRail", () => {
  const rows = [
    row("ask", { state: "needs", statusText: "Waiting for your approval" }),
    row("run", { state: "working", statusText: "Working", current: true }),
    row("done", { delta: { add: 12, del: 3 } }),
    row("away", { unavailable: "This session belongs to another folder" }),
    row("old", { archived: true, title: "Archived thread" }),
  ];
  const setup = () => {
    const onOpen = vi.fn();
    const onNew = vi.fn();
    const host = mount(() => <SessionsRail rows={rows} now={NOW} workspaceName="span" scope="workspace" onScope={() => undefined} onOpen={onOpen} onNew={onNew} searchShortcut="⌘K" />);
    const option = (id: string) => host.querySelector<HTMLElement>(`[role="option"][data-row-id="${id}"]`)!;
    return { host, onOpen, onNew, option };
  };

  it("groups rows into Needs you, Working and Recent with counts, and keeps old rows under a collapsed Settled row", () => {
    const { host, option } = setup();
    const heads = [...host.querySelectorAll(".ap-group-head")].map((head) => text(head));
    expect(heads).toEqual(["Needs you1", "Working1", "Recent2"]);
    expect(option("old")).toBeNull();
    const settled = [...host.querySelectorAll("button")].find((button) => text(button)?.startsWith("Settled"))!;
    expect(settled.getAttribute("aria-expanded")).toBe("false");
    expect(text(settled)).toContain("Settled · 1");
    settled.click();
    expect(option("old")).not.toBeNull();
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(2);
  });

  it("has one tab stop on the open thread and moves with the arrow keys, Home and End", async () => {
    const { option } = setup();
    const tabStops = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter((element) => element.tabIndex === 0).map((element) => element.dataset.rowId);
    expect(tabStops()).toEqual(["run"]);
    expect(option("run").getAttribute("aria-selected")).toBe("true");
    option("run").focus();
    key(option("run"), "ArrowDown");
    await flush();
    // Recent is newest first, then by title: "Thread away" before "Thread done".
    expect(document.activeElement).toBe(option("away"));
    expect(tabStops()).toEqual(["away"]);
    key(option("away"), "End");
    await flush();
    expect(document.activeElement).toBe(option("done"));
    key(option("done"), "Home");
    await flush();
    expect(document.activeElement).toBe(option("ask"));
  });

  it("opens a row with Enter or a click, never an unavailable one, and searches from the field", async () => {
    const { host, option, onOpen } = setup();
    key(option("done"), "Enter");
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "done" }));
    option("ask").click();
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "ask" }));
    onOpen.mockClear();
    key(option("away"), "Enter");
    option("away").click();
    expect(onOpen).not.toHaveBeenCalled();
    expect(option("away").getAttribute("aria-disabled")).toBe("true");
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search sessions"]')!;
    search.value = "archived";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...host.querySelectorAll<HTMLElement>('[role="option"]')].map((element) => element.dataset.rowId)).toEqual(["old"]);
    key(search, "ArrowDown");
    await flush();
    expect(document.activeElement).toBe(option("old"));
  });

  it("starts a new session from its button", () => {
    const { host, onNew } = setup();
    [...host.querySelectorAll("button")].find((button) => text(button)?.startsWith("New session"))!.click();
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

function fakeAgent(options: { feed?: FeedItem[]; agents?: LiveAgent[]; running?: boolean } = {}) {
  const [feed] = createSignal<FeedItem[]>(options.feed ?? []);
  const stop = vi.fn(async () => undefined);
  const cancelTask = vi.fn(async () => undefined);
  const reviewMany = vi.fn(async () => undefined);
  const openAttachment = vi.fn();
  const agent = {
    feed,
    attachments: () => [],
    liveAgents: () => options.agents ?? [],
    state: () => ({ sessionId: options.agents?.length ? "s1" : undefined }),
    pendingAction: () => undefined,
    healthOn: () => false,
    running: () => Boolean(options.running),
    focusPrompt: vi.fn(),
    stop,
    cancelTask,
    reviewMany,
    openAttachment,
  } as unknown as AgentController;
  return { agent, stop, cancelTask, reviewMany, openAttachment };
}

describe("SidePanel", () => {
  const panel = (agent: AgentController, initial: SideTab = "changes") => {
    const [tab, setTab] = createSignal<SideTab>(initial);
    const host = mount(() => <SidePanel agent={agent} tab={tab()} onTab={setTab} onClose={() => undefined} onOpenFile={() => undefined} onShowTask={() => undefined} />);
    return { host, tab, tabs: () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')] };
  };

  it("follows the tabs pattern: one selected tab in the tab order, arrows move, the panel is labelled by the tab", async () => {
    const { host, tab, tabs } = panel(fakeAgent().agent);
    expect(tabs().map((element) => text(element))).toEqual(["Changes", "Agents", "Files"]);
    expect(tabs().map((element) => element.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs().map((element) => element.tabIndex)).toEqual([0, -1, -1]);
    const tabpanel = host.querySelector('[role="tabpanel"]')!;
    expect(tabpanel.getAttribute("aria-labelledby")).toBe(tabs()[0].id);
    tabs()[0].focus();
    key(tabs()[0], "ArrowRight");
    await flush();
    expect(tab()).toBe("agents");
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1], "ArrowLeft");
    key(tabs()[0], "ArrowLeft");
    expect(tab()).toBe("files");
  });

  it("shows the empty states of each tab", () => {
    const { host, tabs } = panel(fakeAgent().agent);
    expect(text(host.querySelector('[role="tabpanel"]'))).toContain("No changes yet");
    tabs()[1].click();
    expect(text(host.querySelector('[role="tabpanel"]'))).toContain("Agents appear here once the session starts.");
    tabs()[2].click();
    expect(text(host.querySelector('[role="tabpanel"]'))).toContain("No files in this session");
  });

  it("lists the lead and its delegates with Stop and Stop all on the real actions", () => {
    const agents: LiveAgent[] = [
      { key: "lead", id: "claude-acp", name: "Claude Agent", state: "Working", lead: true, detail: "Opus" },
      { key: "codex", id: "codex-acp", name: "Codex", state: "Working", taskId: "task-1", detail: "Editing ci.yml" },
      { key: "gemini", id: "gemini", name: "Gemini CLI", state: "Done", taskId: "task-2" },
    ];
    const fake = fakeAgent({ agents, running: true });
    const { host } = panel(fake.agent, "agents");
    const nodes = [...host.querySelectorAll(".ap-node")];
    expect(nodes.map((node) => text(node.querySelector(".ap-node-name")))).toEqual(["Claude Agent", "Codex", "Gemini CLI"]);
    expect(nodes.map((node) => node.classList.contains("child"))).toEqual([false, true, true]);
    const stopIn = (index: number) => [...nodes[index].querySelectorAll("button")].find((button) => text(button) === "Stop");
    stopIn(1)!.click();
    expect(fake.cancelTask).toHaveBeenCalledWith("task-1");
    expect(stopIn(2)).toBeUndefined();
    [...host.querySelectorAll("button")].find((button) => text(button) === "Stop all")!.click();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("collects the thread's files: sent attachments newest first, each once, then the composer", () => {
    const file = (id: string) => ({ id, kind: "file" as const, name: `${id}.txt`, mime: "text/plain", size: 10, source: "workspace-file" as const, status: "ready" as const });
    const feed = [
      { id: 1, kind: "user", text: "first", attachments: [file("a"), file("b")] },
      { id: 2, kind: "user", text: "second", attachments: [file("b"), file("c")] },
    ] as unknown as FeedItem[];
    expect(sessionFiles(feed, [file("d"), file("a")] as never).map((entry) => `${entry.item.id}:${entry.where}`)).toEqual(["b:sent", "c:sent", "a:sent", "d:composer"]);
  });
});
