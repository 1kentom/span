// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { gitGutter, navigateGitChange, setGitBaseline } from "./git-gutter";

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });
function editor(doc: string, baseline?: string) {
  const count = vi.fn();
  const view = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc, extensions: gitGutter(baseline, count) }) });
  views.push(view);
  return { view, count };
}

describe("live CodeMirror Git gutter", () => {
  it("marks saved and unsaved additions, modifications and deletions and navigates hunks", async () => {
    const { view, count } = editor("first\ninserted\nsecond\nchanged\nlast", "first\nsecond\nthird\nremoved\nlast");
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(2));
    expect(view.dom.querySelectorAll(".cm-git-added").length).toBe(1);
    expect(view.dom.querySelectorAll(".cm-git-modified").length).toBe(1);
    expect(navigateGitChange(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    expect(navigateGitChange(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    expect(navigateGitChange(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "first\nlast" } });
    expect(navigateGitChange(view, 1)).toBe(false);
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    expect(view.dom.querySelector(".cm-git-deleted")).toBeTruthy();
    expect(navigateGitChange(view, -1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(1);
  });
  it("updates the baseline on staging and clears markers immediately when consent or repository state resets", async () => {
    const { view, count } = editor("unsaved", "");
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    view.dispatch({ effects: setGitBaseline.of("unsaved") });
    expect(navigateGitChange(view, 1)).toBe(false);
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(0));
    view.dispatch({ effects: setGitBaseline.of(undefined), changes: { from: 0, to: view.state.doc.length, insert: "private draft" } });
    await new Promise(resolve => setTimeout(resolve, 160));
    expect(count).toHaveBeenLastCalledWith(0);
    expect(view.dom.querySelector(".cm-git-marker")).toBeNull();
  });
  it("cancels pending computation when the editor is destroyed", async () => {
    const { view, count } = editor("new", "old");
    view.destroy(); views.pop();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(count).not.toHaveBeenCalled();
  });
});
