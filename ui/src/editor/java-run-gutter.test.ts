// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { java } from "@codemirror/lang-java";
import { javaMainLine, javaRunGutter } from "./java-run-gutter";
const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });
const state = (doc: string) => EditorState.create({ doc, extensions: [java()] });
describe("Java main gutter", () => {
  it.each(["String[] args", "String args[]", "String... args", "final java.lang.String /* gap */ [] args"])("finds actual main with %s", parameter => {
    expect(javaMainLine(state(`package demo;\nclass Test {\n public static void main(${parameter}) {}\n}`))).toBe(3);
  });
  it.each([
    '// class Test { public static void main(String[] args) {} }',
    'class Test { String decoy = "public static void main(String[] args) {}"; }',
    'class Test { public void main(String[] args) {} }',
    'class Test { public static int main(String[] args) { return 0; } }',
    'class Test { public static void main(String[][] args) {} }',
    'class Test { public static void main(String args) {} }',
    'class Test { public static void main(String[] args, int extra) {} }',
    'class Test { class Inner { public static void main(String[] args) {} } }',
    'class First {} class Second { public static void main(String[] args) {} }',
    'class Test { public static void main(String[] args) {',
  ])("ignores invalid or nonlaunchable source: %s", source => { expect(javaMainLine(state(source))).toBeUndefined(); });
  it("creates an explicitly activated, labelled button beside main, updates after edits, and exposes only control gutters", async () => {
    const run = vi.fn();
    const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "class Test {\n public static void main(String[] args) {}\n}", extensions: [java(), lineNumbers(), javaRunGutter(run)] }) });
    views.push(view);
    await new Promise(resolve => setTimeout(resolve, 50));
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Run Java main"]');
    expect(button).not.toBeNull(); expect(run).not.toHaveBeenCalled();
    expect(button?.title).toContain("JDK 11+");
    expect(button?.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.querySelector(".cm-lineNumbers")?.getAttribute("aria-hidden")).toBe("true");
    button!.focus(); expect(document.activeElement).toBe(button);
    button!.click(); expect(run).toHaveBeenCalledOnce();
    const at = view.state.doc.toString().indexOf("main");
    view.dispatch({ changes: { from: at, to: at + 4, insert: "helper" } });
    expect(document.querySelector('[aria-label="Run Java main"]')).toBeNull();
  });
});
