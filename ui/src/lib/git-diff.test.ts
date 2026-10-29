import { expect, it } from "vitest";
import { gitDiffLinesCapped, gitNewFileRows, gitPatchRows, MAX_GIT_DIFF_LINES } from "./git-diff";
it("numbers separate index/file sides and resets across files, including no-newline markers", () => {
  expect(gitPatchRows("")).toEqual([]);
  const rows = gitPatchRows("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -8,2 +9,2 @@\n before\n-removed\n+added\n\\ No newline at end of file\ndiff --git a/b b/b\n@@ -0,0 +1 @@\n+new");
  expect(rows[4]).toEqual({ text: " before", kind: "context", oldLine: 8, newLine: 9 });
  expect(rows[5]).toEqual({ text: "-removed", kind: "removed", oldLine: 9 });
  expect(rows[6]).toEqual({ text: "+added", kind: "added", newLine: 10 });
  expect(rows[7].oldLine).toBeUndefined(); expect(rows.at(-1)?.newLine).toBe(1);
});

it("bounds row allocation for newline-heavy text and reports whether content was omitted", () => {
  const text = "line\n".repeat(MAX_GIT_DIFF_LINES + 5);
  expect(gitNewFileRows(text)).toHaveLength(MAX_GIT_DIFF_LINES);
  expect(gitPatchRows(text)).toHaveLength(MAX_GIT_DIFF_LINES);
  expect(gitDiffLinesCapped(text)).toBe(true);
  expect(gitNewFileRows("\n".repeat(MAX_GIT_DIFF_LINES))).toHaveLength(MAX_GIT_DIFF_LINES);
  expect(gitDiffLinesCapped("line\n".repeat(MAX_GIT_DIFF_LINES))).toBe(false);
});
