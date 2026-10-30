// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
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
  it("opens with keyboard, preserves the caret, marks the selection, and dismisses outside", async () => {
    const { view, count } = editor("first\nchanged\nlast", "first\nold\nlast");
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    view.focus();
    const marker = view.dom.querySelector<HTMLButtonElement>("button.cm-git-marker")!;
    expect(marker).not.toBeNull();
    const pointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    marker.dispatchEvent(pointer); expect(pointer.defaultPrevented).toBe(true);
    marker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.querySelector(".cm-git-selected")?.getAttribute("aria-expanded")).toBe("true");
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview" )).not.toBeNull());
    expect(document.querySelector(".cm-git-preview")?.textContent).toContain("Index compared with live buffer");
    expect(document.querySelectorAll(".cm-git-preview-number")).toHaveLength(2);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(view.dom.querySelector(".cm-git-selected")).toBeNull();
    expect(view.hasFocus).toBe(true);
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview")).toBeNull());
    view.dom.querySelector(".cm-git-marker")!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview")).not.toBeNull());
    document.querySelector(".cm-git-preview")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview")).toBeNull());
    expect(view.hasFocus).toBe(true);
  });
  it("distinguishes deletion before the first line from deletion after the last line", async () => {
    const first = editor("keep", "removed\nkeep");
    const last = editor("keep", "keep\nremoved");
    await vi.waitFor(() => expect(first.count).toHaveBeenLastCalledWith(1));
    await vi.waitFor(() => expect(last.count).toHaveBeenLastCalledWith(1));
    expect(first.view.dom.querySelector(".cm-git-deleted-top")).not.toBeNull();
    expect(last.view.dom.querySelector(".cm-git-deleted")).not.toBeNull();
    expect(last.view.dom.querySelector(".cm-git-deleted-top")).toBeNull();
  });
  it("closes stale previews immediately on edits and bounds replacement rows", async () => {
    const { view, count } = editor(Array.from({ length: 60 }, (_, i) => `new ${i}`).join("\n"), Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n"));
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    view.dom.querySelector<HTMLButtonElement>(".cm-git-marker")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll(".cm-git-preview-row")).toHaveLength(40));
    expect(document.querySelectorAll(".cm-git-preview-shortened")).toHaveLength(2);
    view.dispatch({ changes: { from: 0, insert: "edited" } });
    expect(view.dom.querySelector(".cm-git-marker")).toBeNull();
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview")).toBeNull());
    view.dispatch({ effects: setGitBaseline.of(undefined) });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(view.dom.querySelector(".cm-git-marker")).toBeNull();
  });

  it("offers the saved comparison explicitly without exposing staging for live edits", async () => {
    const review = vi.fn();
    const view = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc: "unsaved", extensions: gitGutter("index", undefined, review) }) });
    views.push(view);
    await vi.waitFor(() => expect(view.dom.querySelector(".cm-git-marker")).not.toBeNull());
    const marker = view.dom.querySelector<HTMLButtonElement>(".cm-git-marker")!;
    marker.click();
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview-review")).not.toBeNull());
    expect(document.querySelector(".cm-git-preview")?.textContent).toContain("Saved comparison excludes unsaved buffer edits.");
    expect([...document.querySelectorAll(".cm-git-preview button")].some(button => /stage/i.test(button.textContent ?? ""))).toBe(false);
    document.querySelector<HTMLButtonElement>(".cm-git-preview-review")!.click();
    expect(review).toHaveBeenCalledOnce();
    view.dispatch({ changes: { from: 0, insert: "more " } });
    marker.click();
    await vi.waitFor(() => expect(document.querySelector(".cm-git-preview")).toBeNull());
  });

  it("retains untouched rails during typing, maps their positions, and drops touched spans", async () => {
    const { view, count } = editor("one\ntwo\nthree\nchanged\nfive\nsix\nseven", "one\ntwo\nthree\nold\nfive\nsix\nseven");
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    const marker = view.dom.querySelector(".cm-git-marker");
    view.dispatch({ changes: { from: view.state.doc.length, insert: " typing" } });
    expect(view.dom.querySelector(".cm-git-marker")).toBe(marker);
    view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
    expect(view.dom.querySelector(".cm-git-marker")).not.toBeNull();
    expect(navigateGitChange(view, 1)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    const changed = view.state.doc.line(5);
    view.dispatch({ changes: { from: changed.from, insert: "touch " } });
    expect(view.dom.querySelector(".cm-git-marker")).toBeNull();
    expect(navigateGitChange(view, 1)).toBe(false);
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(3));
  });
  it("retains a distant deletion gap but invalidates edits adjacent to its anchor", async () => {
    const { view, count } = editor("one\ntwo\nthree\nfour\nfive\nsix", "one\ntwo\nremoved\nthree\nfour\nfive\nsix");
    await vi.waitFor(() => expect(count).toHaveBeenLastCalledWith(1));
    view.dispatch({ changes: { from: view.state.doc.length, insert: " typing" } });
    expect(view.dom.querySelector(".cm-git-deleted")).not.toBeNull();
    const neighbor = view.state.doc.line(3);
    view.dispatch({ changes: { from: neighbor.from, insert: "touch " } });
    expect(view.dom.querySelector(".cm-git-deleted")).toBeNull();
  });

  it("exposes interactive Git lanes, hides decorative line numbers, and restores gutter attributes on reset", async () => {
    const view = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc: "one\ntwo\nthree", extensions: [lineNumbers(), gitGutter("")] }) });
    views.push(view);
    await vi.waitFor(() => expect(view.dom.querySelectorAll("button.cm-git-marker")).toHaveLength(3));
    const gutters = view.dom.querySelector(".cm-gutters")!;
    expect(gutters.hasAttribute("aria-hidden")).toBe(false);
    expect(gutters.getAttribute("aria-label")).toBe("Git change indicators");
    expect(view.dom.querySelector(".cm-lineNumbers")?.getAttribute("aria-hidden")).toBe("true");
    expect(view.dom.querySelectorAll("button.cm-git-marker[tabindex='0']")).toHaveLength(1);
    expect(view.dom.querySelectorAll("button.cm-git-marker[tabindex='-1']")).toHaveLength(2);
    view.dom.querySelector<HTMLButtonElement>(".cm-git-marker")!.click();
    expect(view.dom.querySelectorAll("button.cm-git-marker[tabindex='0']")).toHaveLength(1);
    view.dispatch({ effects: setGitBaseline.of(undefined) });
    expect(gutters.getAttribute("aria-hidden")).toBe("true");
    expect(gutters.hasAttribute("aria-label")).toBe(false);
    expect(view.dom.querySelector(".cm-lineNumbers")?.hasAttribute("aria-hidden")).toBe(false);
  });

});
