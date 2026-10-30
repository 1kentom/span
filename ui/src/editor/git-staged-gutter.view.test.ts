// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
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
