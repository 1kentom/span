// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../bindings";
import { HistoryList } from "./HistoryList";
import { mount, text } from "./test-utils";
import { activityLabel, clockText, outputPreview, runningTool, stillRunningText, STILL_RUNNING_AFTER_MS } from "../../lib/agent-running";
import type { FeedItem } from "../../lib/agent-session";

type Tool = Extract<AgentEvent, { kind: "tool" }>;
const tool = (patch: Partial<Tool>): Tool => ({ kind: "tool", sessionId: "s1", toolCallId: "t1", title: "mvn test", status: "in_progress", toolKind: "execute", parentToolCallId: null, contentJson: "{}", ...patch });

describe("history rows show the backend state", () => {
  const rows = [
    { id: "a", title: "Refactor cells", updatedAt: Date.now(), inWorkspace: true, current: true, status: { kind: "idle" as const, label: "Idle", attention: false } },
    { id: "b", title: "Run the build", updatedAt: Date.now(), inWorkspace: true, status: { kind: "running" as const, label: "Running 0:42", attention: false } },
    { id: "c", title: "Fix styles", updatedAt: Date.now(), inWorkspace: true, status: { kind: "approval" as const, label: "Waiting for your approval", attention: true } },
    { id: "d", title: "From the agent store", updatedAt: Date.now(), inWorkspace: true },
  ];

  it("labels running and waiting rows, marks attention, and shows nothing for unknown state", () => {
    const host = mount(() => <HistoryList rows={rows} query="" onQuery={() => undefined} onOpen={vi.fn()} />);
    const row = (title: string) => [...host.querySelectorAll(".sb-session")].find((element) => element.textContent?.includes(title))!;
    expect(text(row("Run the build").querySelector(".sb-session-state"))).toBe("Running 0:42");
    expect(row("Run the build").classList.contains("live")).toBe(true);
    expect(row("Fix styles").querySelector(".sb-session-state")?.classList.contains("attention")).toBe(true);
    expect(row("Fix styles").querySelector("button.sb-session-main")?.getAttribute("aria-label")).toBe("Fix styles, Waiting for your approval");
    expect(row("Refactor cells").querySelector(".sb-tag")?.textContent).toBe("Current");
    expect(row("From the agent store").querySelector(".sb-session-state")).toBeNull();
    expect(row("From the agent store").classList.contains("live")).toBe(false);
  });
});

describe("activity bar text", () => {
  it("names what runs and distinguishes every phase", () => {
    expect(activityLabel({ tool: tool({}) })).toBe("Running command: mvn test");
    expect(activityLabel({ tool: tool({ toolKind: "read", title: "Read view.fxml" }) })).toBe("Running: Read view.fxml");
    expect(activityLabel({})).toBe("Thinking");
    expect(activityLabel({ tool: tool({}), approval: true })).toBe("Waiting for your approval");
    expect(activityLabel({ tool: tool({}), answer: true })).toBe("Waiting for your answer");
    expect(activityLabel({ tool: tool({}), stopping: true })).toBe("Stopping");
  });

  it("formats the clock as m:ss and h:mm:ss", () => {
    expect(clockText(42_000)).toBe("0:42");
    expect(clockText(12 * 60_000 + 5_000)).toBe("12:05");
    expect(clockText(3_723_000)).toBe("1:02:03");
  });

  it("finds the running step: the newest unfinished tool that is not housekeeping", () => {
    const feed: FeedItem[] = [
      { id: 1, kind: "tool", event: tool({ toolCallId: "a", status: "completed" }) },
      { id: 2, kind: "tool", event: tool({ toolCallId: "b", title: "gradle build" }) },
      { id: 3, kind: "tool", event: tool({ toolCallId: "c", internal: true }) },
    ];
    expect(runningTool(feed)?.toolCallId).toBe("b");
    expect(runningTool(feed.slice(0, 1))).toBeUndefined();
  });

  it("previews the output tail and counts the hidden lines", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const preview = outputPreview(tool({ rawInput: { command: "mvn test" }, rawOutput: output }), 12);
    expect(preview.lines).toHaveLength(12);
    expect(preview.lines[11]).toBe("line 30");
    expect(preview.hidden).toBe(18);
  });

  it("says still running only after 30 s without new output", () => {
    expect(stillRunningText(STILL_RUNNING_AFTER_MS - 1)).toBeUndefined();
    expect(stillRunningText(42_000)).toBe("Still running, no new output for 42s");
  });
});
