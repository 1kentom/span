import { describe, expect, it } from "vitest";
import type { FeedItem } from "./agent-session";
import { buildHandoff } from "./agent-handoff";
import { branchCut, branchDivider, branchReason, changesAfter } from "./agent-rewind";

const proposal = (id: number, proposalId: string, path: string, resolution?: "accepted" | "rejected"): FeedItem =>
  ({ id, kind: "proposal", proposal: { id: proposalId, path, hunks: [], baseRevision: 1 }, ...(resolution ? { resolution } : {}) }) as unknown as FeedItem;
const editTool = (id: number, path: string, status = "completed"): FeedItem =>
  ({ id, kind: "tool", event: { toolCallId: `t${id}`, title: "Edit", toolKind: "edit", status, locations: [{ path }], diffs: [] } }) as unknown as FeedItem;

const feed: FeedItem[] = [
  { id: 1, kind: "user", text: "first ask" },
  { id: 2, kind: "text", text: "first answer" },
  proposal(3, "p1", "/w/src/a.ts", "accepted"),
  { id: 4, kind: "user", text: "second ask" },
  { id: 5, kind: "text", text: "second answer" },
  proposal(6, "p2", "/w/src/b.ts"),
  proposal(7, "p3", "/w/src/c.ts", "accepted"),
  proposal(8, "p4", "/w/src/d.ts", "rejected"),
  editTool(9, "/w/src/e.ts"),
  editTool(10, "/w/src/f.ts", "failed"),
  editTool(11, "/w/src/b.ts"),
  { id: 12, kind: "user", text: "third ask" },
];

describe("where a branch cuts the feed", () => {
  it("keeps everything before the message for edit and resend", () => {
    expect(branchCut(feed, 4, "edit")).toBe(3);
    expect(branchCut(feed, 4, "resend")).toBe(3);
    expect(branchCut(feed, 1, "edit")).toBe(0);
  });

  it("keeps the message and its replies up to the next user message for fork", () => {
    expect(branchCut(feed, 4, "fork")).toBe(11);
    expect(branchCut(feed, 12, "fork")).toBe(12);
  });

  it("refuses an id that is not a user message", () => {
    expect(branchCut(feed, 2, "edit")).toBeUndefined();
    expect(branchCut(feed, 99, "fork")).toBeUndefined();
  });
});

describe("files changed after a message", () => {
  it("lists pending proposals as revertable and applied edits as not, workspace relative", () => {
    expect(changesAfter(feed, 4, "/w")).toEqual([
      { path: "/w/src/b.ts", label: "src/b.ts", pending: ["p2"], applied: false },
      { path: "/w/src/c.ts", label: "src/c.ts", pending: [], applied: true },
      { path: "/w/src/e.ts", label: "src/e.ts", pending: [], applied: true },
    ]);
  });

  it("includes edits from the message's own turn and everything later", () => {
    expect(changesAfter(feed, 1, "/w").map((file) => file.label)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/e.ts"]);
    expect(changesAfter(feed, 12, "/w")).toEqual([]);
  });
});

describe("branch wording", () => {
  it("states that a new session starts and nothing is rewound", () => {
    expect(branchReason("edit")).toContain("ACP cannot rewind a session");
    expect(branchReason("fork")).toContain("ACP cannot rewind a session");
    const divider = branchDivider("fork", true);
    expect(divider.title).toBe("Forked into a new session.");
    expect(divider.note).toContain("Earlier turns go to the agent as context with the next message.");
    expect(divider.note).toContain("The original chat is left as it was.");
    expect(branchDivider("edit", false).note).toContain("No earlier turns to carry.");
  });

  it("puts the branch reason in the carried context header instead of the agent switch one", () => {
    const text = buildHandoff(feed.slice(0, 3), { from: "Codex", reason: branchReason("edit") })!;
    expect(text.startsWith("[Context from an earlier session with Codex. Span started a new session from an earlier message")).toBe(true);
    expect(text).not.toContain("switched agents");
    expect(buildHandoff(feed.slice(0, 3), { from: "Codex" })).toContain("Span carried it over when the user switched agents.");
  });

  it("has no em dashes in any user facing text", () => {
    const all = [branchReason("edit"), branchReason("resend"), branchReason("fork"), ...(["edit", "resend", "fork"] as const).flatMap((mode) => Object.values(branchDivider(mode, true)))];
    expect(all.join(" ")).not.toMatch(/—/);
  });
});
