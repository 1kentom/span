import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { classHighlighter, highlightTree, tags, type Highlighter } from "@lezer/highlight";
import { loadLanguage, resolveLanguageId } from "../editor/languages";
import { ProposalWidget, codeHighlighting, handleSharedHistoryKey, performClipboardAction, persistentDocumentChange, revealPosition, transactionEdits } from "./Editor";

function documentChange(before: string, after: string) {
  const change = persistentDocumentChange(Text.of(before.split("\n")), Text.of(after.split("\n")));
  return change ? { ...change, insert: change.insert.toString() } : undefined;
}

describe("document synchronization", () => {
  it("keeps an unchanged document untouched", () => {
    expect(documentChange("const value = 1;", "const value = 1;")).toBeUndefined();
  });

  it("replaces only the changed middle of a document", () => {
    expect(documentChange("const value = 1;\n", "const value = 25;\n")).toEqual({ from: 14, to: 15, insert: "25" });
  });

  it("never divides the shared high surrogate of two emoji", () => {
    expect(documentChange("a😀z", "a😁z")).toEqual({ from: 1, to: 3, insert: "😁" });
  });

  it("never divides a shared low surrogate in the suffix", () => {
    expect(documentChange("\ud83d\ude00", "\ud83c\ude00")).toEqual({ from: 0, to: 2, insert: "\ud83c\ude00" });
  });

  it("locates a change across recovery chunk boundaries", () => {
    const prefix = "a".repeat(4095);
    const suffix = "z".repeat(9000);
    expect(documentChange(`${prefix}😀${suffix}`, `${prefix}😁${suffix}`)).toEqual({ from: 4095, to: 4097, insert: "😁" });
  });

  it("serializes disjoint multi-cursor changes in original UTF-16 coordinates", () => {
    const state = EditorState.create({ doc: "😀 first\nsecond" });
    const transaction = state.update({ changes: [{ from: 3, to: 8, insert: "one" }, { from: 9, to: 15, insert: "two" }] });
    expect(transaction.newDoc.toString()).toBe("😀 one\ntwo");
    expect(transactionEdits(transaction.changes)).toEqual([{ from: 3, to: 8, insert: "one" }, { from: 9, to: 15, insert: "two" }]);
  });
});

describe("inline proposal review", () => {
  it("renders untrusted suggested code as text", () => {
    const suggested = '<script>window.compromised = true</script><img src="x" onerror="alert(1)">';
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 4, before: "base", after: suggested }, 0, true, false, vi.fn());
    const element = widget.toDOM();
    expect(element.querySelector("script, img")).toBeNull();
    expect(element.querySelector(".cm-proposal-after pre")?.textContent).toBe(suggested);
  });

  it("reports explicit per-hunk choices and marks the current choice accessibly", () => {
    const toggle = vi.fn();
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 4, before: "base", after: "next" }, 1, true, false, toggle);
    const element = widget.toDOM();
    const keep = element.querySelector<HTMLButtonElement>('[aria-label="Keep change 2"]')!;
    const skip = element.querySelector<HTMLButtonElement>('[aria-label="Skip change 2"]')!;
    expect(keep.getAttribute("aria-pressed")).toBe("true");
    expect(skip.getAttribute("aria-pressed")).toBe("false");
    skip.click();
    expect(toggle).toHaveBeenCalledWith("h1", false);
    keep.click();
    expect(toggle).toHaveBeenLastCalledWith("h1", true);
  });

  it("bounds a large hunk preview and disables choices during resolution", () => {
    const widget = new ProposalWidget({ id: "h1", from: 0, to: 0, before: "", after: "x".repeat(100_000) }, 0, false, true, vi.fn());
    const element = widget.toDOM();
    const preview = element.querySelector(".cm-proposal-after pre")?.textContent ?? "";
    expect(preview.length).toBeLessThan(12_100);
    expect(preview).toContain("Preview shortened");
    expect([...element.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("updates a chosen hunk without replacing its keyboard focus target", () => {
    const hunk = { id: "h1", from: 0, to: 4, before: "base", after: "next" };
    const toggle = vi.fn();
    const element = new ProposalWidget(hunk, 0, true, false, toggle).toDOM();
    const keep = element.querySelector("button");
    expect(new ProposalWidget(hunk, 0, false, false, toggle).updateDOM(element)).toBe(true);
    expect(element.querySelector("button")).toBe(keep);
    expect(keep?.getAttribute("aria-pressed")).toBe("false");
  });
});

async function highlighted(source: string, hint: string, path: string, highlighter: Highlighter = classHighlighter) {
  const grammar = await loadLanguage(hint, path);
  if (!grammar) throw new Error(`No grammar for ${path}`);
  const state = EditorState.create({ doc: source, extensions: [grammar] });
  const tree = ensureSyntaxTree(state, source.length, 1000);
  if (!tree) throw new Error(`Parsing did not finish for ${path}`);
  const spans: { text: string; classes: string }[] = [];
  highlightTree(tree, highlighter, (from, to, classes) => spans.push({ text: source.slice(from, to), classes }));
  return spans;
}

describe("editor language support", () => {
  it.each([".env", ".env.local", ".env.example", ".ENV.EXAMPLE"])("recognizes %s despite an unknown backend language", (name) => {
    expect(resolveLanguageId("text", `config/${name}`)).toBe("dotenv");
  });

  it("recognizes Markdown aliases, uppercase extensions, and extensionless README", () => {
    expect(resolveLanguageId("text", "README.MD")).toBe("markdown");
    expect(resolveLanguageId("text", "README")).toBe("markdown");
    expect(resolveLanguageId("md")).toBe("markdown");
    expect(resolveLanguageId("text", "Cargo.lock")).toBe("toml");
  });

  it("keeps heading, emphasis, links, and inline code styled by the editor theme", async () => {
    const spans = await highlighted("# Heading\n\n**bold** and *soft* with [link](https://example.com) and `code`.\n", "text", "README.MD", codeHighlighting);
    for (const [text, tag] of [["Heading", tags.heading], ["bold", tags.strong], ["soft", tags.emphasis], ["code", tags.monospace]] as const) {
      const tokenClass = codeHighlighting.style([tag]);
      expect(tokenClass).toBeTruthy();
      expect(spans.some((span) => span.text.includes(text) && span.classes.includes(tokenClass!))).toBe(true);
    }
    expect(spans.some((span) => span.text.includes("link"))).toBe(true);
  });

  it("distinguishes dotenv quotes, comments, keys, and interpolation", async () => {
    const spans = await highlighted('# header\nexport API_URL="https://host/#fragment/${REGION}" # comment\nLITERAL=\'hash # stays\'\nPORT=5432\nBROKEN="${NO_CLOSE"\n', "text", ".env.example");
    const comments = spans.filter((span) => span.classes.includes("tok-comment")).map((span) => span.text).join(" ");
    expect(comments).toContain("# header");
    expect(comments).toContain("# comment");
    expect(comments).not.toContain("#fragment");
    expect(comments).not.toContain("# stays");
    expect(spans.some((span) => span.text === "API_URL" && span.classes.includes("tok-propertyName"))).toBe(true);
    expect(spans.some((span) => span.text === "${REGION}" && span.classes.includes("tok-variableName2"))).toBe(true);
    expect(spans.some((span) => span.text === "5432" && span.classes.includes("tok-number"))).toBe(true);
  });

  it.each([
    ["config.toml", 'title = "span"\n'], ["config.yaml", "enabled: true\n"], ["index.html", '<main class="app">span</main>'],
    ["styles.css", ".app { color: red; }"], ["setup.sh", '#!/bin/sh\necho "$HOME"\n'],
  ])("lazily highlights practical file %s", async (path, source) => {
    expect((await highlighted(source, "text", path)).length).toBeGreaterThan(0);
  });
});

describe("shared history keyboard routing", () => {
  it.each([
    { key: "Z", ctrlKey: true, shiftKey: true },
    { key: "z", ctrlKey: true, shiftKey: true },
    { key: "y", ctrlKey: true },
    { key: "Z", metaKey: true, shiftKey: true },
  ])("routes platform redo keys once: %o", (init) => {
    const onUndo = vi.fn(); const onRedo = vi.fn();
    const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
    expect(handleSharedHistoryKey(event, { onUndo, onRedo })).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
    expect(handleSharedHistoryKey(event, { onUndo, onRedo })).toBe(false);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("leaves rebinding commands and non-primary keys for their owner", () => {
    const onUndo = vi.fn(); const onRedo = vi.fn();
    expect(handleSharedHistoryKey(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }), { onUndo, onRedo })).toBe(false);
    expect(handleSharedHistoryKey(new KeyboardEvent("keydown", { key: "z" }), { onUndo, onRedo })).toBe(false);
    expect(onUndo).not.toHaveBeenCalled(); expect(onRedo).not.toHaveBeenCalled();
  });
});

describe("editor clipboard transactions", () => {
  it("keeps the document when clipboard writing fails during Cut", async () => {
    const state = EditorState.create({ doc: "keep this", selection: { anchor: 0, head: 4 } });
    const dispatch = vi.fn();
    await expect(performClipboardAction("cut", () => state, { readText: vi.fn(), writeText: vi.fn(async () => { throw new Error("Clipboard denied"); }) }, dispatch)).rejects.toThrow("Clipboard denied");
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.doc.toString()).toBe("keep this");
  });

  it("refuses to cut an old selection after a new human edit during clipboard access", async () => {
    let state = EditorState.create({ doc: "keep this", selection: { anchor: 0, head: 4 } });
    let finishWrite!: () => void;
    const dispatch = vi.fn();
    const operation = performClipboardAction("cut", () => state, { readText: vi.fn(), writeText: () => new Promise<void>((resolve) => { finishWrite = resolve; }) }, dispatch);
    state = state.update({ changes: { from: state.doc.length, insert: " human edit" } }).state;
    finishWrite();
    await expect(operation).rejects.toThrow("document or selection changed");
    expect(state.doc.toString()).toBe("keep this human edit");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("cuts multiple selections with an invertible CodeMirror transaction", async () => {
    const original = EditorState.create({ doc: "one two\nthree", selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 13)]), extensions: [EditorState.allowMultipleSelections.of(true)] });
    let state = original;
    const writeText = vi.fn(async () => undefined);
    await performClipboardAction("cut", () => state, { readText: vi.fn(), writeText }, (transaction) => {
      expect(transaction.changes.invert(original.doc).apply(transaction.newDoc).toString()).toBe(original.doc.toString());
      state = transaction.state;
    });
    expect(writeText).toHaveBeenCalledWith("one\nthree");
    expect(state.doc.toString()).toBe(" two\n");
  });

  it("pastes into each selection and leaves empty clipboard reads untouched", async () => {
    let state = EditorState.create({ doc: "one two", selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]), extensions: [EditorState.allowMultipleSelections.of(true)] });
    await performClipboardAction("paste", () => state, { readText: async () => "x", writeText: vi.fn() }, (transaction) => { state = transaction.state; });
    expect(state.doc.toString()).toBe("x x");
    const dispatch = vi.fn();
    await performClipboardAction("paste", () => state, { readText: async () => "", writeText: vi.fn() }, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("CLI editor location", () => {
  it("uses one-based UTF-16 columns and clamps both coordinates", () => {
    const doc = Text.of(["alpha", "β😀xy"]);
    expect(revealPosition(doc, 2, 4)).toBe(9);
    expect(revealPosition(doc, 2, 999)).toBe(11);
    expect(revealPosition(doc, 999, 1)).toBe(6);
    expect(revealPosition(doc, 0, 0)).toBe(0);
  });
});
