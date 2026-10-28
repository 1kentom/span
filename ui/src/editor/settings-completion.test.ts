import { describe, expect, it } from "vitest";
import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, foldable, getIndentation } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import canonicalSchema from "../../../crates/core/settings.schema.json";
import { isSettingsDocument, jsoncDiagnostics, jsoncSupport, settingsCompletionSource } from "./settings-completion";
import { loadLanguage, resolveLanguageId } from "./languages";

async function complete(marked: string) {
  const pos = marked.indexOf("|");
  const text = marked.replace("|", "");
  const state = EditorState.create({ doc: text, selection: { anchor: pos }, extensions: [jsoncSupport(true)] });
  const result = await settingsCompletionSource(new CompletionContext(state, pos, true));
  return { state, text, result };
}

function labels(result: CompletionResult | null) { return result?.options.map((option) => option.label) ?? []; }

describe("settings JSONC language", () => {
  it("recognizes only the trusted settings URIs and keeps ordinary JSON strict", async () => {
    expect(isSettingsDocument("settings://user")).toBe(true);
    expect(isSettingsDocument("settings://workspace")).toBe(true);
    expect(isSettingsDocument("settings://elsewhere")).toBe(false);
    expect(isSettingsDocument("project/settings.jsonc")).toBe(false);
    expect(resolveLanguageId("text", "settings://workspace")).toBe("jsonc");
    expect(resolveLanguageId("text", "config.jsonc")).toBe("jsonc");
    expect(resolveLanguageId("text", "config.json")).toBe("json");
    const language = await loadLanguage("jsonc", "config.jsonc");
    expect(language).not.toBeNull();
  });

  it("accepts comments and trailing commas, and highlights comment and property spans", () => {
    const text = '{\n  // safe comment\n  "editor.fontSize": 15, /* block */\n}\n';
    const state = EditorState.create({ doc: text, extensions: [jsoncSupport(true)] });
    expect(jsoncDiagnostics(state.doc, true)).toEqual([]);
    const tree = ensureSyntaxTree(state, text.length, 1000)!;
    const spans: { text: string; classes: string }[] = [];
    highlightTree(tree, classHighlighter, (from, to, classes) => spans.push({ text: text.slice(from, to), classes }));
    expect(spans.some((span) => span.text.includes("safe comment") && span.classes.includes("tok-comment"))).toBe(true);
    expect(spans.some((span) => span.text.includes("editor.fontSize") && span.classes.includes("tok-propertyName"))).toBe(true);
    expect(getIndentation(state, text.indexOf("\"editor.fontSize\""))).toBe(2);
    expect(foldable(state, 0, 1)).toEqual({ from: 1, to: text.lastIndexOf("}") });
  });

  it("offers exactly canonical settings, including dotted aliases and legacy names", async () => {
    const { result } = await complete("{ | }");
    expect(new Set(labels(result))).toEqual(new Set(Object.keys(canonicalSchema.properties)));
    expect(labels(result)).toContain("editor.fontSize");
    expect(labels(result)).toContain("fontSize");
    expect(labels(result)).not.toContain("chatgpt.apiKey");
    const option = result!.options.find((item) => item.label === "editor.fontSize")!;
    expect(option.detail).toContain("default 13");
    expect(option.info).toBeTruthy();
    expect(typeof option.apply).toBe("function");
  });

  it("completes partial quoted property keys without duplicating the closing quote", async () => {
    const { text, result } = await complete('{ "editor.fo|" }');
    expect(text.slice(result!.from, result!.to)).toBe('"editor.fo"');
    expect(labels(result)).toContain("editor.formatOnSave");
  });

  it("suggests schema enum/default values and nested known action names", async () => {
    expect(labels((await complete('{ "editor.wordWrap": "o|" }')).result)).toEqual(['"on"', '"off"']);
    expect(labels((await complete('{ "editor.fontSize": | }')).result)).toContain("13");
    const actions = (await complete('{ "keybindings": { "|" } }')).result;
    expect(labels(actions)).toContain("quickOpen");
    expect(labels(actions)).not.toContain("editor.fontSize");
    expect((await complete('{ // | ignored\n }')).result).toBeNull();
    expect((await complete('{ "unknown": | }')).result).toBeNull();
  });

  it("does not suggest duplicate existing properties elsewhere in the same object", async () => {
    const { result } = await complete('{ "editor.fontSize": 13, | }');
    expect(labels(result)).not.toContain("editor.fontSize");
    expect(labels(result)).toContain("editor.tabSize");
  });

  it("inserts a valid schema default snippet and selects its editable value", async () => {
    const completed = await complete("{ | }");
    let state = completed.state;
    const option = completed.result!.options.find((item) => item.label === "editor.fontSize")!;
    const editor = { get state() { return state; }, dispatch: (transaction: { state: EditorState }) => { state = transaction.state; } } as EditorView;
    if (typeof option.apply !== "function") throw new Error("Expected a property snippet.");
    option.apply(editor, option, completed.result!.from, completed.result!.to ?? completed.result!.from);
    expect(JSON.parse(state.doc.toString())).toEqual({ "editor.fontSize": 13 });
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("13");
    expect(jsoncDiagnostics(state.doc, true)).toEqual([]);
  });

  it("installs exactly one settings completion source and none on generic JSONC", () => {
    const settings = EditorState.create({ doc: "{}", extensions: [jsoncSupport(true)] });
    const generic = EditorState.create({ doc: "{}", extensions: [jsoncSupport(false)] });
    expect(settings.languageDataAt("autocomplete", 1)).toEqual([settingsCompletionSource]);
    expect(generic.languageDataAt("autocomplete", 1)).toEqual([]);
  });

  it("reports syntax, known types, bounds, enums, and invalid nested action values", () => {
    const invalid = Text.of(['{ "editor.fontSize": "large", "tabSize": 99, "editor.wordWrap": "bounded", "keybindings": { "quickOpen": false } }']);
    const messages = jsoncDiagnostics(invalid, true).map((item) => item.message).join("\n");
    expect(messages).toContain("editor.fontSize must be integer");
    expect(messages).toContain("Maximum value is 8");
    expect(messages).toContain('"on", "off"');
    expect(messages).toContain("keybindings.quickOpen must be array");
    expect(jsoncDiagnostics(Text.of(['{ "fontSize": }']), true).some((item) => item.source === "JSONC" && item.severity === "error")).toBe(true);
  });

  it("warns about preserved unknown settings without treating them as fatal save errors", () => {
    const source = '{ "foreign.setting": { "preserve": true }, "editor.fontSize": 13 }';
    const doc = Text.of([source]);
    const diagnostics = jsoncDiagnostics(doc, true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toContain("preserved but has no effect");
    expect(doc.toString()).toBe(source);
    expect(jsoncDiagnostics(doc, false)).toEqual([]);
  });
});
