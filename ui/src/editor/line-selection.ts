import { CharCategory, EditorSelection, Prec, type EditorState, type Extension, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, type Command, type MouseSelectionStyle } from "@codemirror/view";

/** A double click on whitespace, or past the end of the text, picks the line; on a word it picks the word. */
export function doubleClickRange(state: EditorState, pos: number, pastEnd: boolean): SelectionRange {
  const line = state.doc.lineAt(pos);
  if (line.length === 0) return EditorSelection.cursor(line.to);
  const offset = pos - line.from;
  if (!pastEnd) {
    const categorize = state.charCategorizer(pos);
    const after = offset < line.length ? categorize(line.text[offset]) : CharCategory.Space;
    const before = offset > 0 ? categorize(line.text[offset - 1]) : CharCategory.Space;
    const category = after !== CharCategory.Space ? after : before;
    if (category !== CharCategory.Space) {
      let from = offset, to = offset;
      if (after === category) while (to < line.length && categorize(line.text[to]) === category) to++;
      if (before === category || after === category) while (from > 0 && categorize(line.text[from - 1]) === category) from--;
      return EditorSelection.range(line.from + from, line.from + to);
    }
  }
  return EditorSelection.range(line.from, line.to);
}

/** A triple click selects the line's text without its line break, so the caret stays on the clicked line. */
export function lineRange(state: EditorState, pos: number): SelectionRange {
  const line = state.doc.lineAt(pos);
  return EditorSelection.range(line.from, line.to);
}

function pastLineEnd(view: EditorView, pos: number, clientX: number): boolean {
  const line = view.state.doc.lineAt(pos);
  if (pos !== line.to) return false;
  const coords = view.coordsAtPos(line.to, -1);
  return !coords || clientX > coords.left;
}

/**
 * Double and triple click selection that keeps the head on the clicked line.
 * CodeMirror's default triple click includes the line break, which put the
 * caret at the start of the next line. Dragging after the click extends by
 * words or whole lines from the original range.
 */
function lineAwareSelection(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  const type = event.detail;
  if (event.button !== 0 || (type !== 2 && type !== 3) || event.altKey) return null;
  const rangeAt = (clientX: number, clientY: number): SelectionRange => {
    const pos = view.posAtCoords({ x: clientX, y: clientY }, false);
    return type === 2 ? doubleClickRange(view.state, pos, pastLineEnd(view, pos, clientX)) : lineRange(view.state, pos);
  };
  let start = rangeAt(event.clientX, event.clientY);
  let startSelection = view.state.selection;
  return {
    update(update) {
      if (!update.docChanged) return;
      start = start.map(update.changes);
      startSelection = startSelection.map(update.changes);
    },
    get(current, extend, multiple) {
      const range = rangeAt(current.clientX, current.clientY);
      if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to));
      let next = range;
      if (range.from !== start.from || range.to !== start.to) {
        const from = Math.min(start.from, range.from), to = Math.max(start.to, range.to);
        next = range.from < start.from ? EditorSelection.range(to, from) : EditorSelection.range(from, to);
      }
      return multiple ? startSelection.addRange(next) : EditorSelection.create([next]);
    },
  };
}

/**
 * Select line (Mod-l). The first press selects the line's text with the caret
 * at its end; each further press extends to the end of the next line.
 */
export const selectLineKeepingCaret: Command = (view) => {
  const { state } = view;
  const ranges = state.selection.ranges.map((range) => {
    const first = state.doc.lineAt(range.from), last = state.doc.lineAt(range.to);
    const coversLines = !range.empty && range.from === first.from && range.to === last.to;
    if (!coversLines) return EditorSelection.range(first.from, last.to);
    const next = last.number < state.doc.lines ? state.doc.line(last.number + 1) : last;
    return EditorSelection.range(first.from, next.to);
  });
  view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: "select" });
  return true;
};

export function lineSelection(): Extension {
  return [
    EditorView.mouseSelectionStyle.of(lineAwareSelection),
    Prec.high(keymap.of([{ key: "Mod-l", run: selectLineKeepingCaret, preventDefault: true }])),
  ];
}
