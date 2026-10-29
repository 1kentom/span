// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveSession_Serialize as LiveSession } from "../bindings";
import {
  RAIL_WIDTH,
  RECENT_MS,
  SIDE_WIDTH,
  clampWidth,
  currentThreadState,
  groupRail,
  isAgentModeChord,
  railNav,
  railOrder,
  railRows,
  railTime,
  readAgentMode,
  readWidth,
  sidePanelMax,
  writeAgentMode,
  writeStored,
  type RailInput,
  type RailRow,
} from "./agents-page";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const row = (id: string, patch: Partial<RailRow> = {}): RailRow => ({ id, sessionId: id, title: `Session ${id}`, updatedAt: NOW - 60_000, state: "idle", statusText: "Idle", agents: [], ...patch });

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("groupRail", () => {
  it("puts waiting and failed rows under Needs you, running under Working and fresh idle rows under Recent", () => {
    const grouped = groupRail(
      [row("idle"), row("run", { state: "working" }), row("ask", { state: "needs" }), row("broke", { state: "failed", updatedAt: NOW - 10 })],
      { now: NOW },
    );
    expect(grouped.groups.map((group) => [group.label, group.rows.map((entry) => entry.id)])).toEqual([
      ["Needs you", ["broke", "ask"]],
      ["Working", ["run"]],
      ["Recent", ["idle"]],
    ]);
    expect(grouped.settled).toEqual([]);
  });

  it("settles archived and old idle rows, newest first, but keeps the open thread and unknown times recent", () => {
    const grouped = groupRail(
      [row("old", { updatedAt: NOW - RECENT_MS - 1 }), row("older", { updatedAt: NOW - RECENT_MS * 2 }), row("archived", { archived: true }), row("open", { current: true, updatedAt: NOW - RECENT_MS * 3 }), row("unknown", { updatedAt: 0 })],
      { now: NOW },
    );
    expect(grouped.groups.map((group) => group.id)).toEqual(["recent"]);
    expect(grouped.groups[0].rows.map((entry) => entry.id)).toEqual(["open", "unknown"]);
    expect(grouped.settled.map((entry) => entry.id)).toEqual(["archived", "old", "older"]);
  });

  it("filters by title or agent name, case-insensitive, and drops empty groups", () => {
    const rows = [row("a", { title: "Fix the CI cache" }), row("b", { title: "Docs", agents: [{ id: "codex", name: "Codex" }], state: "working" }), row("c", { title: "Other" })];
    expect(groupRail(rows, { now: NOW, query: "ci c" }).groups.flatMap((group) => group.rows.map((entry) => entry.id))).toEqual(["a"]);
    expect(groupRail(rows, { now: NOW, query: "CODEX" }).groups.map((group) => group.id)).toEqual(["working"]);
    expect(groupRail(rows, { now: NOW, query: "nothing" }).groups).toEqual([]);
  });
});

describe("rail keyboard order and movement", () => {
  const ids = ["a", "b", "c"];
  it("moves one row with the arrows and stops at the ends", () => {
    expect(railNav(ids, "a", "ArrowDown")).toBe("b");
    expect(railNav(ids, "c", "ArrowDown")).toBe("c");
    expect(railNav(ids, "a", "ArrowUp")).toBe("a");
    expect(railNav(ids, "b", "ArrowUp")).toBe("a");
  });
  it("jumps with Home and End, starts from the ends without a current row, and ignores other keys", () => {
    expect(railNav(ids, "b", "Home")).toBe("a");
    expect(railNav(ids, "b", "End")).toBe("c");
    expect(railNav(ids, undefined, "ArrowDown")).toBe("a");
    expect(railNav(ids, undefined, "ArrowUp")).toBe("c");
    expect(railNav(ids, "b", "Enter")).toBeUndefined();
    expect(railNav([], undefined, "ArrowDown")).toBeUndefined();
  });
  it("orders rows as shown, with Settled last only when open", () => {
    const grouped = groupRail([row("recent"), row("run", { state: "working" }), row("old", { archived: true })], { now: NOW });
    expect(railOrder(grouped, false)).toEqual(["run", "recent"]);
    expect(railOrder(grouped, true)).toEqual(["run", "recent", "old"]);
  });
});

describe("widths", () => {
  it("clamps to the bounds and rounds", () => {
    expect(clampWidth(100, RAIL_WIDTH.min, RAIL_WIDTH.max)).toBe(200);
    expect(clampWidth(999, RAIL_WIDTH.min, RAIL_WIDTH.max)).toBe(420);
    expect(clampWidth(300.6, RAIL_WIDTH.min, RAIL_WIDTH.max)).toBe(301);
    expect(clampWidth(Number.NaN, 320, 720)).toBe(320);
    // A maximum below the minimum (a narrow window) still yields the minimum.
    expect(clampWidth(500, 320, 200)).toBe(320);
  });
  it("keeps the thread at least 560px wide before the side panel gives way", () => {
    expect(sidePanelMax(2560, 268)).toBe(SIDE_WIDTH.max);
    expect(sidePanelMax(1440, 268)).toBe(1440 - 268 - 560 - 32);
    expect(sidePanelMax(1000, 268)).toBe(SIDE_WIDTH.min);
  });
  it("reads a stored width clamped, and the default when nothing valid is stored", () => {
    expect(readWidth("railWidth", RAIL_WIDTH)).toBe(268);
    writeStored("railWidth", "9000");
    expect(readWidth("railWidth", RAIL_WIDTH)).toBe(420);
    writeStored("railWidth", "abc");
    expect(readWidth("railWidth", RAIL_WIDTH)).toBe(268);
  });
});

describe("mode per workspace", () => {
  it("remembers Agents per folder and defaults to Editor", () => {
    expect(readAgentMode("/work/one")).toBe("editor");
    writeAgentMode("/work/one", "agents");
    expect(readAgentMode("/work/one")).toBe("agents");
    expect(readAgentMode("/work/two")).toBe("editor");
    expect(readAgentMode(undefined)).toBe("editor");
  });
  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeAgentMode("/work/one", "agents")).not.toThrow();
    expect(readAgentMode("/work/one")).toBe("editor");
  });
});

describe("isAgentModeChord", () => {
  const event = (patch: Partial<KeyboardEvent>) => ({ key: "A", code: "KeyA", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, repeat: false, isComposing: false, defaultPrevented: false, ...patch }) as KeyboardEvent;
  it("is Cmd+Shift+A on macOS and Ctrl+Shift+A elsewhere", () => {
    expect(isAgentModeChord(event({ metaKey: true }), "mac")).toBe(true);
    expect(isAgentModeChord(event({ ctrlKey: true }), "mac")).toBe(false);
    expect(isAgentModeChord(event({ ctrlKey: true }), "windows")).toBe(true);
    expect(isAgentModeChord(event({ ctrlKey: true }), "linux")).toBe(true);
    expect(isAgentModeChord(event({ metaKey: true }), "linux")).toBe(false);
  });
  it("needs Shift, refuses Alt, repeats and handled events", () => {
    expect(isAgentModeChord(event({ metaKey: true, shiftKey: false }), "mac")).toBe(false);
    expect(isAgentModeChord(event({ metaKey: true, altKey: true }), "mac")).toBe(false);
    expect(isAgentModeChord(event({ metaKey: true, repeat: true }), "mac")).toBe(false);
    expect(isAgentModeChord(event({ metaKey: true, defaultPrevented: true }), "mac")).toBe(false);
    expect(isAgentModeChord(event({ metaKey: true, key: "B", code: "KeyB" }), "mac")).toBe(false);
  });
});

describe("railRows", () => {
  const live = (patch: Partial<LiveSession>): LiveSession => ({ key: { connectionId: "c1", sessionId: "s" }, agentName: "Codex", agentId: "codex-acp", parent: null, depth: 0, origin: "user", state: "idle", queued: 0, startedAtMs: null, currentTool: null, title: null, model: null, mode: null, health: null, ...patch });
  const base = (patch: Partial<RailInput> = {}): RailInput => ({
    listed: [],
    metas: [],
    agentId: "codex-acp",
    threadFor: () => ({ segments: [], links: [] }),
    statusOf: () => undefined,
    brand: { id: "codex-acp", name: "Codex" },
    current: { state: "idle", statusText: "Idle", agents: [] },
    live: [],
    focusedConnection: "c1",
    workspace: "/work",
    canLoad: true,
    now: NOW,
    ...patch,
  });

  it("lists the agent's sessions with their backend state and the connected agent as the known agent", () => {
    const rows = railRows(base({
      listed: [{ sessionId: "s1", title: "Earlier work", updatedAt: new Date(NOW - 3_600_000).toISOString(), cwd: "/work" }],
      statusOf: (id) => (id === "s1" ? { kind: "approval", label: "Waiting for your approval", attention: true } : undefined),
    }));
    expect(rows).toEqual([expect.objectContaining({ id: "s1", title: "Earlier work", state: "needs", statusText: "Waiting for your approval", agents: [{ id: "codex-acp", name: "Codex" }], updatedAt: NOW - 3_600_000 })]);
    expect(rows[0].unavailable).toBeUndefined();
  });

  it("adds the open thread before the agent lists it, with the controller's own state", () => {
    const rows = railRows(base({ current: { sessionId: "fresh", title: "", state: "working", statusText: "Working", agents: [{ id: "codex-acp", name: "Codex" }] } }));
    expect(rows).toEqual([expect.objectContaining({ id: "fresh", title: "New session", state: "working", current: true, updatedAt: NOW })]);
  });

  it("marks rows from another folder, and rows an agent without load cannot reopen", () => {
    const rows = railRows(base({ canLoad: false, listed: [{ sessionId: "away", title: "Elsewhere", updatedAt: null, cwd: "/other" }, { sessionId: "here", title: "Here", updatedAt: null, cwd: "/work" }] }));
    expect(rows.find((entry) => entry.id === "away")?.unavailable).toMatch(/another folder/);
    expect(rows.find((entry) => entry.id === "here")?.unavailable).toMatch(/cannot reopen/);
  });

  it("adds live user leads of other connections as rows that cannot be focused here, and skips delegated children", () => {
    const rows = railRows(base({
      live: [
        live({ key: { connectionId: "c2", sessionId: "s9" }, title: "Other agent work", state: "running", currentTool: "Edit ci.yml" }),
        live({ key: { connectionId: "c2", sessionId: "child" }, origin: "delegated", parent: { connectionId: "c2", sessionId: "s9" }, depth: 1 }),
      ],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ id: "c2/s9", state: "working", statusText: "Working · Edit ci.yml", title: "Other agent work" }));
    expect(rows[0].unavailable).toMatch(/another agent connection/);
  });

  it("does not repeat a live session the agent already listed", () => {
    const rows = railRows(base({ listed: [{ sessionId: "s", title: "Listed", updatedAt: null, cwd: null }], live: [live({ state: "waitingForAnswer" })] }));
    expect(rows.map((entry) => entry.id)).toEqual(["s"]);
  });
});

describe("currentThreadState and railTime", () => {
  it("ranks waiting over failure over running", () => {
    expect(currentThreadState({ running: true, waiting: "approval", failed: true, connected: true, queued: 2 })).toEqual({ state: "needs", statusText: "Waiting for your approval · 2 queued" });
    expect(currentThreadState({ running: true, waiting: undefined, failed: true, connected: true, queued: 0 }).state).toBe("failed");
    expect(currentThreadState({ running: true, waiting: undefined, failed: false, stopping: true, connected: true, queued: 0 })).toEqual({ state: "working", statusText: "Stopping" });
    expect(currentThreadState({ running: false, waiting: undefined, failed: false, connected: false, queued: 0 }).statusText).toBe("Not connected");
  });
  it("shortens times", () => {
    expect(railTime(0, NOW)).toBe("");
    expect(railTime(NOW - 10_000, NOW)).toBe("now");
    expect(railTime(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(railTime(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(railTime(NOW - 2 * 86_400_000, NOW)).toBe("2d");
  });
});
