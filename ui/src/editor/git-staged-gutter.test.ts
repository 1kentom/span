import { expect, it } from "vitest";
import { stagedLineKinds } from "./git-staged-gutter";
it("keeps staged and working lines separate and maps staged changes after unsaved insertions", () => {
  expect([...stagedLineKinds("one\ntwo\nthree", "one\nstaged\nthree", "insert\none\nstaged\nworking")]).toEqual([[3, "modified"]]);
  expect([...stagedLineKinds("one\ntwo", "one\nstaged", "one\noverwritten")]).toEqual([]);
});
it("withholds staged markers when the exact diff exceeds its budget", () => {
  expect(stagedLineKinds("x".repeat(2 * 1024 * 1024 + 1), "x", "x").size).toBe(0);
});
