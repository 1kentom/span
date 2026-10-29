import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** How long the pointer must rest inside a selection before a drag moves the selected text. */
export const TEXT_DRAG_HOLD_MS = 350;

interface Press { time: number; pos: number }

/**
 * Pressing inside a selection used to hand the gesture to native text drag and
 * drop: the web view starts dragging the selected text on the first pixel of
 * movement, swallows the following mouse events, and the click neither moves
 * the caret nor starts a new selection. This keeps CodeMirror's mouse selection
 * in charge unless the pointer was held still first (VS Code's delayed drag), so
 * a click inside a selection collapses it and a quick drag selects anew.
 */
export function selectionPointer(options: { now?: () => number } = {}): Extension {
  const now = options.now ?? (() => performance.now());
  let press: Press | null = null;
  return Prec.highest(EditorView.domEventHandlers({
    mousedown(event, view) {
      press = null;
      if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      const main = view.state.selection.main;
      if (main.empty) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (pos < main.from || pos > main.to) return false;
      press = { time: now(), pos };
      return false;
    },
    mouseup() { press = null; return false; },
    dragstart(event, view) {
      const current = press;
      press = null;
      if (!current || now() - current.time >= TEXT_DRAG_HOLD_MS) return false;
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(current.pos), userEvent: "select.pointer" });
      return true;
    },
  }));
}
