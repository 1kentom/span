// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { codeFolding, foldEffect, unfoldEffect } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { gitStagedGutter, setGitStagedBaseline } from "./git-staged-gutter";
it("renders an independent staged lane and clears stale markers immediately on live edits or reset", async () => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "one\nstaged", extensions: gitStagedGutter({ head: "one\ntwo", index: "one\nstaged" }) }) });
  try {
    await vi.waitFor(() => expect(host.querySelector('.cm-git-staged-gutter .cm-git-modified')).not.toBeNull());
    view.dispatch({ changes: { from: 4, to: view.state.doc.length, insert: "working" } });
    expect(host.querySelector('.cm-git-staged-gutter .cm-git-modified')).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 170)); expect(host.querySelector('.cm-git-staged-gutter .cm-git-modified')).toBeNull();
    view.dispatch({ effects: setGitStagedBaseline.of(undefined) });
    expect(host.querySelector('.cm-git-staged-gutter .cm-git-marker')).toBeNull();
  } finally { view.destroy(); host.remove(); }
});
it("exposes a staged review button with a full lane rail and explicit activation only", async () => {
  const review = vi.fn();
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "keep", extensions: gitStagedGutter({ head: "removed\nkeep", index: "keep" }, review) }) });
  try {
    await vi.waitFor(() => expect(host.querySelector("button.cm-git-staged-marker")).not.toBeNull());
    const button = host.querySelector<HTMLButtonElement>("button.cm-git-staged-marker")!;
    expect(button.type).toBe("button");
    expect(button.classList.contains("cm-git-deleted-top")).toBe(true);
    expect(button.querySelector(".cm-git-rail")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toContain("HEAD compared with index");
    expect(review).not.toHaveBeenCalled();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    button.focus();
    expect(document.activeElement).toBe(button);
    // Native keyboard activation emits click, preserving the browser's button semantics.
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    button.click();
    expect(review).toHaveBeenCalledTimes(2);
    expect(view.state.selection.main.head).toBe(0);
  } finally { view.destroy(); host.remove(); }
});
it("keeps a staged indicator descriptive and disabled when review is unavailable", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "keep", extensions: gitStagedGutter({ head: "keep\nremoved", index: "keep" }) }) });
  try {
    await vi.waitFor(() => expect(host.querySelector("button.cm-git-staged-marker")).not.toBeNull());
    const button = host.querySelector<HTMLButtonElement>("button.cm-git-staged-marker")!;
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("cm-git-marker-reviewable")).toBe(false);
    expect(button.classList.contains("cm-git-deleted-top")).toBe(false);
    expect(button.title).toContain("Staged deleted change");
  } finally { view.destroy(); host.remove(); }
});

it("anchors staged markers to document lines through wrapping and folding", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const doc = "start\n" + "changed ".repeat(60) + "\nend";
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [EditorView.lineWrapping, codeFolding(), gitStagedGutter({ head: "start\nold\nend", index: doc })] }) });
  try {
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1));
    const range = { from: view.state.doc.line(1).to, to: view.state.doc.line(2).to };
    view.dispatch({ effects: foldEffect.of(range) });
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(0));
    view.dispatch({ effects: unfoldEffect.of(range) });
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1));
  } finally { view.destroy(); host.remove(); }
});
it("preserves untouched staged rails immediately while clearing an edited line", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "first\nstaged\nlast", extensions: gitStagedGutter({ head: "first\nold\nlast", index: "first\nstaged\nlast" }) }) });
  try {
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1));
    view.dispatch({ changes: { from: view.state.doc.length, insert: " edited" } });
    expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1);
    view.dispatch({ changes: { from: view.state.doc.line(2).from, insert: "inserted\n" } });
    expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1);
    view.dispatch({ changes: { from: view.state.doc.line(3).from + 1, insert: "x" } });
    expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(0);
  } finally { view.destroy(); host.remove(); }
});
it("clears a deletion rail immediately when editing the adjacent boundary", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "one\nanchor\nafter\nlast", extensions: gitStagedGutter({ head: "one\nanchor\nremoved\nafter\nlast", index: "one\nanchor\nafter\nlast" }) }) });
  try {
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1));
    view.dispatch({ changes: { from: view.state.doc.length, insert: " distant" } });
    expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(1);
    view.dispatch({ changes: { from: view.state.doc.line(3).from, insert: "new\n" } });
    expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(0);
  } finally { view.destroy(); host.remove(); }
});
it("exposes interactive staged-only gutters and restores their hidden state after reset", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "B\nC", extensions: gitStagedGutter({ head: "b\nc", index: "B\nC" }, vi.fn()) }) });
  try {
    await vi.waitFor(() => expect(host.querySelectorAll(".cm-git-staged-marker")).toHaveLength(2));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".cm-git-staged-marker")];
    expect(buttons.map(button => button.tabIndex)).toEqual([0, -1]);
    expect(buttons[0].closest('[aria-hidden="true"]')).toBeNull();
    const gutters = host.querySelector(".cm-gutters")!;
    expect(gutters.getAttribute("role")).toBe("group");
    view.dispatch({ effects: setGitStagedBaseline.of(undefined) });
    expect(gutters.getAttribute("aria-hidden")).toBe("true");
    expect(gutters.hasAttribute("role")).toBe(false);
  } finally { view.destroy(); host.remove(); }
});
