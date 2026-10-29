// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";
import { EditorSelection, Text } from "@codemirror/state";
import { getIndentUnit, language as languageFacet } from "@codemirror/language";
import { undo } from "@codemirror/commands";
import Editor from "../components/Editor";
import { detectIndentation } from "./indentation";

const dispose: (() => void)[] = [];
beforeAll(() => {
  // JSDOM has no layout; these tests cover document edits, not geometry.
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { dispose.splice(0).forEach((close) => close()); document.body.replaceChildren(); });

/** Mounts the real Editor. `‸` marks cursors; `«` and `»` mark one selection. */
async function editor(marked: string, path: string, language: string, tabSize = 2) {
  const cursors: number[] = [];
  let text = "", anchor = -1, head = -1;
  for (const character of marked) {
    if (character === "‸") cursors.push(text.length);
    else if (character === "«") anchor = text.length;
    else if (character === "»") head = text.length;
    else text += character;
  }
  const parent = document.createElement("div"); document.body.append(parent);
  dispose.push(render(() => <Editor buffer={{ path, text, revision: 0, savedRevision: 0, language }} tabSize={tabSize} onEdit={() => {}} onSave={() => {}} />, parent));
  await vi.waitFor(() => expect(parent.querySelector(".cm-editor")).not.toBeNull());
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  if (language !== "plaintext") await vi.waitFor(() => expect(view.state.facet(languageFacet)).not.toBeNull());
  const selection = anchor >= 0 ? EditorSelection.single(anchor, head) : EditorSelection.create(cursors.map((at) => EditorSelection.cursor(at)));
  view.dispatch({ selection }); view.focus();
  return view;
}

const keys: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Delete: 46 };
function press(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, keyCode: keys[key] ?? key.charCodeAt(0), bubbles: true, cancelable: true, ...init }));
}
function type(view: EditorView, text: string) {
  // What the input handler does for typed text, including input handlers such as indentOnInput.
  for (const character of text) {
    const { from, to } = view.state.selection.main;
    if (!view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, character, () => view.state.update({ changes: { from, to, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" })))) {
      view.dispatch({ changes: { from, to, insert: character }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    }
  }
}
/** The document with `‸` at every cursor. */
function marked(view: EditorView) {
  let text = view.state.doc.toString();
  for (const range of [...view.state.selection.ranges].sort((a, b) => b.head - a.head)) text = text.slice(0, range.head) + "‸" + text.slice(range.head);
  return text;
}

const yaml = [
  "jobs:",
  "  scan:",
  "    runs-on: ubuntu-latest",
  "    env:",
  "      POSTGRES_USER: postgres",
  "      POSTGRES_PASSWORD: postgres",
].join("\n");

describe("Enter inherits indentation", () => {
  it("keeps the previous line's indentation in plain text", async () => {
    const view = await editor("first\n    second‸", "notes.txt", "plaintext");
    press(view, "Enter");
    expect(marked(view)).toBe("first\n    second\n    ‸");
  });

  it("indents one unit after an opening brace, using the file's indentation", async () => {
    const view = await editor("class A {\n    void run() {‸\n    }\n}", "A.java", "java");
    press(view, "Enter");
    expect(marked(view)).toBe("class A {\n    void run() {\n        ‸\n    }\n}");
  });

  it.each([
    ["{", "}", "A.java", "java"],
    ["(", ")", "a.ts", "typescript"],
    ["[", "]", "a.ts", "typescript"],
    ["{", "}", "notes.txt", "plaintext"],
  ])("splits %s%s onto three lines with the caret on an indented blank line (%s)", async (open, close, path, language) => {
    const view = await editor(`x = ${open}‸${close}`, path, language);
    press(view, "Enter");
    expect(marked(view)).toBe(`x = ${open}\n  ‸\n${close}`);
  });

  it("splits an HTML tag pair", async () => {
    const view = await editor("<div>‸</div>", "a.html", "html");
    press(view, "Enter");
    expect(marked(view)).toBe("<div>\n  ‸\n</div>");
  });

  it("aligns arguments inside open parentheses", async () => {
    const view = await editor("call(first,‸", "a.ts", "typescript");
    press(view, "Enter");
    expect(marked(view)).toBe("call(first,\n     ‸");
  });

  it("indents after a Python colon", async () => {
    const view = await editor("def run():‸", "a.py", "python", 4);
    press(view, "Enter");
    expect(marked(view)).toBe("def run():\n    ‸");
  });

  it("keeps the block's indentation across blank lines", async () => {
    const view = await editor("function run() {\n  one();\n\n‸\n}", "a.ts", "typescript");
    press(view, "Enter");
    expect(marked(view)).toBe("function run() {\n  one();\n\n\n  ‸\n}");
  });

  it("uses tabs in a tab-indented file even when the setting says spaces", async () => {
    const view = await editor("fn main() {\n\tlet a = 1;‸\n}", "a.rs", "rust", 4);
    expect(getIndentUnit(view.state)).toBe(4);
    press(view, "Enter");
    expect(marked(view)).toBe("fn main() {\n\tlet a = 1;\n\t‸\n}");
  });

  it("dedents a closing brace typed at the start of an indented line", async () => {
    const view = await editor("if (a) {\n  b();\n  ‸", "a.ts", "typescript");
    type(view, "}");
    expect(view.state.doc.toString()).toBe("if (a) {\n  b();\n}");
  });

  it("dedents a closing brace in a language without indent rules", async () => {
    const view = await editor("a {\n    b\n    ‸", "notes.txt", "plaintext");
    type(view, "}");
    expect(view.state.doc.toString()).toBe("a {\n    b\n}");
  });
});

describe("YAML", () => {
  it("indents one unit after `env:` so the caret lands where POSTGRES_USER starts", async () => {
    const view = await editor(yaml.replace("    env:", "    env:‸"), "backend-security.yml", "yaml");
    press(view, "Enter");
    expect(marked(view)).toBe(yaml.replace("    env:", "    env:\n      ‸"));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(yaml);
  });

  it("keeps the indentation after a key with a value", async () => {
    const view = await editor(yaml.replace("POSTGRES_USER: postgres", "POSTGRES_USER: postgres‸"), "a.yml", "yaml");
    press(view, "Enter");
    expect(marked(view)).toBe(yaml.replace("POSTGRES_USER: postgres", "POSTGRES_USER: postgres\n      ‸"));
  });

  it.each([
    ["steps:\n  - name: checkout‸", "steps:\n  - name: checkout\n    ‸"],
    ["steps:\n  - with:‸", "steps:\n  - with:\n      ‸"],
    ["  script: |‸", "  script: |\n    ‸"],
    ["  script: >-‸", "  script: >-\n    ‸"],
    ["  list: [‸", "  list: [\n    ‸"],
    ["  map: {‸", "  map: {\n    ‸"],
  ])("handles list items, block scalars and flow collections: %j", async (input, expected) => {
    const view = await editor(input, "a.yaml", "yaml");
    press(view, "Enter");
    expect(marked(view)).toBe(expected);
  });
});

describe("Backspace and Tab", () => {
  it("removes one indent unit in leading whitespace before text", async () => {
    const view = await editor("a {\n    b {\n        ‸c\n    }\n}", "notes.txt", "plaintext", 2);
    press(view, "Backspace");
    expect(marked(view)).toBe("a {\n    b {\n    ‸c\n    }\n}");
  });

  it("deletes a whitespace-only line in one press and puts the caret after `env:`, undoable in one step", async () => {
    const before = yaml.replace("    env:", "    env:\n      ");
    const view = await editor(yaml.replace("    env:", "    env:\n   ‸   "), "backend-security.yml", "yaml");
    press(view, "Backspace");
    expect(marked(view)).toBe(yaml.replace("    env:", "    env:‸"));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("deletes whitespace-only lines under every cursor, with tabs or spaces", async () => {
    const view = await editor("a:\n\t\t‸\nb:\n    ‸\nc", "a.yml", "yaml");
    press(view, "Backspace");
    expect(marked(view)).toBe("a:‸\nb:‸\nc");
  });

  it("keeps forward Delete joining the next line", async () => {
    const view = await editor("a:\n  ‸\nb", "a.yml", "yaml");
    press(view, "Delete");
    expect(view.state.doc.toString()).toBe("a:\n  b");
  });

  it("indents and outdents every selected line with Tab and Shift+Tab", async () => {
    const view = await editor("«one\ntwo»\nthree", "notes.txt", "plaintext", 4);
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("    one\n    two\nthree");
    press(view, "Tab", { shiftKey: true });
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree");
  });
});

describe("detectIndentation", () => {
  const doc = (text: string) => Text.of(text.split("\n"));
  it("detects tabs, space widths, and falls back without evidence", () => {
    expect(detectIndentation(doc("a\n\tb\n\t\tc"))).toEqual({ source: "tabs", width: 0 });
    expect(detectIndentation(doc("a {\n    b {\n        c\n    }\n}"))).toEqual({ source: "spaces", width: 4 });
    expect(detectIndentation(doc("a:\n  b:\n    c: 1\n  d: 2"))).toEqual({ source: "spaces", width: 2 });
    expect(detectIndentation(doc("one\ntwo"))).toEqual({ source: "default", width: 0 });
  });

  it("ignores block comment alignment", () => {
    expect(detectIndentation(doc("/**\n * doc\n * more\n */\nclass A {\n    b;\n}"))).toEqual({ source: "spaces", width: 4 });
  });
});
