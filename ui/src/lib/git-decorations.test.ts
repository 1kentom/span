import { describe, expect, it } from "vitest";
import type { GitContext, GitStatus } from "../bindings";
import { gitFolderDecorations, gitLineHunks, gitOriginalLine, gitPathDecorations } from "./git-decorations";

function applyHunks(before: string, after: string) {
  const lines = before ? before.replace(/\r\n?/g, "\n").split("\n") : [];
  const hunks = gitLineHunks(before, after)!;
  for (const hunk of [...hunks].reverse()) lines.splice(hunk.oldStart - 1, hunk.before.length, ...hunk.after);
  return lines.join("\n");
}

describe("live Git line changes", () => {
  it("reports exact inserted, modified and removed line ranges", () => {
    expect(gitLineHunks("a\nb\nc\nd\ne\nf", "a\ninsert\nb\nchanged\nd\nf")).toEqual([
      { oldStart: 2, newStart: 2, before: [], after: ["insert"], kind: "added" },
      { oldStart: 3, newStart: 4, before: ["c"], after: ["changed"], kind: "modified" },
      { oldStart: 5, newStart: 6, before: ["e"], after: [], kind: "deleted" },
    ]);
  });
  it("includes unsaved newlines, deletions at the beginning and end, and empty index baselines", () => {
    expect(gitLineHunks("", "unsaved\nfile")?.[0]).toMatchObject({ oldStart: 1, newStart: 1, kind: "added", after: ["unsaved", "file"] });
    expect(gitLineHunks("first\nsecond", "second")?.[0]).toMatchObject({ newStart: 1, kind: "deleted", before: ["first"] });
    expect(gitLineHunks("first\nsecond", "first")?.[0]).toMatchObject({ newStart: 2, kind: "deleted", before: ["second"] });
    expect(gitLineHunks("a", "a\n")?.[0]).toMatchObject({ newStart: 2, kind: "added", after: [""] });
    expect(gitLineHunks("all\nremoved", "")?.[0]).toMatchObject({ kind: "deleted", before: ["all", "removed"] });
  });
  it("does not report CodeMirror line-ending normalization as a change", () => {
    expect(gitLineHunks("one\r\ntwo\r\n", "one\ntwo\n")).toEqual([]);
    expect(gitLineHunks("", "")).toEqual([]);
  });
  it("reconstructs edits with repeated lines without losing separate unchanged islands", () => {
    let seed = 419;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let sample = 0; sample < 300; sample++) {
      const before = Array.from({ length: random() % 18 }, () => String(random() % 5)).join("\n");
      const after = Array.from({ length: random() % 18 }, () => String(random() % 5)).join("\n");
      expect(applyHunks(before, after)).toBe(after);
    }
  });
  it("maps unchanged blame lines after unsaved insertions and deletions while withholding attribution from replacements", () => {
    const hunks = gitLineHunks("a\nb\nc\nd\ne", "new\na\nchanged\nc\ne")!;
    expect([1, 2, 3, 4, 5].map(line => gitOriginalLine(hunks, line))).toEqual([undefined, 1, undefined, 3, 5]);
  });
  it("bounds pathological diff work instead of manufacturing inaccurate whole-file markers", () => {
    expect(gitLineHunks("x".repeat(2 * 1024 * 1024 + 1), "small")).toBeUndefined();
    expect(gitLineHunks(Array(2000).fill("old").join("\n"), Array(2000).fill("new").join("\n"))).toBeUndefined();
    const unchanged = Array.from({ length: 30_000 }, (_, index) => `line ${index}`);
    const edited = [...unchanged]; edited[15_000] = "one local edit";
    expect(gitLineHunks(unchanged.join("\n"), edited.join("\n"))?.[0]).toMatchObject({ oldStart: 15_001, newStart: 15_001, kind: "modified" });
  });
});

const context: GitContext = { workspaceRoot: "/repo/project", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "project", branch: "main", head: "abc", detached: false, unborn: false }, unavailableReason: null };
const status: GitStatus = { repository: context.repository!, indexRevision: "idx", stagedSnapshot: "tree", truncated: false, operation: null, entries: [
  { id: "1", path: "project/src/new.ts", displayPath: "project/src/new.ts", oldPath: null, displayOldPath: null, indexStatus: "A", worktreeStatus: ".", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
  { id: "2", path: "project/src/conflict.ts", displayPath: "project/src/conflict.ts", oldPath: null, displayOldPath: null, indexStatus: "U", worktreeStatus: "U", untracked: false, conflicted: true, submodule: false, unsupportedReason: null },
  { id: "3", path: "outside.ts", displayPath: "outside.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: ".", untracked: false, conflicted: false, submodule: false, unsupportedReason: null },
] };

describe("workspace Git path decorations", () => {
  it("maps a repository subdirectory, preserves conflict priority and labels unsaved files", () => {
    const files = gitPathDecorations(context, status, ["src/new.ts", "src/draft.ts", "settings://user"]);
    expect([...files.keys()]).toEqual(["src/new.ts", "src/conflict.ts", "src/draft.ts"]);
    expect(files.get("src/new.ts")).toMatchObject({ kind: "added", badge: "A", label: "Added, staged, unsaved changes" });
    expect(files.get("src/draft.ts")).toMatchObject({ kind: "modified", badge: "M", label: "Modified, unsaved changes" });
    expect(gitFolderDecorations(files).get("src")).toMatchObject({ kind: "conflicted", count: 3 });
  });
  it("clears decorations when Git is disabled or an old repository status arrives", () => {
    expect(gitPathDecorations({ ...context, enabled: false }, status, ["draft.ts"]).size).toBe(0);
    expect(gitPathDecorations(context, { ...status, repository: { ...status.repository, id: "old" } }, ["draft.ts"]).size).toBe(0);
  });
});
