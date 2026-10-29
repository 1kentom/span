import { ChangeSet, EditorSelection, countColumn, type ChangeSpec, type EditorState, type SelectionRange, type Text, type TransactionSpec } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import type { Command } from "@codemirror/view";
import { inCode, isMarkdown } from "./markdown-context";

/** Block markup at the start of one line: a blockquote prefix, then optionally a list marker and a task checkbox. */
export interface LineMarkup {
  /** Indentation and blockquote markers, kept as they are (`"> "`, `"  > > "`, or empty). */
  lead: string;
  /** Whitespace between `lead` and the list marker. */
  itemIndent: string;
  bullet: string | null;
  number: number | null;
  delimiter: "." | ")" | null;
  /** Whitespace after the marker. */
  spacing: string;
  /** `"[ ]"` or `"[x]"`. */
  task: string | null;
  taskSpacing: string;
  /** Line offset where the marker starts. */
  markerFrom: number;
  /** Line offset just after marker and spacing. */
  markerTo: number;
  /** Line offset where the item's text starts (after any checkbox). */
  contentFrom: number;
}

const QUOTE = /^[ \t]*(?:>[ \t]?)+/;
const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))(?:([ \t]+)|$)/;
const TASK = /^\[([ xX])\](?:([ \t]+)|$)/;
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Parses list and blockquote markup at the start of a line. Returns null for lines without either. */
export function parseLineMarkup(text: string): LineMarkup | null {
  const lead = QUOTE.exec(text)?.[0] ?? "";
  const rest = text.slice(lead.length);
  const item = RULE.test(rest) ? null : ITEM.exec(rest);
  if (!item) {
    if (!lead) return null;
    return { lead, itemIndent: "", bullet: null, number: null, delimiter: null, spacing: "", task: null, taskSpacing: "", markerFrom: lead.length, markerTo: lead.length, contentFrom: lead.length };
  }
  const markerFrom = lead.length + item[1].length;
  const markerTo = lead.length + item[0].length;
  const task = item[5] !== undefined || markerTo === text.length ? TASK.exec(text.slice(markerTo)) : null;
  return {
    lead, itemIndent: item[1], bullet: item[2] ?? null, number: item[3] !== undefined ? Number(item[3]) : null, delimiter: (item[4] as "." | ")" | undefined) ?? null,
    spacing: item[5] ?? "", task: task ? task[0].slice(0, 3) : null, taskSpacing: task?.[2] ?? "", markerFrom, markerTo, contentFrom: markerTo + (task ? task[0].length : 0),
  };
}

const isItem = (markup: LineMarkup | null): boolean => Boolean(markup && (markup.bullet || markup.number !== null));
const column = (text: string, tabSize: number) => countColumn(text, tabSize);
const marker = (markup: LineMarkup, number = markup.number) => markup.bullet ?? `${number}${markup.delimiter}`;
/** Width of `- ` or `1. `: how far a child item is indented under this one. */
const markerWidth = (markup: LineMarkup) => markup.markerTo - markup.markerFrom || marker(markup).length + 1;

/** The nearest list item above `lineNumber` that is less indented (its parent), or null. */
function parentItem(doc: Text, lineNumber: number, markup: LineMarkup, tabSize: number): LineMarkup | null {
  const own = column(markup.itemIndent, tabSize);
  for (let number = lineNumber - 1; number >= 1; number--) {
    const text = doc.line(number).text;
    if (!text.trim()) continue;
    const other = parseLineMarkup(text);
    if (other && isItem(other) && other.lead === markup.lead) {
      if (column(other.itemIndent, tabSize) < own) return other;
      continue;
    }
    if (column(/^[ \t]*/.exec(text.slice(markup.lead.length))![0], tabSize) < own) return null;
  }
  return null;
}

/** The nearest item above at the same level, without leaving the list. */
function previousSibling(doc: Text, lineNumber: number, markup: LineMarkup, tabSize: number): LineMarkup | null {
  const own = column(markup.itemIndent, tabSize);
  for (let number = lineNumber - 1; number >= 1; number--) {
    const text = doc.line(number).text;
    if (!text.trim()) continue;
    const other = parseLineMarkup(text);
    if (other && isItem(other) && other.lead === markup.lead) {
      const level = column(other.itemIndent, tabSize);
      if (level === own) return other;
      if (level < own) return null;
      continue;
    }
    if (column(/^[ \t]*/.exec(text.slice(markup.lead.length))![0], tabSize) <= own) return null;
  }
  return null;
}

/** Line numbers of the ordered list items that share the list of `lineNumber`, in order. */
export function orderedListItems(doc: Text, lineNumber: number, tabSize: number): number[] {
  const markup = parseLineMarkup(doc.line(lineNumber).text);
  if (!markup || !isItem(markup) || markup.number === null) return [];
  const own = column(markup.itemIndent, tabSize);
  const belongs = (number: number): "item" | "skip" | "stop" => {
    const text = doc.line(number).text;
    if (!text.trim()) return "skip";
    const other = parseLineMarkup(text);
    if (other && isItem(other) && other.lead === markup.lead) {
      const level = column(other.itemIndent, tabSize);
      if (level > own) return "skip";
      return level === own && other.number !== null && other.delimiter === markup.delimiter ? "item" : "stop";
    }
    return column(/^[ \t]*/.exec(text.slice(Math.min(text.length, markup.lead.length)))![0], tabSize) > own && text.startsWith(markup.lead) ? "skip" : "stop";
  };
  const items = [lineNumber];
  for (let number = lineNumber - 1; number >= 1; number--) {
    const kind = belongs(number);
    if (kind === "stop") break;
    if (kind === "item") items.unshift(number);
  }
  for (let number = lineNumber + 1; number <= doc.lines; number++) {
    const kind = belongs(number);
    if (kind === "stop") break;
    if (kind === "item") items.push(number);
  }
  return items;
}

/** True when a list of two or more items repeats one number (`1.` on every line); such lists keep that style. */
function lazyNumbering(doc: Text, items: number[]): boolean {
  if (items.length < 2) return false;
  const first = parseLineMarkup(doc.line(items[0]).text)!.number;
  return items.every((number) => parseLineMarkup(doc.line(number).text)!.number === first);
}

/** Changes that renumber every ordered list touching the given lines, keeping each list's first number. */
export function renumberChanges(doc: Text, lineNumbers: Iterable<number>, tabSize: number): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const done = new Set<number>();
  for (const candidate of lineNumbers) {
    for (const lineNumber of [candidate - 1, candidate, candidate + 1]) {
      if (lineNumber < 1 || lineNumber > doc.lines) continue;
      const items = orderedListItems(doc, lineNumber, tabSize);
      if (!items.length || done.has(items[0])) continue;
      done.add(items[0]);
      if (lazyNumbering(doc, items)) continue;
      let next = parseLineMarkup(doc.line(items[0]).text)!.number!;
      for (const number of items) {
        const line = doc.line(number);
        const markup = parseLineMarkup(line.text)!;
        const digits = String(markup.number);
        const from = line.from + markup.markerFrom;
        if (line.text.slice(markup.markerFrom, markup.markerFrom + digits.length) !== String(next)) changes.push({ from, to: from + line.text.slice(markup.markerFrom).search(/[.)]/), insert: String(next) });
        next++;
      }
    }
  }
  return changes;
}

/** Applies `changes` and, in the same transaction, renumbers the ordered lists around `lines` (numbers in the new document). */
function withRenumbering(state: EditorState, changes: ChangeSet, selection: EditorSelection, lines: (doc: Text) => number[], userEvent: string): TransactionSpec {
  const doc = changes.apply(state.doc);
  const followUp = ChangeSet.of(renumberChanges(doc, lines(doc), state.tabSize), doc.length);
  return { changes: changes.compose(followUp), selection: selection.map(followUp, 1), scrollIntoView: true, userEvent };
}

type RangeEdit = { changes: ChangeSpec[]; range: SelectionRange; renumber: number[] };

/** Builds one edit per range; ranges without markup get a plain newline when `requireAll` is false. */
function rangeResult(state: EditorState, build: (range: SelectionRange) => RangeEdit | null, userEvent: string, requireAll = true): TransactionSpec | null {
  const results = state.selection.ranges.map(build);
  if (requireAll ? results.some((result) => !result) : results.every((result) => !result)) return null;
  const renumberAt: number[] = [];
  let index = 0;
  const spec = state.changeByRange((range) => {
    const result = results[index++];
    if (result) { renumberAt.push(...result.renumber); return { changes: result.changes, range: result.range }; }
    const insert = state.lineBreak + /^[ \t]*/.exec(state.doc.lineAt(range.from).text)![0];
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  return withRenumbering(state, spec.changes, spec.selection, (doc) => renumberAt.map((pos) => doc.lineAt(spec.changes.mapPos(pos, 1)).number), userEvent);
}

/** The line that replaces an item whose text is empty when Enter is pressed on it (outdent, drop the checkbox, or end the list). */
function emptyItemReplacement(state: EditorState, lineNumber: number, markup: LineMarkup): string {
  if (markup.task) return markup.lead + markup.itemIndent + marker(markup) + (markup.spacing || " ");
  if (isItem(markup) && markup.itemIndent) {
    const parent = parentItem(state.doc, lineNumber, markup, state.tabSize);
    if (parent) return markup.lead + parent.itemIndent + (parent.number !== null ? `${parent.number + 1}${parent.delimiter}` : marker(markup)) + (markup.spacing || " ");
    const unit = state.facet(indentUnit);
    return markup.lead + removeColumns(markup.itemIndent, column(unit, state.tabSize), state.tabSize) + marker(markup) + (markup.spacing || " ");
  }
  if (isItem(markup)) return markup.lead;
  // An empty quote line drops one level of quoting.
  const reduced = markup.lead.replace(/>[ \t]?$/, "");
  return reduced.trim() ? reduced : "";
}

/** Removes up to `columns` columns of leading whitespace. */
export function removeColumns(text: string, columns: number, tabSize: number): string {
  let index = 0, width = 0;
  while (index < text.length && width < columns && (text[index] === " " || text[index] === "\t")) {
    width = text[index] === "\t" ? width + tabSize - (width % tabSize) : width + 1;
    index++;
  }
  return text.slice(index);
}

/**
 * Enter in a list or blockquote, like Markdown All in One and Zed: continue the marker (next number, unchecked
 * box, same bullet, `> `), move the text after the caret to the new item and renumber the list. On an item with no
 * text: drop the checkbox, outdent a nested item, or remove the marker. `atLineEnd` continues from the end of the
 * line wherever the caret is (Mod+Enter). Returns null when no cursor is on list or quote markup.
 */
export function continueMarkup(state: EditorState, atLineEnd = false): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  return rangeResult(state, (range) => {
    if (!range.empty && !atLineEnd) return null;
    const line = state.doc.lineAt(range.head);
    const pos = atLineEnd ? line.to : range.head;
    const markup = parseLineMarkup(line.text);
    if (!markup || inCode(state, pos)) return null;
    const offset = pos - line.from;
    if (offset < markup.contentFrom) return null;
    const content = line.text.slice(markup.contentFrom);
    if (!content.trim()) {
      const replacement = emptyItemReplacement(state, line.number, markup);
      return { changes: [{ from: line.from, to: line.to, insert: replacement }], range: EditorSelection.cursor(line.from + replacement.length), renumber: [line.from] };
    }
    let next = markup.number;
    if (next !== null) next = lazyNumbering(state.doc, orderedListItems(state.doc, line.number, state.tabSize)) ? next : next + 1;
    const prefix = isItem(markup) ? markup.lead + markup.itemIndent + marker(markup, next) + (markup.spacing || " ") + (markup.task ? `[ ]${markup.taskSpacing || " "}` : "") : markup.lead.replace(/>$/, "> ");
    const after = /^[ \t]*/.exec(line.text.slice(offset))![0].length;
    const insert = state.lineBreak + prefix;
    return { changes: [{ from: pos, to: pos + after, insert }], range: EditorSelection.cursor(pos + insert.length), renumber: [pos] };
  }, "input", false);
}

/** Lines touched by a range; a selection ending at a line start leaves that line out. */
function touchedLines(state: EditorState, range: SelectionRange): number[] {
  const first = state.doc.lineAt(range.from).number;
  let last = state.doc.lineAt(range.to).number;
  if (!range.empty && last > first && state.doc.line(last).from === range.to) last--;
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Tab and Shift+Tab apply when every cursor sits in a list marker or every selection covers a list item. */
function listTargets(state: EditorState): number[] | null {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (inCode(state, range.head)) return null;
    if (range.empty) {
      const markup = parseLineMarkup(line.text);
      if (!markup || !isItem(markup) || range.head - line.from > markup.contentFrom) return null;
      lines.add(line.number);
      continue;
    }
    const touched = touchedLines(state, range);
    if (!touched.some((number) => isItem(parseLineMarkup(state.doc.line(number).text)))) return null;
    for (const number of touched) if (state.doc.line(number).text.trim()) lines.add(number);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Tab on list items: nest under the previous item by its marker width (or one tab), then renumber. */
export function indentListItems(state: EditorState): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const lines = listTargets(state);
  if (!lines?.length) return null;
  const firstItem = lines.find((number) => isItem(parseLineMarkup(state.doc.line(number).text)))!;
  const firstMarkup = parseLineMarkup(state.doc.line(firstItem).text)!;
  const unit = state.facet(indentUnit);
  const sibling = previousSibling(state.doc, firstItem, firstMarkup, state.tabSize);
  const insert = unit === "\t" ? "\t" : " ".repeat(sibling ? markerWidth(sibling) : unit.length);
  const specs: ChangeSpec[] = [];
  for (const number of lines) {
    const line = state.doc.line(number);
    const markup = parseLineMarkup(line.text);
    const at = line.from + (markup?.lead.length ?? 0);
    specs.push({ from: at, insert });
    // An ordered item that starts a new nested list starts at 1.
    if (number === firstItem && firstMarkup.number !== null && firstMarkup.number !== 1 && !nestedSiblingAbove(state, number, firstMarkup, column(firstMarkup.itemIndent + insert, state.tabSize))) {
      const from = line.from + firstMarkup.markerFrom;
      specs.push({ from, to: from + String(firstMarkup.number).length, insert: "1" });
    }
  }
  const changes = state.changes(specs);
  return withRenumbering(state, changes, state.selection.map(changes, 1), (doc) => lines.flatMap((number) => [number, Math.max(1, number - 1)]).filter((number) => number <= doc.lines), "input.indent");
}

function nestedSiblingAbove(state: EditorState, lineNumber: number, markup: LineMarkup, level: number): boolean {
  for (let number = lineNumber - 1; number >= 1; number--) {
    const text = state.doc.line(number).text;
    if (!text.trim()) continue;
    const other = parseLineMarkup(text);
    if (!other || !isItem(other) || other.lead !== markup.lead) return false;
    const otherLevel = column(other.itemIndent, state.tabSize);
    if (otherLevel === level) return other.number !== null;
    if (otherLevel < level) return false;
  }
  return false;
}

/** Shift+Tab on list items: move to the parent's indentation (or one unit less), carrying selected child lines along. */
export function outdentListItems(state: EditorState): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const lines = listTargets(state);
  if (!lines?.length) return null;
  const firstItem = lines.find((number) => isItem(parseLineMarkup(state.doc.line(number).text)))!;
  const firstMarkup = parseLineMarkup(state.doc.line(firstItem).text)!;
  const own = column(firstMarkup.itemIndent, state.tabSize);
  if (!own) return null;
  const parent = parentItem(state.doc, firstItem, firstMarkup, state.tabSize);
  const delta = parent ? own - column(parent.itemIndent, state.tabSize) : Math.min(own, column(state.facet(indentUnit), state.tabSize));
  const specs: ChangeSpec[] = [];
  for (const number of lines) {
    const line = state.doc.line(number);
    const lead = parseLineMarkup(line.text)?.lead ?? "";
    const indent = /^[ \t]*/.exec(line.text.slice(lead.length))![0];
    const kept = removeColumns(indent, delta, state.tabSize);
    if (kept.length !== indent.length) specs.push({ from: line.from + lead.length, to: line.from + lead.length + indent.length - kept.length });
  }
  const changes = state.changes(specs);
  return withRenumbering(state, changes, state.selection.map(changes, 1), (doc) => lines.flatMap((number) => [number, Math.max(1, number - 1), Math.min(doc.lines, number + 1)]), "delete.dedent");
}

/**
 * Backspace right after list or quote markup: remove the checkbox, outdent a nested item, remove a top-level
 * marker, or drop one quote level. Returns null otherwise so the usual Backspace runs.
 */
export function deleteListMarkup(state: EditorState): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  return rangeResult(state, (range) => {
    if (!range.empty) return null;
    const line = state.doc.lineAt(range.head);
    const markup = parseLineMarkup(line.text);
    const offset = range.head - line.from;
    if (!markup || offset !== markup.contentFrom || offset === 0 || inCode(state, range.head)) return null;
    let from: number, to: number, insert = "";
    if (markup.task) { from = line.from + markup.markerTo; to = line.from + markup.contentFrom; }
    else if (isItem(markup) && markup.itemIndent) {
      const parent = parentItem(state.doc, line.number, markup, state.tabSize);
      const own = column(markup.itemIndent, state.tabSize);
      const kept = removeColumns(markup.itemIndent, parent ? own - column(parent.itemIndent, state.tabSize) : column(state.facet(indentUnit), state.tabSize), state.tabSize);
      from = line.from + markup.lead.length; to = from + markup.itemIndent.length; insert = kept;
      return { changes: [{ from, to, insert }], range: EditorSelection.cursor(range.head - (markup.itemIndent.length - kept.length)), renumber: [line.from] };
    }
    else if (isItem(markup)) { from = line.from + markup.markerFrom; to = line.from + markup.markerTo; }
    else { const reduced = markup.lead.replace(/>[ \t]?$/, ""); from = line.from + reduced.length; to = line.from + markup.lead.length; }
    return { changes: [{ from, to, insert }], range: EditorSelection.cursor(from), renumber: [line.from] };
  }, "delete.backward");
}

const asCommand = (build: (state: EditorState) => TransactionSpec | null): Command => (view) => {
  if (view.state.readOnly) return false;
  const spec = build(view.state);
  if (!spec) return false;
  view.dispatch(view.state.update(spec));
  return true;
};

export const continueListCommand = asCommand((state) => continueMarkup(state));
export const continueListAtLineEndCommand = asCommand((state) => continueMarkup(state, true));
export const indentListCommand = asCommand(indentListItems);
export const outdentListCommand = asCommand(outdentListItems);
export const deleteListMarkupCommand = asCommand(deleteListMarkup);
