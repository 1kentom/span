import { describe, expect, it } from "vitest";
import type { SessionMeta_Serialize as SessionMeta } from "../bindings";
import { exportTranscript, hasUntrackedEdits, hunkLineDelta, listedTitle, sameFolder, threadOf, threadRowMeta, visibleThreadRows } from "./session-threads";
import type { FeedItem } from "./agent-session";

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({
  agentId: "codex",
  connectionName: "Codex",
  sessionId: "s1",
  titleOverride: null,
  archived: false,
  firstSeenMs: 1,
  lastActiveMs: 2,
  models: [],
  agents: [],
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  stopReasonLast: null,
  parent: null,
  ...patch,
});

const first = meta({ models: [{ name: "gpt-5.1-codex", effort: "high", usedMs: 1, turns: 2 }], filesChanged: 2, linesAdded: 10, linesRemoved: 1, changesTracked: true });
const second = meta({
  agentId: "claude-acp",
  connectionName: "Claude Agent",
  sessionId: "s2",
  lastActiveMs: 5,
  continues: { agentId: "codex", sessionId: "s1", title: "Ship path filtering" },
  models: [
    { name: "Opus 4.5", effort: null, usedMs: 5, turns: 1 },
    { name: "Sonnet 4.5", effort: null, usedMs: 5, turns: 0, subagent: true },
  ],
  filesChanged: 1,
  linesAdded: 3,
  linesRemoved: 0,
  changesTracked: true,
});

describe("threadOf", () => {
  it("follows the switch link back and forward from either segment", () => {
    expect(threadOf([second, first], "claude-acp", "s2").segments.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(threadOf([second, first], "codex", "s1").segments.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });
  it("finds a segment listed under another catalog id of the same agent by its session id", () => {
    expect(threadOf([second, first], "claude-code-preset", "s1").segments.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });
  it("stops on a loop and returns just the session without links", () => {
    const a = meta({ sessionId: "a", continues: { agentId: "codex", sessionId: "b", title: null } });
    const b = meta({ sessionId: "b", continues: { agentId: "codex", sessionId: "a", title: null } });
    expect(threadOf([a, b], "codex", "a").segments.length).toBe(2);
    expect(threadOf([first], "codex", "zzz").segments).toEqual([]);
  });
});

describe("threadRowMeta", () => {
  it("shows every provider and model of the thread with the title from the switch", () => {
    const row = threadRowMeta(threadOf([first, second], "claude-acp", "s2"));
    expect(row.agents).toEqual([
      { id: "codex", name: "Codex" },
      { id: "claude-acp", name: "Claude Agent" },
    ]);
    expect(row.models).toEqual(["gpt-5.1-codex · high", "Opus 4.5", "Sonnet 4.5 · subagent"]);
    expect(row.title).toBe("Ship path filtering");
    expect(row.files).toBe(3);
    expect(row.delta).toEqual({ add: 13, del: 1 });
    expect(row.noChanges).toBeUndefined();
  });
  it("prefers the newest user title in the thread", () => {
    const renamed = { ...first, titleOverride: "Old name" };
    const newer = { ...second, titleOverride: "New name" };
    expect(threadRowMeta(threadOf([renamed, newer], "codex", "s1")).title).toBe("New name");
    expect(threadRowMeta(threadOf([renamed, second], "codex", "s1")).title).toBe("Old name");
  });
  it("says no changes only when every segment was tracked and nothing changed", () => {
    const quiet = meta({ changesTracked: true });
    expect(threadRowMeta(threadOf([quiet], "codex", "s1")).noChanges).toBe(true);
    expect(threadRowMeta(threadOf([meta()], "codex", "s1")).noChanges).toBeUndefined();
  });
  it("reads archived from the newest segment", () => {
    expect(threadRowMeta(threadOf([{ ...first, archived: true }, second], "codex", "s1")).archived).toBe(false);
    expect(threadRowMeta(threadOf([first, { ...second, archived: true }], "codex", "s1")).archived).toBe(true);
  });
});

describe("visibleThreadRows", () => {
  it("hides an earlier segment when its continuation is listed too", () => {
    expect(visibleThreadRows(["s1", "s2", "other"], [first, second], "claude-acp")).toEqual(["s2", "other"]);
    expect(visibleThreadRows(["s1", "other"], [first, second], "codex")).toEqual(["s1", "other"]);
  });
});

describe("listedTitle", () => {
  it("drops the carried context header an agent used as its title", () => {
    expect(listedTitle("[Context from an earlier session with Codex. Span carried it")).toBeUndefined();
    expect(listedTitle("  Fix parser ")).toBe("Fix parser");
    expect(listedTitle(null)).toBeUndefined();
  });
});

describe("sameFolder", () => {
  it("compares folders ignoring a trailing separator and Windows case", () => {
    expect(sameFolder("/w/project/", "/w/project")).toBe(true);
    expect(sameFolder("C:\\Work\\P", "c:/work/p")).toBe(true);
    expect(sameFolder("/w/a", "/w/b")).toBe(false);
    expect(sameFolder(null, "/w")).toBe(true);
  });
});

describe("hunkLineDelta", () => {
  it("counts changed lines like a line diff", () => {
    expect(hunkLineDelta("1\n2\n", "1\n3\n4\n")).toEqual({ add: 2, del: 1 });
    expect(hunkLineDelta("", "a\nb\n")).toEqual({ add: 2, del: 0 });
    expect(hunkLineDelta("a\nb\nc\n", "a\nc\n")).toEqual({ add: 0, del: 1 });
    expect(hunkLineDelta("same\n", "same\n")).toEqual({ add: 0, del: 0 });
  });
});

describe("hasUntrackedEdits", () => {
  const tool = (id: number, path: string, status = "completed"): FeedItem =>
    ({ id, kind: "tool", event: { sessionId: "s", toolCallId: `t${id}`, toolKind: "edit", status, locations: [{ path }] } }) as unknown as FeedItem;
  const proposal = (id: number, path: string): FeedItem => ({ id, kind: "proposal", proposal: { id: `p${id}`, path, baseRevision: 0, hunks: [] }, resolution: "accepted" });
  it("is false when every edit went through a proposal", () => {
    expect(hasUntrackedEdits([proposal(1, "/w/a.rs"), tool(2, "/w/a.rs")])).toBe(false);
    expect(hasUntrackedEdits([])).toBe(false);
  });
  it("is true for an edit the agent wrote directly", () => {
    expect(hasUntrackedEdits([tool(1, "/w/b.rs")])).toBe(true);
    expect(hasUntrackedEdits([tool(1, "/w/b.rs", "failed")])).toBe(false);
  });
});

describe("exportTranscript", () => {
  it("maps the feed to transcript records", () => {
    const feed: FeedItem[] = [
      { id: 1, kind: "user", text: "Fix it", context: "[Context]" },
      { id: 2, kind: "thought", text: "thinking" },
      { id: 3, kind: "text", text: "Done" },
      { id: 4, kind: "handoff", from: "Codex", to: "Claude Agent", carried: true },
      { id: 5, kind: "proposal", proposal: { id: "p", path: "/w/a.rs", baseRevision: 0, hunks: [{ id: "h", from: 0, to: 1, before: "a\n", after: "b\n" }] }, resolution: "accepted" },
      { id: 6, kind: "proposal", proposal: { id: "q", path: "/w/b.rs", baseRevision: 0, hunks: [] }, resolution: "rejected" },
      { id: 7, kind: "stop", reason: "end_turn" },
    ];
    expect(exportTranscript("Chat", feed)).toEqual({
      title: "Chat",
      items: [
        { kind: "user", text: "Fix it" },
        { kind: "thought", text: "thinking" },
        { kind: "agent", text: "Done" },
        { kind: "notice", text: "Switched from Codex to Claude Agent." },
        { kind: "diff", path: "/w/a.rs", oldText: "a\n", newText: "b\n" },
      ],
    });
  });
});
