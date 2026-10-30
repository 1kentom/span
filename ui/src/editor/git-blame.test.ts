// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { GitBlame } from "../bindings";
import { gitInlineBlame, setGitBlame } from "./git-blame";
import { vi } from "vitest";

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });
const blame: GitBlame = { repositoryId: "repo", path: "file.ts", head: "commit", lines: [1, 2, 3].map(line => ({ line, originalLine: line, commitId: "123456789abcdef", author: `Author ${line}`, authorEmail: "author@example.test", timestamp: 1_700_000_000, summary: `Commit for line ${line}` })) };
function editor() {
  const view = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc: "one\nchanged\nthree", extensions: gitInlineBlame({ baseline: "one\ntwo\nthree", blame, enabled: true }) }) });
  views.push(view);
  return view;
}
const label = (view: EditorView) => view.dom.querySelector(".cm-git-blame")?.textContent;

describe("HEAD-pinned inline blame", () => {
  it("attributes unchanged current lines and labels replacements as uncommitted", async () => {
    const view = editor();
    await vi.waitFor(() => expect(label(view)).toBe("Author 1 · Commit for line 1"));
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    expect(label(view)).toBe("Uncommitted changes");
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
    expect(label(view)).toBe("Author 3 · Commit for line 3");
    view.dispatch({ changes: { from: 0, insert: "unsaved insertion\n" } });
    expect(label(view)).toBeUndefined();
    await vi.waitFor(() => expect(label(view)).toBe("Author 3 · Commit for line 3"));
  });
  it("suppresses attribution while selecting text and clears it when disabled", async () => {
    const view = editor();
    await vi.waitFor(() => expect(label(view)).toContain("Author 1"));
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    expect(label(view)).toBeUndefined();
    view.dispatch({ selection: { anchor: 0 } });
    expect(label(view)).toContain("Author 1");
    view.dispatch({ effects: setGitBlame.of({ enabled: false, baseline: "one\ntwo\nthree", blame }) });
    expect(label(view)).toBeUndefined();
  });
  it("withholds attribution if the HEAD baseline is unavailable", async () => {
    const view = editor();
    view.dispatch({ effects: setGitBlame.of({ enabled: true, blame }) });
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(label(view)).toBeUndefined();
  });
});
