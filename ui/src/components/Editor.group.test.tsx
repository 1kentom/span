// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import type { BufferSnapshot } from "../bindings";
import Editor from "./Editor";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });

describe("editor groups sharing one file", () => {
  it("synchronizes document edits while keeping each group's selection independent", async () => {
    const buffer: BufferSnapshot = { path: "src/shared.ts", text: "alpha\nbeta\n", revision: 0, savedRevision: 0, language: "typescript" };
    const [sharedDocument, setSharedDocument] = createSignal(Text.of(buffer.text.split("\n")));
    const host = document.createElement("div"); document.body.append(host);
    disposers.push(render(() => <><Editor buffer={buffer} document={sharedDocument()} active onEdit={edit => setSharedDocument(edit.document)} onSave={vi.fn()} /><Editor buffer={buffer} document={sharedDocument()} active={false} onEdit={edit => setSharedDocument(edit.document)} onSave={vi.fn()} /></>, host));
    await Promise.resolve(); await Promise.resolve();
    const content = [...host.querySelectorAll<HTMLElement>(".cm-content")];
    const left = EditorView.findFromDOM(content[0]!); const right = EditorView.findFromDOM(content[1]!);
    expect(left).toBeTruthy(); expect(right).toBeTruthy();
    left!.dispatch({ selection: { anchor: 5 } });
    right!.dispatch({ selection: { anchor: 2 } });
    left!.dispatch({ changes: { from: 0, insert: "X" } });
    await Promise.resolve(); await Promise.resolve();
    expect(left!.state.doc.toString()).toBe("Xalpha\nbeta\n");
    expect(right!.state.doc.toString()).toBe("Xalpha\nbeta\n");
    expect(left!.state.selection.main.anchor).toBe(6);
    expect(right!.state.selection.main.anchor).toBe(3);
  });
});
