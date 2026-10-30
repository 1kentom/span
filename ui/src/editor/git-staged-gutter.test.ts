import { expect, it } from "vitest";
import { stagedLineKinds } from "./git-staged-gutter";
it("keeps staged and working lines separate and maps staged changes after unsaved insertions", () => {
  expect([...stagedLineKinds("one\ntwo\nthree", "one\nstaged\nthree", "insert\none\nstaged\nworking")]).toEqual([[3, "modified"]]);
  expect([...stagedLineKinds("one\ntwo", "one\nstaged", "one\noverwritten")]).toEqual([]);
});
it("withholds staged markers when the exact diff exceeds its budget", () => {
  expect(stagedLineKinds("x".repeat(2 * 1024 * 1024 + 1), "x", "x").size).toBe(0);
});
it("maps deletion boundaries at BOF, EOF, and an empty index without inventing line authorship", () => {
  expect([...stagedLineKinds("removed\nkeep", "keep", "insert\nkeep")]).toEqual([[2, "deleted"]]);
  expect([...stagedLineKinds("keep\nremoved", "keep", "insert\nkeep")]).toEqual([[2, "deleted"]]);
  expect([...stagedLineKinds("removed", "", "")]).toEqual([[1, "deleted"]]);
  expect([...stagedLineKinds("removed", "", "new")]).toEqual([]);
  expect([...stagedLineKinds("removed\nkeep", "keep", "replacement")]).toEqual([]);
});
it("withholds overwritten portions while retaining surviving staged lines after working deletions", () => {
  expect([...stagedLineKinds("a\nb\nc\nd", "a\nB\nC\nd", "a\nC\nd")]).toEqual([[2, "modified"]]);
  expect([...stagedLineKinds("a\nb\nc\nd", "a\nB\nC\nd", "a\nnew\nC\nd")]).toEqual([[3, "modified"]]);
  expect([...stagedLineKinds("a\nb", "a\r\nB", "a\nB")]).toEqual([[2, "modified"]]);
});
