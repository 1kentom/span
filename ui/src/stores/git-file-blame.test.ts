import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createGitFileBlame } from "./git-file-blame";
import type { GitBlame, GitFileBaseline_Serialize } from "../bindings";
const blame: GitBlame = { repositoryId: "r", path: "file", head: "h", lines: [1, 2, 3].map(line => ({ line, originalLine: line, author: `Author ${line}`, authorEmail: "a@test", commitId: `commit${line}`, timestamp: 100, summary: "message" })) };
const baseline: GitFileBaseline_Serialize = { repositoryId: "r", path: "file", indexRevision: "i", headText: "one\ntwo\nthree", indexText: "one\ntwo\nthree", binary: false, truncated: false };
describe("file blame mapping", () => {
  it("never attributes inserted or replaced live lines and maps moved unchanged lines", () => createRoot(dispose => {
    const [text, setText] = createSignal("new\none\nreplaced\nthree");
    const model = createGitFileBlame({ path: () => "file", text, baseline: () => baseline, blame: () => blame });
    expect(model.rows().map(row => row.attribution?.author)).toEqual([undefined, "Author 1", undefined, "Author 3"]);
    expect(model.rows()[0].changed).toBe(true);
    setText("one\ntwo\nthree"); expect(model.rows().map(row => row.attribution?.author)).toEqual(["Author 1", "Author 2", "Author 3"]); dispose();
  }));
  it("bounds page rendering and withholds mismatched or oversized data", () => createRoot(dispose => {
    const [text, setText] = createSignal(Array(310).fill("line").join("\n"));
    const [base, setBase] = createSignal<GitFileBaseline_Serialize>({ ...baseline, headText: text() });
    const model = createGitFileBlame({ path: () => "file", text, baseline: base, blame: () => blame });
    expect(model.rows()).toHaveLength(150); model.next(); expect(model.rows()[0].line).toBe(151); model.next(); expect(model.rows()).toHaveLength(10);
    setBase({ ...base(), repositoryId: "other" }); expect(model.available()).toBe(false); expect(model.rows()).toEqual([]);
    setBase(baseline); setText("x".repeat(2 * 1024 * 1024 + 1)); expect(model.available()).toBe(false); dispose();
  }));
});
