// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, runScopeHandlers } from "@codemirror/view";
import { lineSelection } from "./line-selection";

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); document.body.replaceChildren(); });

const doc = "first line\n    indented word\n\nlast";
// first: 0..10, indented: 11..28 ("indented" 15..23, "word" 24..28), empty: 29, last: 30..34

/**
 * JSDOM has no layout: a pointer x maps straight to a document position and the
 * end of every line is at x = position, so x beyond it means "past the end".
 */
function setup() {
  const view = new EditorView({ parent: document.body.appendChild(document.createElement("div")), state: EditorState.create({ doc, extensions: [drawSelection(), lineSelection()] }) });
  views.push(view);
  const posAt = (x: number) => Math.max(0, Math.min(view.state.doc.length, Math.floor(x)));
  view.posAtCoords = ((coords: { x: number }) => posAt(coords.x)) as typeof view.posAtCoords;
  view.posAndSideAtCoords = ((coords: { x: number }) => ({ pos: posAt(coords.x), assoc: 1 })) as typeof view.posAndSideAtCoords;
  view.coordsAtPos = ((pos: number) => ({ left: pos, right: pos, top: 0, bottom: 10 })) as typeof view.coordsAtPos;
  view.focus();
  const click = (x: number, detail: number) => {
    for (let count = 1; count <= detail; count++) {
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: 5, button: 0, buttons: 1, detail: count, bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: 5, button: 0, buttons: 0, detail: count, bubbles: true, cancelable: true }));
    }
  };
  const main = () => { const { anchor, head } = view.state.selection.main; return { anchor, head, line: view.state.doc.lineAt(head).number }; };
  return { view, click, main };
}

describe("click selection keeps the head on the clicked line", () => {
  it("places a caret on a single click", () => {
    const { click, main } = setup();
    click(17, 1);
    expect(main()).toEqual({ anchor: 17, head: 17, line: 2 });
  });

  it("selects a word on a double click", () => {
    const { click, main } = setup();
    click(25, 2);
    expect(main()).toEqual({ anchor: 24, head: 28, line: 2 });
  });

  it("selects the line's text on a double click in leading whitespace or past the end", () => {
    const { click, main } = setup();
    click(12, 2);
    expect(main()).toEqual({ anchor: 11, head: 28, line: 2 });
    click(28.6, 2);
    expect(main()).toEqual({ anchor: 11, head: 28, line: 2 });
  });

  it("leaves a caret on an empty line for a double click", () => {
    const { click, main } = setup();
    click(29, 2);
    expect(main()).toEqual({ anchor: 29, head: 29, line: 3 });
  });

  it.each([
    [3, { anchor: 0, head: 10, line: 1 }],
    [20, { anchor: 11, head: 28, line: 2 }],
    [32, { anchor: 30, head: 34, line: 4 }],
  ])("selects only the line's text on a triple click at %d", (x, expected) => {
    const { click, main } = setup();
    click(x, 3);
    expect(main()).toEqual(expected);
  });

  it("extends by whole lines when dragging after a triple click, ending at a line end", () => {
    const { view, click, main } = setup();
    click(3, 2);
    view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { clientX: 3, clientY: 5, button: 0, buttons: 1, detail: 3, bubbles: true, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 20, clientY: 5, buttons: 1, bubbles: true }));
    expect(main()).toEqual({ anchor: 0, head: 28, line: 2 });
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 20, clientY: 5, buttons: 0, bubbles: true }));
  });

  it("selects the line with Mod-l, keeping the caret on it until pressed again", () => {
    const { view, main } = setup();
    view.dispatch({ selection: { anchor: 17 } });
    const key = () => runScopeHandlers(view, new KeyboardEvent("keydown", { key: "l", metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform) }), "editor");
    key();
    expect(main()).toEqual({ anchor: 11, head: 28, line: 2 });
    key();
    expect(main()).toEqual({ anchor: 11, head: 29, line: 3 });
  });
});
