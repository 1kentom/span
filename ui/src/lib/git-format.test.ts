import { expect, it } from "vitest";
import { gitCommitGraph } from "./git-format";
it("uses actual parent topology to preserve two lanes through a merge and join", () => {
  const rows = gitCommitGraph([{ id: "merge", parents: ["left", "right"] }, { id: "left", parents: ["base"] }, { id: "right", parents: ["base"] }, { id: "base", parents: [] }]);
  expect(rows.map(row => row.lane)).toEqual([0, 0, 1, 0]);
  expect(rows[0].edges).toHaveLength(3);
  expect(rows[2].edges.some(edge => edge.path.includes("M18 18") && edge.path.endsWith("8 38"))).toBe(true);
  expect(rows[3].edges).toHaveLength(1);
});
it("keeps an unloaded parent lane open at a page boundary", () => {
  const [row] = gitCommitGraph([{ id: "first", parents: ["not-loaded"] }]);
  expect(row.edges.some(edge => edge.path.endsWith("8 38"))).toBe(true);
});
