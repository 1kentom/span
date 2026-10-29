// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, drawSelection } from "@codemirror/view";
import { indentGuides, activeLineLayer } from "./indent-guides";
import { TEXT_DRAG_HOLD_MS, selectionPointer } from "./selection-pointer";

beforeAll(() => {
  // CodeMirror asks the DOM selection whether the press is inside it; report one rectangle covering the line.
  Range.prototype.getClientRects = () => Object.assign([new DOMRect(0, 0, 1000, 20)], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); document.body.replaceChildren(); });

/** JSDOM has no layout, so a pointer x coordinate maps straight to a document position. */
function setup() {
  let clock = 0;
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "alpha beta gamma delta", selection: EditorSelection.single(0, 10), extensions: [drawSelection(), activeLineLayer(), indentGuides(), selectionPointer({ now: () => clock })] }),
  });
  views.push(view);
  const at = (x: number) => Math.max(0, Math.min(view.state.doc.length, Math.round(x)));
  view.posAtCoords = ((coords: { x: number }) => at(coords.x)) as typeof view.posAtCoords;
  view.posAndSideAtCoords = ((coords: { x: number }) => ({ pos: at(coords.x), assoc: 1 })) as typeof view.posAndSideAtCoords;
  view.focus();
  const mouse = (type: string, x: number, init: MouseEventInit = {}) => {
    const event = new MouseEvent(type, { clientX: x, clientY: 5, button: 0, buttons: type === "mouseup" ? 0 : 1, detail: 1, bubbles: true, cancelable: true, ...init });
    (type === "mousedown" || type === "dragstart" ? view.contentDOM : document).dispatchEvent(event);
    return event;
  };
  return { view, mouse, advance: (ms: number) => { clock += ms; } };
}

describe("pointer input over an existing selection", () => {
  it("collapses the selection to a caret on a plain click inside it", () => {
    const { view, mouse } = setup();
    mouse("mousedown", 4);
    mouse("mouseup", 4);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(4);
  });

  it("cancels the native text drag of a quick press-and-drag and starts a new selection", () => {
    const { view, mouse, advance } = setup();
    mouse("mousedown", 4);
    advance(40);
    const drag = mouse("dragstart", 6);
    expect(drag.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 4 });
    mouse("mousemove", 18);
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 18 });
    mouse("mouseup", 18);
    expect(view.state.selection.main).toMatchObject({ anchor: 4, head: 18 });
  });

  it("still lets selected text be dragged after a short hold, like VS Code", () => {
    const { view, mouse, advance } = setup();
    mouse("mousedown", 4);
    advance(TEXT_DRAG_HOLD_MS + 10);
    const drag = mouse("dragstart", 6);
    expect(drag.defaultPrevented).toBe(false);
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 10 });
  });

  it("draws guides and the active line below the selection layer, without pointer events", () => {
    const { view } = setup();
    const z = (name: string) => Number((view.dom.querySelector(`.${name}`) as HTMLElement).style.zIndex);
    expect(z("cm-indentGuideLayer")).toBeLessThan(z("cm-selectionLayer"));
    expect(z("cm-activeLineLayer")).toBeLessThan(z("cm-indentGuideLayer"));
    expect(getComputedStyle(view.dom.querySelector(".cm-indentGuideLayer")!).pointerEvents).toBe("none");
    expect(getComputedStyle(view.dom.querySelector(".cm-activeLineLayer")!).pointerEvents).toBe("none");
  });
});
