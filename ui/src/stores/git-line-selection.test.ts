// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitLineReview } from "../bindings";
import { createGitLineSelection } from "./git-line-selection";
it("rejects invented or context IDs and keeps disjoint selections in server order", () => {
  createRoot(dispose => {
    const review: GitLineReview = { diff: { repositoryId: "r", path: "p", side: "staged", indexRevision: "i", patch: "", binary: false, truncated: false }, worktreeSnapshot: "disk", metadata: [], hunks: [{ id: "h", header: "h", lines: [{ id: "c", kind: "context", text: "same", oldLine: 1, newLine: 1 }, ...["a", "b", "d"].map(id => ({ id, kind: "insert", text: id, oldLine: null, newLine: 1 }))] }] };
    const selection = createGitLineSelection(() => review);
    selection.toggle("invented"); selection.toggle("c"); selection.toggle("d"); selection.toggle("a");
    selection.setMetadata(true);
    expect(selection.request()).toEqual({ review, lineIds: ["a", "d"], includeMetadata: false });
    selection.toggle("a"); expect(selection.request()?.lineIds).toEqual(["d"]);
    dispose();
  });
});
it("withholds selected-line actions above the render cap", () => {
  createRoot(dispose => {
    const [review] = createSignal<GitLineReview>({ diff: { repositoryId: "r", path: "p", side: "working", indexRevision: "i", patch: "", binary: false, truncated: false }, worktreeSnapshot: "disk", metadata: [], hunks: [{ id: "h", header: "h", lines: Array.from({ length: 10_001 }, (_, index) => ({ id: String(index), kind: "insert", text: "a", oldLine: null, newLine: index + 1 })) }] });
    const selection = createGitLineSelection(review); selection.toggle("0");
    expect(selection.supported()).toBe(false); expect(selection.request()).toBeUndefined(); expect(selection.selected().size).toBe(0);
    dispose();
  });
});
