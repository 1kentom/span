// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo } from "@codemirror/commands";
import { CompletionContext } from "@codemirror/autocomplete";
import { ensureSyntaxTree, foldable, type LanguageSupport } from "@codemirror/language";
import { loadLanguage } from "./languages";
import { markdownKeymap } from "./markdown-editing";
import { indentListCommand, deleteListMarkupCommand } from "./markdown-lists";
import { decreaseHeading, increaseHeading, surroundSelection, toggleBlockquoteCommand, toggleOrderedListCommand } from "./markdown-format";
import { imageDirectory, imageFileName, markdownFiles, relativeLink, urlPasteSpec, type MarkdownFilePort } from "./markdown-paste";
import { markdownOutline } from "./markdown-outline";
import { markdownSnippetSource } from "./markdown-snippets";

let markdown: LanguageSupport;
const views: EditorView[] = [];
beforeAll(async () => {
  // JSDOM has no layout; CodeMirror measures text after async dispatches.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  markdown = await loadLanguage("markdown", "notes.md") as LanguageSupport;
});
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); document.body.replaceChildren(); });

/** `|` marks the caret (head); `^` marks the anchor of a selection. */
function editor(marked: string, extensions: Extension = []): EditorView {
  const anchorMark = marked.indexOf("^");
  const withoutAnchor = marked.replace("^", "");
  const head = withoutAnchor.indexOf("|");
  const doc = withoutAnchor.replace("|", "");
  const anchor = anchorMark < 0 ? head : anchorMark < head ? anchorMark : anchorMark - 1;
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(anchor, head),
      extensions: [history(), markdown, keymap.of([...historyKeymap, ...defaultKeymap]), extensions],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  views.push(view);
  return view;
}

/** The document with `|` at the head and `^` at the anchor when the selection is not empty. */
function show(view: EditorView): string {
  const { anchor, head } = view.state.selection.main;
  const doc = view.state.doc.toString();
  if (anchor === head) return doc.slice(0, head) + "|" + doc.slice(head);
  const marks = [{ at: anchor, mark: "^" }, { at: head, mark: "|" }].sort((a, b) => b.at - a.at);
  return marks.reduce((text, { at, mark }) => text.slice(0, at) + mark + text.slice(at), doc);
}

function press(view: EditorView, key: string, modifiers: { shift?: boolean; mod?: boolean; alt?: boolean } = {}): boolean {
  // JSDOM is not macOS, so CodeMirror's Mod is Ctrl here.
  const event = new KeyboardEvent("keydown", { key, shiftKey: modifiers.shift, ctrlKey: modifiers.mod, altKey: modifiers.alt, bubbles: true, cancelable: true });
  return runScopeHandlers(view, event, "editor");
}

function pasteEvent(data: { text?: string; files?: File[] }): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: data.files ?? [], getData: (type: string) => (type === "text/plain" ? data.text ?? "" : ""), types: ["text/plain"] } });
  return event;
}

describe("markdown list continuation on Enter", () => {
  it.each(["-", "*", "+"])("continues a %s bullet", (bullet) => {
    const view = editor(`${bullet} first|`);
    expect(press(view, "Enter")).toBe(true);
    expect(show(view)).toBe(`${bullet} first\n${bullet} |`);
  });

  it("continues a task list with an unchecked box", () => {
    const view = editor("- [x] done|");
    press(view, "Enter");
    expect(show(view)).toBe("- [x] done\n- [ ] |");
  });

  it("numbers the next ordered item and renumbers the items below", () => {
    const view = editor("1. a|\n2. b\n3. c");
    press(view, "Enter");
    expect(show(view)).toBe("1. a\n2. |\n3. b\n4. c");
  });

  it("keeps the `1)` delimiter", () => {
    const view = editor("1) a|");
    press(view, "Enter");
    expect(show(view)).toBe("1) a\n2) |");
  });

  it("moves the text after the caret into the new item", () => {
    const view = editor("- fo|o");
    press(view, "Enter");
    expect(show(view)).toBe("- fo\n- |o");
  });

  it("continues from the line end with Mod+Enter", () => {
    const view = editor("- fo|o");
    press(view, "Enter", { mod: true });
    expect(show(view)).toBe("- foo\n- |");
  });

  it("outdents an empty nested item", () => {
    const view = editor("- a\n  - |");
    press(view, "Enter");
    expect(show(view)).toBe("- a\n- |");
  });

  it("removes the marker of an empty top-level item", () => {
    const view = editor("- a\n- |");
    press(view, "Enter");
    expect(show(view)).toBe("- a\n|");
  });

  it("drops the checkbox of an empty task first", () => {
    const view = editor("- [ ] a\n- [ ] |");
    press(view, "Enter");
    expect(show(view)).toBe("- [ ] a\n- |");
  });

  it("continues a blockquote and ends it on a second empty `>`", () => {
    const view = editor("> quote|");
    press(view, "Enter");
    expect(show(view)).toBe("> quote\n> |");
    press(view, "Enter");
    expect(show(view)).toBe("> quote\n|");
  });

  it("inserts a plain newline with Shift+Enter", () => {
    const view = editor("- first|");
    expect(press(view, "Enter", { shift: true })).toBe(true);
    expect(view.state.doc.line(2).text).not.toMatch(/^\s*-/);
  });

  it("never continues inside fenced code", () => {
    const view = editor("```\n- item|\n```");
    press(view, "Enter");
    expect(show(view)).toBe("```\n- item\n|\n```");
  });

  it("leaves Enter alone on a plain paragraph", () => {
    const view = editor("plain|");
    press(view, "Enter");
    expect(show(view)).toBe("plain\n|");
  });
});

describe("markdown list Tab and Shift+Tab", () => {
  it("nests a bullet under the previous item by its marker width", () => {
    const view = editor("- a\n- |b");
    expect(press(view, "Tab")).toBe(true);
    expect(show(view)).toBe("- a\n  - |b");
  });

  it("nests an ordered item by the wider marker and renumbers both lists", () => {
    const view = editor("1. a\n2. |b\n3. c");
    press(view, "Tab");
    expect(show(view)).toBe("1. a\n   1. |b\n2. c");
  });

  it("outdents to the parent's indentation and renumbers", () => {
    const view = editor("1. a\n   1. |b\n2. c");
    expect(press(view, "Tab", { shift: true })).toBe(true);
    expect(show(view)).toBe("1. a\n2. |b\n3. c");
  });

  it("outdents a nested bullet", () => {
    const view = editor("- a\n  - |b");
    press(view, "Tab", { shift: true });
    expect(show(view)).toBe("- a\n- |b");
  });

  it("does not handle Tab outside a list marker", () => {
    expect(indentListCommand(editor("plain |text"))).toBe(false);
    expect(indentListCommand(editor("- item te|xt"))).toBe(false);
  });
});

describe("markdown Backspace on list markup", () => {
  it("removes a bare top-level marker", () => {
    const view = editor("- |");
    expect(press(view, "Backspace")).toBe(true);
    expect(show(view)).toBe("|");
  });

  it("removes the checkbox of a task first", () => {
    const view = editor("- [ ] |");
    press(view, "Backspace");
    expect(show(view)).toBe("- |");
  });

  it("outdents a nested marker", () => {
    const view = editor("- a\n  - |");
    press(view, "Backspace");
    expect(show(view)).toBe("- a\n- |");
  });

  it("drops one quote level", () => {
    const view = editor("> |");
    press(view, "Backspace");
    expect(show(view)).toBe("|");
  });

  it("leaves Backspace inside text alone", () => {
    expect(deleteListMarkupCommand(editor("- ab|c"))).toBe(false);
  });
});

describe("markdown formatting toggles", () => {
  it.each([
    ["b", { mod: true }, "a **^word|** b"],
    ["i", { mod: true }, "a *^word|* b"],
    ["x", { mod: true, shift: true }, "a ~~^word|~~ b"],
    ["e", { mod: true }, "a `^word|` b"],
  ] as const)("Mod+%s wraps the selection and keeps it selected", (key, modifiers, expected) => {
    const view = editor("a ^word| b");
    expect(press(view, key, modifiers)).toBe(true);
    expect(show(view)).toBe(expected);
  });

  it.each([
    ["b", "**^word|**"],
    ["i", "*^word|*"],
    ["e", "`^word|`"],
  ])("Mod+%s removes markers around the selection", (key, marked) => {
    const view = editor(marked);
    press(view, key, { mod: true });
    expect(show(view)).toBe("^word|");
  });

  it("removes markers when the selection includes them", () => {
    const view = editor("^**word**|");
    press(view, "b", { mod: true });
    expect(show(view)).toBe("^word|");
  });

  it("wraps the word at the caret", () => {
    const view = editor("wo|rd");
    press(view, "b", { mod: true });
    expect(show(view)).toBe("**wo|rd**");
  });

  it("toggles heading levels with Mod+Alt+digit", () => {
    const view = editor("|Title");
    expect(press(view, "2", { mod: true, alt: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("## Title");
    press(view, "2", { mod: true, alt: true });
    expect(view.state.doc.toString()).toBe("Title");
    press(view, "1", { mod: true, alt: true });
    expect(view.state.doc.toString()).toBe("# Title");
  });

  it("raises and lowers heading levels", () => {
    const view = editor("# T|");
    increaseHeading(view);
    expect(view.state.doc.toString()).toBe("## T");
    decreaseHeading(view);
    decreaseHeading(view);
    expect(view.state.doc.toString()).toBe("T");
  });

  it("toggles tasks with Alt+C", () => {
    const view = editor("- [ ] a|");
    expect(press(view, "c", { alt: true })).toBe(true);
    expect(view.state.doc.toString()).toBe("- [x] a");
    press(view, "c", { alt: true });
    expect(view.state.doc.toString()).toBe("- [ ] a");
    const bullet = editor("- a|");
    press(bullet, "c", { alt: true });
    expect(bullet.state.doc.toString()).toBe("- [ ] a");
    const plain = editor("plain|");
    press(plain, "c", { alt: true });
    expect(plain.state.doc.toString()).toBe("- [ ] plain");
  });

  it("toggles blockquotes and ordered lists", () => {
    const quote = editor("^a\nb|");
    toggleBlockquoteCommand(quote);
    expect(quote.state.doc.toString()).toBe("> a\n> b");
    toggleBlockquoteCommand(quote);
    expect(quote.state.doc.toString()).toBe("a\nb");
    const list = editor("^a\nb|");
    toggleOrderedListCommand(list);
    expect(list.state.doc.toString()).toBe("1. a\n2. b");
  });

  it("does not format inside fenced code", () => {
    const view = editor("```\n|Title\n```");
    press(view, "1", { mod: true, alt: true });
    expect(view.state.doc.toString()).toBe("```\nTitle\n```");
  });
});

describe("markdown keymap conflicts with workbench defaults", () => {
  it("binds free fallback keys for bold and inline code", () => {
    const keys = markdownKeymap.map((binding) => binding.key);
    // Mod+B and Mod+E are Toggle Project Panel and Toggle Files, handled by the window first (App.tsx capture listener).
    expect(keys).toEqual(expect.arrayContaining(["Mod-b", "Mod-e", "Mod-Shift-b", "Mod-Alt-e"]));
    const bold = editor("a ^word| b");
    expect(press(bold, "b", { mod: true, shift: true })).toBe(true);
    expect(show(bold)).toBe("a **^word|** b");
    const code = editor("a ^word| b");
    expect(press(code, "e", { mod: true, alt: true })).toBe(true);
    expect(show(code)).toBe("a `^word|` b");
  });
});

describe("markdown surround on typing", () => {
  function type(view: EditorView, text: string): boolean {
    const { from, to } = view.state.selection.main;
    return view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })));
  }

  it.each(["*", "_", "~", "`"])("wraps the selection in %s", (char) => {
    const view = editor("a ^b| c");
    expect(type(view, char)).toBe(true);
    expect(show(view)).toBe(`a ${char}^b|${char} c`);
  });

  it("does nothing without a selection, for other characters, or inside code", () => {
    expect(surroundSelection(editor("a |b").state, "*")).toBeNull();
    expect(surroundSelection(editor("a ^b|").state, "x")).toBeNull();
    expect(surroundSelection(editor("```\n^code|\n```").state, "*")).toBeNull();
  });
});

describe("markdown URL paste", () => {
  it("makes a link from the selection in one undo step", () => {
    const view = editor("see ^docs| here");
    view.contentDOM.dispatchEvent(pasteEvent({ text: "https://example.com/a" }));
    expect(show(view)).toBe("see [docs](https://example.com/a)| here");
    undo(view);
    expect(view.state.doc.toString()).toBe("see docs here");
  });

  it("does not link inside inline or fenced code, over a URL, or without a selection", () => {
    expect(urlPasteSpec(editor("`^code|`").state, "https://example.com")).toBeNull();
    expect(urlPasteSpec(editor("```\n^code|\n```").state, "https://example.com")).toBeNull();
    expect(urlPasteSpec(editor("^https://a.dev|").state, "https://example.com")).toBeNull();
    expect(urlPasteSpec(editor("text|").state, "https://example.com")).toBeNull();
    expect(urlPasteSpec(editor("^text|").state, "not a url")).toBeNull();
  });
});

describe("markdown image paste and drop", () => {
  const png = () => new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
  function port(existing: string[]): MarkdownFilePort & { save: ReturnType<typeof vi.fn> } {
    return {
      documentPath: "docs/notes.md",
      list: vi.fn(async () => existing),
      save: vi.fn(async (directory: string, fileName: string) => ({ path: `${directory}/${fileName}` })),
    };
  }

  it("saves a pasted image next to the document under a free name and links it", async () => {
    const files = port(["image.png", "readme.md"]);
    const view = editor("|", markdownFiles.of(files));
    view.contentDOM.dispatchEvent(pasteEvent({ files: [png()] }));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](image_1.png)"));
    expect(files.save).toHaveBeenCalledWith("docs", "image_1.png", btoa(String.fromCharCode(137, 80, 78, 71)));
    expect(view.state.selection.main.head).toBe(2);
  });

  it("links the name the save command actually wrote", async () => {
    const files = port([]);
    files.save.mockResolvedValueOnce({ path: "docs/image (1).png" });
    const view = editor("|", markdownFiles.of(files));
    view.contentDOM.dispatchEvent(pasteEvent({ files: [png()] }));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](image%20%281%29.png)"));
  });

  it("saves a dropped image", async () => {
    const files = port([]);
    const view = editor("|", markdownFiles.of(files));
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files: [png()], getData: () => "", types: ["Files"] } });
    view.contentDOM.dispatchEvent(event);
    await vi.waitFor(() => expect(files.save).toHaveBeenCalledWith("docs", "image.png", expect.any(String)));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](image.png)"));
  });

  it("computes names, folders and relative links", () => {
    expect(imageFileName([])).toBe("image.png");
    expect(imageFileName(["IMAGE.png", "image_1.png"], "png")).toBe("image_2.png");
    expect(imageFileName(["image.png"], "jpg")).toBe("image.jpg");
    expect(imageDirectory("notes.md")).toBe("");
    expect(imageDirectory("a/b/notes.md")).toBe("a/b");
    expect(relativeLink("a/b/notes.md", "a/b/image.png")).toBe("image.png");
    expect(relativeLink("a/notes.md", "c/image.png")).toBe("../c/image.png");
  });
});

describe("markdown folding", () => {
  function fold(view: EditorView, lineNumber: number) {
    const line = view.state.doc.line(lineNumber);
    return foldable(view.state, line.from, line.to);
  }

  it("folds a region to its matching end, nesting aware", () => {
    const view = editor("|<!-- #region outer -->\na\n<!-- #region inner -->\nb\n<!-- #endregion -->\nc\n<!-- #endregion -->\nafter");
    expect(fold(view, 1)).toEqual({ from: view.state.doc.line(1).to, to: view.state.doc.line(7).to });
    expect(fold(view, 3)).toEqual({ from: view.state.doc.line(3).to, to: view.state.doc.line(5).to });
  });

  it("folds a heading section up to the next heading of the same level", () => {
    const view = editor("|# A\ntext\n## sub\nmore\n# B\nend");
    expect(fold(view, 1)).toEqual({ from: view.state.doc.line(1).to, to: view.state.doc.line(4).to });
  });

  it("folds a fenced code block", () => {
    const view = editor("|```js\nconst a = 1;\nconst b = 2;\n```\n");
    const range = fold(view, 1);
    expect(range).not.toBeNull();
    expect(range!.from).toBe(view.state.doc.line(1).to);
  });
});

describe("markdown outline", () => {
  it("lists ATX and Setext headings, skipping fences and front matter", () => {
    const source = [
      "---", "title: # not a heading", "---",
      "# One #", "", "Two", "===", "", "Three", "---", "",
      "```", "# inside fence", "```", "", "~~~", "Fake", "---", "~~~",
      "- item", "---", "", "###### Six",
    ].join("\n");
    expect(markdownOutline(source)).toEqual([
      { level: 1, text: "One", line: 4 },
      { level: 1, text: "Two", line: 6 },
      { level: 2, text: "Three", line: 9 },
      { level: 6, text: "Six", line: 23 },
    ]);
  });

  it("accepts a CodeMirror Text", () => {
    expect(markdownOutline(EditorState.create({ doc: "# A\n## B" }).doc)).toEqual([{ level: 1, text: "A", line: 1 }, { level: 2, text: "B", line: 2 }]);
  });
});

describe("markdown snippets", () => {
  function complete(marked: string, explicit = false) {
    const view = editor(marked);
    return markdownSnippetSource(new CompletionContext(view.state, view.state.selection.main.head, explicit));
  }

  it("offers snippets after two letters of a snippet name", () => {
    expect(complete("bo|")?.options.map((option) => option.label)).toContain("bold");
    expect(complete("b|")).toBeNull();
    expect(complete("zz|")).toBeNull();
  });

  it("never triggers inside code", () => {
    expect(complete("```\nbo|\n```")).toBeNull();
    expect(complete("```\nbo|\n```", true)).toBeNull();
    expect(complete("`bo|`")).toBeNull();
  });
});
