import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../bindings";
import type { FeedItem } from "./agent-session";
import { FAILED_SETTLE_MS, SETTLE_MS, failureReason, friendlyToolTitle, humanizeName, lastFinishedTool, runningTools, toolBarView, toolSummary, type ToolBarInput } from "./agent-tool-bar";

type Tool = Extract<AgentEvent, { kind: "tool" }>;
const tool = (patch: Partial<Tool>): Tool => ({ kind: "tool", sessionId: "s1", toolCallId: "t1", title: "execute", status: "in_progress", toolKind: "execute", parentToolCallId: null, contentJson: "{}", ...patch }) as Tool;
const shell = (command: string, patch: Partial<Tool> = {}) => tool({ contentJson: JSON.stringify({ rawInput: { command } }), ...patch });
const item = (event: Tool) => ({ kind: "tool", id: event.toolCallId, event }) as unknown as FeedItem;

describe("friendly tool titles", () => {
  it("maps every ACP kind to a word", () => {
    const kinds: Record<string, string> = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Execute", think: "Think", fetch: "Fetch", switch_mode: "Switch mode" };
    for (const [toolKind, label] of Object.entries(kinds)) expect(friendlyToolTitle({ toolKind, title: "whatever" })).toBe(label);
  });
  it("humanizes a bare tool name for an unknown kind and falls back to Tool", () => {
    expect(friendlyToolTitle({ toolKind: "other", title: "web_search" })).toBe("Web search");
    expect(friendlyToolTitle({ toolKind: null, title: "WebFetch" })).toBe("Web fetch");
    expect(friendlyToolTitle({ toolKind: "other", title: "Look up the docs for ropey" })).toBe("Tool");
    expect(friendlyToolTitle({ toolKind: null, title: null })).toBe("Tool");
    expect(humanizeName("read-file")).toBe("Read file");
  });
});

describe("tool summary", () => {
  it("prefers the shell command, squashed to one line", () => {
    expect(toolSummary(shell("pnpm   test\n  --run"))).toBe("pnpm test --run");
    expect(toolSummary(tool({ contentJson: JSON.stringify({ rawInput: { command: ["cargo", "build"] } }) }))).toBe("cargo build");
  });
  it("uses the file path, then a title that says more than the label", () => {
    expect(toolSummary(tool({ toolKind: "read", title: "Read", locations: [{ path: "ui/src/app.tsx", line: null }] } as Partial<Tool>))).toBe("ui/src/app.tsx");
    expect(toolSummary(tool({ toolKind: "search", title: "grep TODO" }))).toBe("grep TODO");
  });
  it("drops a title that only repeats the tool name", () => {
    expect(toolSummary(tool({ title: "execute" }))).toBeUndefined();
    expect(toolSummary(tool({ toolKind: "read", title: "read" }))).toBeUndefined();
    expect(toolSummary(tool({ toolKind: "other", title: "web_search" }))).toBeUndefined();
  });
  it("caps very long text so nothing overflows", () => {
    expect(toolSummary(shell("x".repeat(2000)))!.length).toBeLessThanOrEqual(400);
  });
});

describe("failure reason", () => {
  it("reads the error or stderr, else the first text line, else a generic line", () => {
    expect(failureReason(tool({ status: "failed", contentJson: JSON.stringify({ rawOutput: { error: "permission denied\nmore" } }) }))).toBe("permission denied");
    expect(failureReason(tool({ status: "failed", contentJson: JSON.stringify({ rawOutput: { stderr: "\n  exit 2 " } }) }))).toBe("exit 2");
    expect(failureReason(tool({ status: "failed", contentJson: JSON.stringify({ content: [{ type: "content", content: { type: "text", text: "\nnot found" } }] }) }))).toBe("not found");
    expect(failureReason(tool({ status: "failed" }))).toBe("The tool call failed");
  });
});

describe("feed scans", () => {
  it("lists every unfinished visible tool and finds the newest finished one", () => {
    const feed = [item(tool({ toolCallId: "a", status: "completed" })), item(tool({ toolCallId: "b" })), item(tool({ toolCallId: "c", internal: true } as Partial<Tool>)), item(tool({ toolCallId: "d", status: "pending" })), item(tool({ toolCallId: "e", status: "failed" }))];
    expect(runningTools(feed).map((event) => event.toolCallId)).toEqual(["b", "d"]);
    expect(lastFinishedTool(feed)?.toolCallId).toBe("e");
  });
});

describe("toolBarView", () => {
  const T0 = 1_000_000;
  const base = (patch: Partial<ToolBarInput>): ToolBarInput => ({ running: [], timesOf: () => undefined, now: T0 + 23_000, turnStart: T0, ...patch });

  it("shows one timer: the tool's own, from the same clock as the turn, with the turn only in the tooltip", () => {
    const view = toolBarView(base({ running: [shell("pnpm test")], timesOf: () => ({ start: T0 + 15_000, last: T0 + 20_000 }) }));
    expect(view).toMatchObject({ tone: "running", label: "Execute", summary: "pnpm test", command: true, elapsed: "0:08", turn: "0:23", stoppable: true, more: [] });
    expect(view.announce).toBe("Running command: pnpm test");
    expect(view.announce).not.toMatch(/\d:\d\d/);
  });

  it("drops the turn time when it equals the tool time", () => {
    expect(toolBarView(base({ running: [shell("ls")], timesOf: () => ({ start: T0, last: T0 }) })).turn).toBeUndefined();
  });

  it("shows the newest of several running tools with a +N more list", () => {
    const view = toolBarView(base({ running: [tool({ toolCallId: "a", toolKind: "read", title: "Read", locations: [{ path: "a.ts", line: null }] } as Partial<Tool>), shell("pnpm lint", { toolCallId: "b" }), shell("pnpm test", { toolCallId: "c" })] }));
    expect(view.summary).toBe("pnpm test");
    expect(view.more).toEqual(["Execute pnpm lint", "Read a.ts"]);
    expect(view.toolCallId).toBe("c");
  });

  it("is thinking with the turn timer when nothing runs", () => {
    expect(toolBarView(base({}))).toMatchObject({ tone: "thinking", label: "Thinking", elapsed: "0:23", turn: undefined, stoppable: true });
  });

  it("settles a completed tool briefly with its final time, then returns to thinking", () => {
    const done = shell("pnpm test", { status: "completed" });
    const timesOf = () => ({ start: T0 + 10_000, last: T0 + 22_000 });
    expect(toolBarView(base({ finished: done, timesOf, now: T0 + 22_000 + SETTLE_MS }))).toMatchObject({ tone: "done", label: "Execute", elapsed: "0:12" });
    expect(toolBarView(base({ finished: done, timesOf, now: T0 + 22_000 + SETTLE_MS + 1 })).tone).toBe("thinking");
  });

  it("holds a failed tool longer in the danger tone with a short reason", () => {
    const failed = shell("pnpm test", { status: "failed", contentJson: JSON.stringify({ rawInput: { command: "pnpm test" }, rawOutput: { stderr: "1 test failed" } }) });
    const view = toolBarView(base({ finished: failed, timesOf: () => ({ start: T0, last: T0 + 2_000 }), now: T0 + 2_000 + FAILED_SETTLE_MS }));
    expect(view).toMatchObject({ tone: "failed", reason: "1 test failed", summary: "pnpm test" });
    expect(view.announce).toBe("Execute: pnpm test failed: 1 test failed");
  });

  it("never settles a tool that finished before this turn", () => {
    expect(toolBarView(base({ finished: shell("ls", { status: "completed" }), timesOf: () => ({ start: T0 - 5_000, last: T0 - 1 }), now: T0 + 100 })).tone).toBe("thinking");
  });

  it("puts waiting and stopping first and hides the Esc hint for them", () => {
    const running = [shell("pnpm publish")];
    expect(toolBarView(base({ running, approval: true }))).toMatchObject({ tone: "attention", label: "Waiting for your approval", summary: "Execute: pnpm publish", stoppable: false });
    expect(toolBarView(base({ running, answer: true }))).toMatchObject({ tone: "attention", label: "Waiting for your answer", stoppable: false });
    expect(toolBarView(base({ running, browser: true }))).toMatchObject({ tone: "attention", label: "Waiting for you to finish in the browser", stoppable: false });
    expect(toolBarView(base({ running, stopping: true, approval: true }))).toMatchObject({ tone: "stopping", label: "Stopping\u2026", stoppable: false, announce: "Stopping" });
  });
});
