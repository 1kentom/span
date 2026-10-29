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
  const source = "class Test {\n public static void main(String[] args) {}\n}";
  const mount = async (extensions: unknown[], doc = source, parent: HTMLElement = document.body) => {
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [java(), lineNumbers(), ...extensions as []] }) });
    views.push(view);
    await new Promise(resolve => setTimeout(resolve, 50));
    return view;
  };
  const cells = (view: EditorView) => [...view.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].filter(cell => cell.style.visibility !== "hidden");
  it("replaces the main line number with a labelled run button in the same gutter column", async () => {
    const run = vi.fn();
    const view = await mount([javaRunGutter(run)]);
    expect(view.dom.querySelectorAll(".cm-gutter")).toHaveLength(1);
    expect(view.dom.querySelector(".cm-java-run-gutter")).toBeNull();
    const [first, main, last] = cells(view);
    const button = main.querySelector<HTMLButtonElement>("button.cm-java-run-button");
    expect(button?.getAttribute("aria-label")).toBe("Run Java main");
    expect(button?.dataset.tooltip).toContain("JDK 11+");
    expect(main.textContent).toBe("");
    expect(/\d/.test(main.textContent ?? "")).toBe(false);
    expect(first.textContent).toBe("1"); expect(last.textContent).toBe("3");
    expect(view.dom.querySelectorAll(".cm-java-run-button")).toHaveLength(1);
  });
  it("keeps the number gutter the same size and class with and without the run icon", async () => {
    const plain = await mount([]);
    const withRun = await mount([javaRunGutter(() => undefined)]);
    const shape = (view: EditorView) => { const gutter = view.dom.querySelector<HTMLElement>(".cm-lineNumbers")!; const spacer = gutter.querySelector<HTMLElement>('.cm-gutterElement[style*="hidden"]'); return [gutter.className, spacer?.textContent, spacer?.style.cssText, view.dom.querySelectorAll(".cm-gutter").length]; };
    expect(shape(withRun)).toEqual(shape(plain));
  });
  it("runs once on click or keyboard activation, exposes only the control and shows the tooltip outside the code", async () => {
    const run = vi.fn();
    const view = await mount([javaRunGutter(run)]);
    const button = view.dom.querySelector<HTMLButtonElement>('[aria-label="Run Java main"]')!;
    expect(run).not.toHaveBeenCalled();
    expect(button.closest('[aria-hidden="true"]')).toBeNull();
    for (const cell of cells(view)) if (!cell.contains(button)) expect(cell.getAttribute("aria-hidden")).toBe("true");
    button.focus(); expect(document.activeElement).toBe(button);
    const tip = view.dom.querySelector<HTMLElement>('.cm-java-run-tooltip[role="tooltip"]');
    expect(tip?.textContent).toContain("JDK 11+");
    expect(button.getAttribute("aria-describedby")).toBe(tip?.id);
    expect(["above", "right"]).toContain(tip?.dataset.placement);
    button.click(); expect(run).toHaveBeenCalledOnce();
    expect(view.dom.querySelector(".cm-java-run-tooltip")).toBeNull();
    // Native buttons turn Enter and Space into click events; the handler must not double fire.
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(run).toHaveBeenCalledOnce();
  });
  it("restores the number after edits remove main", async () => {
    const view = await mount([javaRunGutter(() => undefined)]);
    const at = view.state.doc.toString().indexOf("main");
    view.dispatch({ changes: { from: at, to: at + 4, insert: "helper" } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(view.dom.querySelector('[aria-label="Run Java main"]')).toBeNull();
    expect(cells(view).map(cell => cell.textContent)).toEqual(["1", "2", "3"]);
  });
  it("draws one icon for a wrapped main line and keeps working with a multi-line selection", async () => {
    const run = vi.fn();
    const long = `class Test {\n public static void main(String[] args) { System.out.println("${"x".repeat(400)}"); }\n}`;
    const view = await mount([javaRunGutter(run), EditorView.lineWrapping], long);
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const buttons = view.dom.querySelectorAll<HTMLButtonElement>(".cm-java-run-button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].parentElement?.firstElementChild).toBe(buttons[0]);
    buttons[0].click();
    expect(run).toHaveBeenCalledOnce();
    expect(view.state.selection.main.to - view.state.selection.main.from).toBe(view.state.doc.length);
  });
});
