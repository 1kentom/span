import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, StateEffect, type Transaction } from "@codemirror/state";
import { ensureSyntaxTree, indentUnit } from "@codemirror/language";
import { history, undo } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { loadLanguage } from "./languages";
import { expandEmmet } from "./emmet";

async function editorState(marked: string, language: string) {
  const positions: number[] = [];
  let text = "";
  for (const character of marked) { if (character === "|") positions.push(text.length); else text += character; }
  const support = await loadLanguage(language, `fixture.${language}`);
  const state = EditorState.create({ doc: text, selection: EditorSelection.create(positions.map((position) => EditorSelection.cursor(position))), extensions: [support ?? [], EditorState.allowMultipleSelections.of(true), indentUnit.of("  "), history(), keymap.of([indentWithTab])] });
  ensureSyntaxTree(state, state.doc.length, 1000);
  return state;
}

function expand(state: EditorState) {
  let transaction: Transaction | undefined;
  const handled = expandEmmet({ state, dispatch: (next) => { transaction = next; } });
  return { handled, transaction };
}

const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); document.body.replaceChildren(); });

describe("official Emmet expansion", () => {
  it("expands nested HTML with classes and repeated children as one invertible transaction", async () => {
    const state = await editorState("div.container>ul>li*3|", "html");
    const serialize = vi.spyOn(state.doc, "toString");
    const { handled, transaction } = expand(state);
    expect(handled).toBe(true);
    expect(serialize).not.toHaveBeenCalled();
    const html = transaction!.newDoc.toString();
    expect(html).toContain('<div class="container">');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("  <ul>");
    expect(transaction!.isUserEvent("input.emmet")).toBe(true);
    expect(transaction!.changes.invert(state.doc).apply(transaction!.newDoc).toString()).toBe("div.container>ul>li*3");
  });

  it.each([["m10", "margin: 10px;"], ["p10", "padding: 10px;"]])("expands CSS %s in declaration context", async (abbreviation, expected) => {
    const { handled, transaction } = expand(await editorState(`.box {\n  ${abbreviation}|\n}`, "css"));
    expect(handled).toBe(true);
    expect(transaction!.newDoc.toString()).toContain(expected);
  });

  it("expands every cursor together and undo restores all abbreviations", async () => {
    const original = await editorState("ul>li*2|\ndiv.box|", "html");
    const result = expand(original);
    expect(result.handled).toBe(true);
    let state = result.transaction!.state;
    expect(state.selection.ranges).toHaveLength(2);
    expect(state.doc.toString()).toContain('<div class="box">');
    expect(state.doc.toString().match(/<li>/g)).toHaveLength(2);
    expect(undo({ get state() { return state; }, dispatch: (transaction) => { state = transaction.state; } })).toBe(true);
    expect(state.doc.toString()).toBe(original.doc.toString());
  });

  it.each([
    ["html", "<!-- div.box| -->"], ["html", '<div title="div.box|">text</div>'],
    ["html", '<script>const value = "div.box|";</script>'],
    ["css", ".box { /* m10| */ }"], ["css", '.box { content: "m10|"; }'],
    ["javascript", "div.box|"], ["json", '{ "value": "div.box|" }'],
  ])("leaves %s comments, strings, or unsupported syntax unchanged", async (language, marked) => {
    const result = expand(await editorState(marked, language));
    expect(result.handled).toBe(false);
    expect(result.transaction).toBeUndefined();
  });

  it("lets Tab insert indentation when there is no eligible abbreviation", async () => {
    const state = await editorState(".box {\n  |\n}", "css");
    const host = document.createElement("div"); document.body.append(host);
    const view = new EditorView({ state, parent: host }); views.push(view);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe(".box {\n    \n}");
  });

  it("honors CodeMirror Tab focus mode instead of expanding", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const view = new EditorView({ state: await editorState("div.box|", "html"), parent: host }); views.push(view);
    view.setTabFocusMode(true);
    const event = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe("div.box");
  });

  it("accepts an open completion before considering an Emmet abbreviation", async () => {
    const initial = await editorState("div.box|", "html");
    const state = initial.update({ effects: StateEffect.appendConfig.of(autocompletion({ interactionDelay: 0, override: [() => ({ from: 0, options: [{ label: "div.box-completed", apply: "completion-wins" }] })] })) }).state;
    const host = document.createElement("div"); document.body.append(host);
    const view = new EditorView({ state, parent: host }); views.push(view);
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("completion-wins");
  });

  it("does not partially expand when another cursor is inside an attribute", async () => {
    const result = expand(await editorState('div.box|\n<div title="p.note|">text</div>', "html"));
    expect(result.handled).toBe(false);
    expect(result.transaction).toBeUndefined();
  });
});
