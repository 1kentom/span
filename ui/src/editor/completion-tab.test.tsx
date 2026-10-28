// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";
import { autocompletion, closeCompletion, completionStatus, snippetCompletion, startCompletion, type CompletionResult } from "@codemirror/autocomplete";
import { StateEffect } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import Editor from "../components/Editor";

const dispose: (() => void)[] = [];
beforeAll(() => {
  // JSDOM has no layout; browser tests below cover real caret and popup geometry.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { dispose.splice(0).forEach(close => close()); document.body.replaceChildren(); });

async function editor(marked: string, language = "jsonc", path = "settings://user", readOnly = false) {
  const position = marked.indexOf("|");
  const text = marked.replace("|", "");
  const parent = document.createElement("div"); document.body.append(parent);
  dispose.push(render(() => <Editor buffer={{ path, text, revision: 0, savedRevision: 0, language }} onEdit={() => {}} onSave={() => {}} readOnly={readOnly} />, parent));
  await vi.waitFor(() => expect(parent.querySelector(".cm-editor")).not.toBeNull());
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  await vi.waitFor(() => expect(view.state.languageDataAt("autocomplete", position).length).toBeGreaterThan(0));
  view.dispatch({ selection: { anchor: position } }); view.focus();
  return { view, text };
}

function tab(view: EditorView, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, shiftKey, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("completion-first Tab in the real Editor", () => {
  it("accepts Inter over the whole quoted settings token instead of indenting, with one-step undo", async () => {
    const { view, text } = await editor('{\n  // Keep this comment\n  "uiFontFamily": "In|",\n  "fontSize": 13,\n}\n');
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(tab(view).defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(text.replace('"In"', '"Inter"'));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(text);
  });

  it.each([
    ['{"uiFontSi|": 14,}', '{"uiFontSize": 14,}'],
    ['{"theme": "Pu|",}', '{"theme": "Purple",}'],
    ['{"uiFontSi|', '{"uiFontSize": 13'],
    ['{\n  "unknown.setting": {"keep":"original"},\n  "uiFontFamily": "In|', '{\n  "unknown.setting": {"keep":"original"},\n  "uiFontFamily": "Inter"'],
  ])("accepts schema property and enum completion without changing surrounding JSONC: %s", async (marked, expected) => {
    const { view } = await editor(marked);
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    tab(view); expect(view.state.doc.toString()).toBe(expected);
  });

  it.each(["html", "css"])("gives visible %s completion priority over Emmet", async language => {
    const { view } = await editor(language === "html" ? "div.box|" : ".box { m10| }", language, `fixture.${language}`);
    const from = language === "html" ? 0 : 7;
    view.dispatch({ effects: StateEffect.appendConfig.of(autocompletion({ override: [() => ({ from, options: [{ label: language === "html" ? "div.box-completed" : "m10-completed", apply: "completion-wins" }] })] })) });
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    tab(view); expect(view.state.doc.toString()).toContain("completion-wins");
    expect(view.state.doc.toString()).not.toContain('class="box"');
    expect(view.state.doc.toString()).not.toContain("margin:");
  });

  it("does not indent while completion is pending", async () => {
    const { view, text } = await editor('{"uiFontFamily": "In|"}');
    let resolve!: (result: CompletionResult | null) => void;
    view.dispatch({ effects: StateEffect.appendConfig.of(autocompletion({ override: [() => new Promise<CompletionResult | null>(complete => { resolve = complete; })] })) });
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("pending"));
    expect(tab(view).defaultPrevented).toBe(true); expect(view.state.doc.toString()).toBe(text);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function")); resolve(null);
  });

  it("retains snippet field navigation and ordinary Tab and Shift+Tab indentation", async () => {
    const { view } = await editor("x|");
    view.dispatch({ effects: StateEffect.appendConfig.of(autocompletion({ override: [() => ({ from: 0, options: [snippetCompletion("${1:one} ${2:two} ${3:three}", { label: "x-snippet" })] })] })) });
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    tab(view); expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("one");
    tab(view); expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("two");
    tab(view, true); expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("one");
    const plain = await editor("  value|");
    tab(plain.view); expect(plain.view.state.doc.toString()).toBe("    value");
    tab(plain.view, true); expect(plain.view.state.doc.toString()).toBe("  value");
  });

  it("preserves Emmet expansion when completion is closed", async () => {
    const { view } = await editor("div.box|", "html", "fixture.html");
    closeCompletion(view); tab(view);
    expect(view.state.doc.toString()).toContain('<div class="box">');
  });

  it("honors public Tab focus mode even with a visible completion", async () => {
    const { view, text } = await editor('{"uiFontFamily": "In|"}');
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    view.setTabFocusMode(true);
    expect(tab(view).defaultPrevented).toBe(false); expect(view.state.doc.toString()).toBe(text);
  });

  it("never accepts completion or indents a read-only editor", async () => {
    const { view, text } = await editor('{"uiFontFamily": "In|"}', "jsonc", "settings://user", true);
    startCompletion(view); await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    tab(view); expect(view.state.doc.toString()).toBe(text);
  });
});
