import { EditorSelection, type ChangeSpec, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, type Command } from "@codemirror/view";
import { inCode, isMarkdown } from "./markdown-context";
import { parseLineMarkup } from "./markdown-lists";

export type InlineStyle = "bold" | "italic" | "strikethrough" | "code";

interface StyleRule { insert: string; detect: readonly { char: string; count: number }[] }
const STYLES: Record<InlineStyle, StyleRule> = {
  bold: { insert: "**", detect: [{ char: "*", count: 2 }, { char: "_", count: 2 }] },
  italic: { insert: "*", detect: [{ char: "*", count: 1 }, { char: "_", count: 1 }] },
  strikethrough: { insert: "~~", detect: [{ char: "~", count: 2 }] },
  code: { insert: "`", detect: [{ char: "`", count: 1 }] },
};

function run(doc: Text, pos: number, direction: -1 | 1, char: string): number {
  let count = 0;
  while (count < 3) {
    const at = direction < 0 ? pos - count - 1 : pos + count;
    if (at < 0 || at >= doc.length || doc.sliceString(at, at + 1) !== char) break;
    count++;
  }
  return count;
}

/** Whether runs of `before` and `after` marker characters hold the style: `*`/`_` runs of 3 are bold and italic at once. */
function holds(char: string, count: number, before: number, after: number): boolean {
  const shared = Math.min(before, after);
  if (char === "*" || char === "_") return count === 1 ? shared === 1 || shared === 3 : shared >= 2;
  return shared >= count;
}

function leadingRun(text: string, char: string): number { let count = 0; while (count < 3 && text[count] === char) count++; return count; }
function trailingRun(text: string, char: string): number { let count = 0; while (count < 3 && text[text.length - 1 - count] === char) count++; return count; }

/**
 * Toggles an inline style on every range, like VS Code with Markdown All in One: wraps the selection (or the
 * word at the caret, or inserts an empty pair) and removes the markers when the text is already wrapped,
 * keeping the same text selected.
 */
export function toggleInlineStyle(state: EditorState, style: InlineStyle): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const rule = STYLES[style];
  return state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) { const word = state.wordAt(range.head); if (word) ({ from, to } = word); }
    for (const { char, count } of rule.detect) {
      if (holds(char, count, run(state.doc, from, -1, char), run(state.doc, to, 1, char)) && from !== to) {
        return { changes: [{ from: from - count, to: from }, { from: to, to: to + count }], range: EditorSelection.range(range.anchor - count, range.head - count) };
      }
      const text = state.sliceDoc(from, to);
      if (!range.empty && text.length > 2 * count && holds(char, count, leadingRun(text, char), trailingRun(text, char))) {
        return { changes: [{ from, to: from + count }, { from: to - count, to }], range: EditorSelection.range(from, to - 2 * count) };
      }
    }
    const length = rule.insert.length;
    const changes = [{ from, insert: rule.insert }, { from: to, insert: rule.insert }];
    if (range.empty) return { changes, range: EditorSelection.cursor(range.head + length) };
    return { changes, range: EditorSelection.range(range.anchor + length, range.head + length) };
  });
}

function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last--;
    for (let number = first; number <= last; number++) lines.add(number);
  }
  return [...lines].sort((a, b) => a - b);
}

function lineEdit(state: EditorState, changes: ChangeSpec[], userEvent: string): TransactionSpec | null {
  if (!changes.length) return null;
  const set = state.changes(changes);
  return { changes: set, selection: state.selection.map(set, 1), userEvent, scrollIntoView: true };
}

const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/** Makes the selected lines headings of `level`; lines already at that level lose the heading. `level` 0 removes it. */
export function setHeading(state: EditorState, level: number): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const changes: ChangeSpec[] = [];
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    if (inCode(state, line.from)) continue;
    const match = HEADING.exec(line.text);
    const current = match ? match[2].length : 0;
    const wanted = current === level ? 0 : level;
    const insert = wanted ? `${"#".repeat(wanted)} ` : "";
    const from = line.from + (match ? match[1].length : /^ {0,3}/.exec(line.text)![0].length);
    changes.push({ from, to: match ? line.from + match[0].length : from, insert });
  }
  return lineEdit(state, changes, "input.format");
}

/** Raises (`+1`) or lowers (`-1`) the heading level of the selected lines, between none and 6. */
export function shiftHeading(state: EditorState, delta: 1 | -1): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const changes: ChangeSpec[] = [];
  for (const number of selectedLines(state)) {
    const line = state.doc.line(number);
    const match = HEADING.exec(line.text);
    const current = match ? match[2].length : 0;
    const wanted = Math.max(0, Math.min(6, current + delta));
    if (wanted === current || (!match && !line.text.trim())) continue;
    const from = line.from + (match ? match[1].length : 0);
    changes.push({ from, to: match ? line.from + match[0].length : from, insert: wanted ? `${"#".repeat(wanted)} ` : "" });
  }
  return lineEdit(state, changes, "input.format");
}

/** Checks or unchecks task items on the selected lines; other list items and plain lines become unchecked tasks. */
export function toggleTask(state: EditorState): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const changes: ChangeSpec[] = [];
  const lines = selectedLines(state);
  for (const number of lines) {
    const line = state.doc.line(number);
    if (inCode(state, line.from) || (!line.text.trim() && lines.length > 1)) continue;
    const markup = parseLineMarkup(line.text);
    if (markup?.task) changes.push({ from: line.from + markup.markerTo + 1, to: line.from + markup.markerTo + 2, insert: markup.task === "[ ]" ? "x" : " " });
    else if (markup && (markup.bullet || markup.number !== null)) changes.push({ from: line.from + markup.markerTo, insert: markup.spacing ? "[ ] " : " [ ] " });
    else {
      const lead = markup?.lead ?? /^[ \t]*/.exec(line.text)![0];
      changes.push({ from: line.from + lead.length, insert: "- [ ] " });
    }
  }
  return lineEdit(state, changes, "input.format");
}

/** Adds `> ` to the selected lines, or removes one quote level when every non-blank line is quoted. */
export function toggleBlockquote(state: EditorState): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const lines = selectedLines(state).map((number) => state.doc.line(number));
  const content = lines.filter((line) => line.text.trim());
  const quoted = content.length > 0 && content.every((line) => /^[ \t]*>/.test(line.text));
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    if (quoted) { const match = /^([ \t]*)> ?/.exec(line.text); if (match) changes.push({ from: line.from + match[1].length, to: line.from + match[0].length }); }
    else changes.push({ from: line.from, insert: line.text.trim() ? "> " : ">" });
  }
  return lineEdit(state, changes, "input.format");
}

/** Turns the selected lines into a bullet (`- `) or ordered (`1. `, `2. `) list, or removes the markers when they already are one. */
export function toggleList(state: EditorState, ordered: boolean): TransactionSpec | null {
  if (!isMarkdown(state)) return null;
  const lines = selectedLines(state).map((number) => state.doc.line(number)).filter((line, _, all) => line.text.trim() || all.length === 1);
  const parsed = lines.map((line) => ({ line, markup: parseLineMarkup(line.text) }));
  const already = parsed.length > 0 && parsed.every(({ markup }) => markup && (ordered ? markup.number !== null : Boolean(markup.bullet)));
  const changes: ChangeSpec[] = [];
  let next = 1;
  for (const { line, markup } of parsed) {
    const isItem = markup && (markup.bullet || markup.number !== null);
    if (already) { changes.push({ from: line.from + markup!.markerFrom, to: line.from + markup!.markerTo }); continue; }
    const insert = ordered ? `${next++}. ` : "- ";
    if (isItem) changes.push({ from: line.from + markup.markerFrom, to: line.from + markup.markerTo, insert });
    else {
      const lead = markup?.lead ?? /^[ \t]*/.exec(line.text)![0];
      changes.push({ from: line.from + lead.length, insert });
    }
  }
  return lineEdit(state, changes, "input.format");
}

const SURROUND = new Set(["*", "_", "~", "`"]);

/**
 * Typing `*`, `_`, `~` or a backtick while text is selected wraps every selection in that character and keeps
 * the text selected (Zed `surround`). Brackets keep CodeMirror's closeBrackets behaviour.
 */
export function surroundSelection(state: EditorState, text: string): TransactionSpec | null {
  if (!SURROUND.has(text) || !isMarkdown(state) || state.selection.ranges.some((range) => range.empty || inCode(state, range.from))) return null;
  return {
    ...state.changeByRange((range) => ({ changes: [{ from: range.from, insert: text }, { from: range.to, insert: text }], range: EditorSelection.range(range.anchor + 1, range.head + 1) })),
    userEvent: "input.type",
  };
}

export const markdownSurround = EditorView.inputHandler.of((view, _from, _to, text) => {
  if (view.state.readOnly || view.composing) return false;
  const spec = surroundSelection(view.state, text);
  if (!spec) return false;
  view.dispatch(view.state.update(spec));
  return true;
});

const command = (build: (state: EditorState) => TransactionSpec | null): Command => (view) => {
  if (view.state.readOnly) return false;
  const spec = build(view.state);
  if (!spec) return false;
  view.dispatch(view.state.update({ userEvent: "input.format", ...spec }));
  return true;
};

export const toggleBold = command((state) => toggleInlineStyle(state, "bold"));
export const toggleItalic = command((state) => toggleInlineStyle(state, "italic"));
export const toggleStrikethrough = command((state) => toggleInlineStyle(state, "strikethrough"));
export const toggleInlineCode = command((state) => toggleInlineStyle(state, "code"));
export const headingCommand = (level: number) => command((state) => setHeading(state, level));
export const increaseHeading = command((state) => shiftHeading(state, 1));
export const decreaseHeading = command((state) => shiftHeading(state, -1));
export const toggleTaskCommand = command(toggleTask);
export const toggleBlockquoteCommand = command(toggleBlockquote);
export const toggleBulletListCommand = command((state) => toggleList(state, false));
export const toggleOrderedListCommand = command((state) => toggleList(state, true));
