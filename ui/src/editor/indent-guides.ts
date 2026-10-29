import { Prec, type Extension } from "@codemirror/state";
import { BlockType, EditorView, RectangleMarker, layer, type BlockInfo, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";

/** Read access to document lines, one-based like CodeMirror's `Text.line`. */
export interface GuideSource { lines: number; text: (line: number) => string }

export interface GuideOptions {
  tabSize: number;
  /** Width of one indentation level in columns. */
  unit: number;
  /** One-based line holding the main cursor. Its block guide is reported as active. */
  activeLine?: number;
  /** How far to look for context (blank-line neighbours, active block edges). Keeps large files cheap. */
  scanLimit?: number;
}

export interface GuideLine { line: number; columns: number[] }
/** The active block: its guide column and the first and last line it is drawn on. */
export interface ActiveGuide { column: number; from: number; to: number }
export interface GuideResult { lines: GuideLine[]; active: ActiveGuide | null }

/** Visual width of the leading whitespace, or null when the line is blank. */
export function leadingColumns(text: string, tabSize: number): number | null {
  let columns = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 32) columns++;
    else if (code === 9) columns += tabSize - (columns % tabSize);
    else return columns;
  }
  return null;
}

/**
 * Indent guides for lines `from..to`, following VS Code: a guide sits at every
 * indent level strictly inside the line's indentation (never at column 0), blank
 * lines continue the guides of the lines around them, and the active block is the
 * one the main cursor is in, opens, or closes.
 */
export function computeIndentGuides(source: GuideSource, from: number, to: number, options: GuideOptions): GuideResult {
  const unit = Math.max(1, Math.round(options.unit));
  const tabSize = Math.max(1, options.tabSize);
  const limit = options.scanLimit ?? 2000;
  const raw = new Map<number, number | null>();
  const effective = new Map<number, number>();
  const rawAt = (line: number): number | null => {
    let value = raw.get(line);
    if (value === undefined) { value = leadingColumns(source.text(line), tabSize); raw.set(line, value); }
    return value;
  };
  const neighbour = (line: number, step: 1 | -1): number => {
    for (let at = line + step, seen = 0; at >= 1 && at <= source.lines && seen < limit; at += step, seen++) {
      const value = rawAt(at);
      if (value !== null) return value;
    }
    return 0;
  };
  const indentAt = (line: number): number => {
    let value = effective.get(line);
    if (value !== undefined) return value;
    const own = rawAt(line);
    if (own !== null) value = own;
    else {
      const above = neighbour(line, -1), below = neighbour(line, 1);
      // One level past the shallower side, so the guide of the block being opened or closed continues.
      value = above === below ? above : Math.min(Math.min(above, below) + unit, Math.max(above, below));
    }
    effective.set(line, value);
    return value;
  };

  const first = Math.max(1, from), last = Math.min(source.lines, to);
  const lines: GuideLine[] = [];
  for (let line = first; line <= last; line++) {
    const indent = indentAt(line);
    const columns: number[] = [];
    for (let column = unit; column < indent; column += unit) columns.push(column);
    lines.push({ line, columns });
  }

  let active: ActiveGuide | null = null;
  const cursor = options.activeLine;
  if (cursor !== undefined && cursor >= 1 && cursor <= source.lines) {
    const own = indentAt(cursor);
    const blank = rawAt(cursor) === null;
    const next = cursor < source.lines ? indentAt(cursor + 1) : 0;
    const previous = cursor > 1 ? indentAt(cursor - 1) : 0;
    let column: number, start: number;
    if (!blank && next > own) { column = own; start = cursor + 1; }
    else if (!blank && previous > own) { column = own; start = cursor - 1; }
    else { column = Math.floor((own - 1) / unit) * unit; start = cursor; }
    if (column > 0 && indentAt(start) > column) {
      let top = start, bottom = start;
      while (top > 1 && start - top < limit && indentAt(top - 1) > column) top--;
      while (bottom < source.lines && bottom - start < limit && indentAt(bottom + 1) > column) bottom++;
      active = { column, from: top, to: bottom };
    }
  }
  return { lines, active };
}

function textBlock(block: BlockInfo): BlockInfo {
  if (!Array.isArray(block.type)) return block;
  return block.type.find((part) => part.type === BlockType.Text) ?? block;
}

function linePadding(view: EditorView): number {
  const line = view.contentDOM.querySelector(".cm-line");
  return line ? parseFloat(getComputedStyle(line).paddingLeft) || 0 : 0;
}

/** Layer origin, the same way CodeMirror positions its selection layer. */
function layerBase(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  return { left: rect.left - view.scrollDOM.scrollLeft * view.scaleX, top: rect.top - view.scrollDOM.scrollTop * view.scaleY };
}

const crisp = (value: number) => { const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1; return Math.round(value * ratio) / ratio; };

function guideMarkers(view: EditorView): LayerMarker[] {
  const blocks = view.viewportLineBlocks.map(textBlock);
  if (!blocks.length) return [];
  const { state } = view;
  const doc = state.doc;
  const firstLine = doc.lineAt(blocks[0].from).number;
  const lastLine = doc.lineAt(blocks[blocks.length - 1].from).number;
  const result = computeIndentGuides({ lines: doc.lines, text: (line) => doc.line(line).text }, firstLine, lastLine, {
    tabSize: state.tabSize,
    unit: getIndentUnit(state),
    activeLine: doc.lineAt(state.selection.main.head).number,
  });
  const byLine = new Map(result.lines.map((entry) => [entry.line, entry.columns]));
  const base = layerBase(view);
  const content = view.contentDOM.getBoundingClientRect();
  const origin = (content.left - base.left) / view.scaleX + linePadding(view);
  const top = (view.documentTop - base.top) / view.scaleY;
  const width = view.defaultCharacterWidth;
  const markers: LayerMarker[] = [];
  const open = new Map<number, { top: number; bottom: number; active: boolean }>();
  const close = (column: number) => {
    const run = open.get(column);
    if (!run) return;
    open.delete(column);
    markers.push(new RectangleMarker(run.active ? "cm-indent-guide cm-indent-guide-active" : "cm-indent-guide", crisp(origin + column * width), run.top, 1, run.bottom - run.top));
  };
  for (const block of blocks) {
    const line = doc.lineAt(block.from).number;
    const columns = byLine.get(line) ?? [];
    const blockTop = top + block.top, blockBottom = top + block.bottom;
    const active = result.active && line >= result.active.from && line <= result.active.to ? result.active.column : -1;
    for (const column of [...open.keys()]) {
      const run = open.get(column)!;
      if (!columns.includes(column) || Math.abs(run.bottom - blockTop) > 0.5 || run.active !== (column === active)) close(column);
    }
    for (const column of columns) {
      const run = open.get(column);
      if (run) run.bottom = blockBottom;
      else open.set(column, { top: blockTop, bottom: blockBottom, active: column === active });
    }
  }
  for (const column of [...open.keys()]) close(column);
  return markers;
}

const unitChanged = (update: ViewUpdate) => getIndentUnit(update.state) !== getIndentUnit(update.startState) || update.state.tabSize !== update.startState.tabSize;

/** Indent guides drawn in a layer below the selection, so text, selection and caret always sit on top. */
export function indentGuides(): Extension {
  return [
    Prec.low(layer({
      above: false,
      class: "cm-indentGuideLayer",
      markers: guideMarkers,
      update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || unitChanged(update),
    })),
    EditorView.baseTheme({ ".cm-indentGuideLayer": { pointerEvents: "none" } }),
  ];
}

function activeLineMarkers(view: EditorView): LayerMarker[] {
  const base = layerBase(view);
  const content = view.contentDOM.getBoundingClientRect();
  const left = (content.left - base.left) / view.scaleX;
  const width = content.width / view.scaleX;
  const top = (view.documentTop - base.top) / view.scaleY;
  const seen = new Set<number>();
  const markers: LayerMarker[] = [];
  for (const range of view.state.selection.ranges) {
    // VS Code only highlights the current line while the selection is empty.
    if (!range.empty) continue;
    const block = view.lineBlockAt(range.head);
    if (seen.has(block.from)) continue;
    seen.add(block.from);
    markers.push(new RectangleMarker("cm-activeLineBackground", left, top + block.top, width, block.height));
  }
  return markers;
}

/** Current line highlight for empty cursors, drawn beneath guides and selection. */
export function activeLineLayer(): Extension {
  return [
    Prec.lowest(layer({ above: false, class: "cm-activeLineLayer", markers: activeLineMarkers, update: (update) => update.docChanged || update.selectionSet || update.viewportChanged })),
    EditorView.baseTheme({ ".cm-activeLineLayer": { pointerEvents: "none" } }),
  ];
}
