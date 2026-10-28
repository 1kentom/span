import { describe, expect, it } from "vitest";
import type { FeedItem } from "./agent-session";
import { buildHandoff, carryFeed, feedChangedFiles, feedTurns, handoffDivider, HANDOFF_MESSAGE_LIMIT, withHandoff } from "./agent-handoff";

let id = 0;
const user = (text: string): FeedItem => ({ id: ++id, kind: "user", text });
const reply = (text: string): FeedItem => ({ id: ++id, kind: "text", text });
const thought = (text: string): FeedItem => ({ id: ++id, kind: "thought", text });
const proposal = (path: string, resolution?: "accepted" | "rejected"): FeedItem => ({ id: ++id, kind: "proposal", proposal: { id: `p-${path}`, path, hunks: [] } as never, resolution });
const tool = (toolKind: string, status: string, path: string): FeedItem => ({ id: ++id, kind: "tool", event: { kind: "tool", sessionId: "s", toolCallId: `t${id}`, toolKind, status, contentJson: "{}", locations: [{ path }] } as never });

describe("feedTurns", () => {
  it("keeps user and assistant messages in order, merges streamed assistant blocks and skips thoughts", () => {
    expect(feedTurns([user("hi"), thought("hmm"), reply("Hel"), reply("lo"), { id: 99, kind: "note", text: "Stopped" }, user("  "), user("next")])).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello" },
      { role: "user", text: "next" },
    ]);
  });
});

describe("feedChangedFiles", () => {
  it("lists edited files once, relative to the workspace, without rejected proposals or failed edits", () => {
    const feed = [proposal("/w/src/a.ts", "accepted"), proposal("/w/src/b.ts", "rejected"), proposal("/w/src/c.ts"), tool("edit", "completed", "/w/src/a.ts"), tool("edit", "failed", "/w/src/d.ts"), tool("read", "completed", "/w/src/e.ts"), tool("delete", "completed", "/elsewhere/f.ts")];
    expect(feedChangedFiles(feed, "/w")).toEqual(["src/a.ts", "src/c.ts", "/elsewhere/f.ts"]);
  });
});

describe("buildHandoff", () => {
  it("returns nothing when there is nothing to carry", () => {
    expect(buildHandoff([], { from: "Codex" })).toBeUndefined();
    expect(buildHandoff([thought("only thinking")], { from: "Codex" })).toBeUndefined();
  });
  it("keeps the last 6 messages by default, newest last, and lists the changed files", () => {
    const feed = Array.from({ length: 5 }, (_, index) => [user(`ask ${index}`), reply(`answer ${index}`)]).flat();
    const block = buildHandoff([...feed, proposal("/w/src/a.ts")], { from: "Codex", root: "/w" })!;
    expect(block).toContain("earlier session with Codex");
    expect(block).toContain("Recent messages (last 6):");
    expect(block).not.toContain("ask 1");
    expect(block).toContain("User: ask 2");
    expect(block.indexOf("Agent: answer 4")).toBeGreaterThan(block.indexOf("User: ask 4"));
    expect(block).toContain("Files changed:\n- src/a.ts");
    expect(block).toContain("memory and permissions");
    expect(block.endsWith("[End of carried context]")).toBe(true);
  });
  it("honours a custom turn count and cuts long messages", () => {
    const block = buildHandoff([user("first"), reply("x".repeat(HANDOFF_MESSAGE_LIMIT + 50))], { from: "Gemini", turns: 1 })!;
    expect(block).not.toContain("first");
    expect(block).toContain("[cut]");
    expect(block.length).toBeLessThan(HANDOFF_MESSAGE_LIMIT + 400);
  });
  it("puts the block ahead of the user's message", () => {
    expect(withHandoff("CTX", "do it")).toBe("CTX\n\ndo it");
  });
});

describe("handoffDivider and carryFeed", () => {
  it("names both agents, the carried mode and the limits", () => {
    const view = handoffDivider("Codex", "Claude Agent", true);
    expect(view.title).toBe("Switched from Codex to Claude Agent.");
    expect(view.text).toContain("Context carried over: recent turns.");
    expect(view.note).toContain("Tool state, agent memory and permissions do not carry over");
    expect(handoffDivider("A", "B", false).note).toContain("Context carried over: none.");
  });
  it("closes permission requests the old session can no longer take", () => {
    const open = { id: 1, kind: "permission", event: {} as never, resolved: false } as FeedItem;
    expect(carryFeed([open, user("a")])).toEqual([{ ...open, resolved: true }, expect.objectContaining({ kind: "user" })]);
  });
});
