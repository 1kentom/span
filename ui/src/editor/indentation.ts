import { EditorSelection, EditorState, Prec, StateField, Transaction, countColumn, type Extension, type Text } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { IndentContext, StreamLanguage, indentService, indentUnit, language, matchBrackets } from "@codemirror/language";

export interface DetectedIndent {
  /** "tabs" and "spaces" come from the file; "default" means the editor setting decides. */
  source: "tabs" | "spaces" | "default";
  /** Spaces per level when `source` is "spaces". */
  width: number;
}

/**
 * Guesses the file's indentation like VS Code's `editor.detectIndentation`:
 * tabs when more indented lines start with a tab, otherwise the most common
 * change in space indentation between neighbouring lines.
 */
export function detectIndentation(doc: Text, maxLines = 10000): DetectedIndent {
  let tabs = 0, spaces = 0, previous = 0;
  const deltas = new Map<number, number>();
  const end = Math.min(doc.lines, maxLines);
  for (let number = 1; number <= end; number++) {
    const text = doc.line(number).text;
    const leading = /^[ \t]*/.exec(text)![0];
    if (leading.length === text.length) continue;
    // Block comment continuation lines (" * text") are aligned, not indented.
    if (text[leading.length] === "*" && leading.endsWith(" ")) continue;
    if (leading.startsWith("\t")) { tabs++; previous = -1; continue; }
    const width = leading.length;
    if (width > 0) spaces++;
    if (previous >= 0) {
      const delta = Math.abs(width - previous);
      if (delta > 0 && delta <= 8) deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
    }
    previous = width;
  }
  if (tabs > spaces) return { source: "tabs", width: 0 };
  if (!spaces) return { source: "default", width: 0 };
  let best = 0, bestCount = 0;
  for (const [delta, count] of deltas) {
    // A one-space step is usually alignment; only trust it when nothing else exists.
    const score = delta === 1 ? count / 4 : count;
    if (score > bestCount || (score === bestCount && delta < best)) { best = delta; bestCount = score; }
  }
  return best ? { source: "spaces", width: best } : { source: "default", width: 0 };
}

const detectedIndentation = StateField.define<DetectedIndent>({
  create: (state) => detectIndentation(state.doc),
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    // Re-detect while the file gave no evidence yet, and after programmatic
    // replacements (reloads, formatting, agent edits). Typing keeps the result.
    if (value.source === "default") return detectIndentation(transaction.newDoc, 1000);
    return transaction.annotation(Transaction.userEvent) === undefined ? detectIndentation(transaction.newDoc, 2000) : value;
  },
});

const OPENER = /[\[{(]\s*$/;
const YAML_BLOCK_SCALAR = /:\s*[|>][-+0-9]*\s*$/;

function fallbackApplies(state: EditorState): boolean {
  const current = state.facet(language);
  return !current || current instanceof StreamLanguage;
}

function isYaml(state: EditorState): boolean {
  return state.facet(language)?.name === "yaml";
}

/** Strips a trailing `#` or `//` comment that is not inside quotes, cheaply. */
function withoutTrailingComment(text: string): string {
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) { if (character === quote && text[index - 1] !== "\\") quote = ""; continue; }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index);
    else if (character === "/" && text[index + 1] === "/" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index);
  }
  return text;
}

/**
 * Indentation for languages without their own indent rules (plain text and the
 * legacy stream modes such as YAML, TOML, shell): keep the previous line's
 * indentation, add one unit after an opening bracket or a trailing colon, and
 * line a closing bracket up with the line that opened it.
 */
export function fallbackIndentation(context: IndentContext, pos: number): number | null {
  const { state } = context;
  const after = context.textAfterPos(pos);
  const closer = /^\s*([\]})])/.exec(after);
  if (closer) {
    const match = matchBrackets(state, pos + closer[0].length, -1);
    if (match?.matched && match.end) return context.lineIndent(match.end.from, 1);
  }
  if (pos === 0) return 0;
  let line = context.lineAt(pos - 1, -1);
  // An indented blank line keeps its own width; an empty one defers to the line above.
  while (line.text.length === 0 && line.from > 0) line = context.lineAt(line.from - 1, -1);
  const indent = countColumn(/^\s*/.exec(line.text)![0], state.tabSize);
  const content = withoutTrailingComment(line.text).trimEnd();
  if (!content.trim()) return indent;
  if (isYaml(state)) {
    const item = /^(\s*)-\s+/.exec(content);
    const itemKey = item ? countColumn(item[0], state.tabSize) : indent;
    if (content.endsWith(":") || YAML_BLOCK_SCALAR.test(content) || OPENER.test(content)) return itemKey + context.unit;
    // `- key: value` continues the item's mapping under its key.
    if (item && /^[^\s"'][^:]*:\s/.test(content.slice(item[0].length))) return itemKey;
    return indent;
  }
  if (OPENER.test(content) || content.endsWith(":")) return indent + context.unit;
  return indent;
}

/**
 * Backspace on a line holding only whitespace removes the whole line and puts
 * the caret at the end of the line above, in one undo step. Other cases fall
 * through to CodeMirror's `deleteCharBackward` (one indent unit in leading
 * whitespace, otherwise one character).
 */
export const deleteBlankLineBackward: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const ranges = state.selection.ranges;
  const qualifies = ranges.every((range) => {
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    return line.number > 1 && line.length > 0 && !/\S/.test(line.text);
  });
  if (!qualifies) return false;
  const transaction = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const above = state.doc.line(line.number - 1);
    return { changes: { from: above.to, to: line.to }, range: EditorSelection.cursor(above.to) };
  });
  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "delete.backward" }));
  return true;
};

/**
 * File-aware indentation: the indent unit follows the file (tabs or its space
 * width) and falls back to the editor's tab size; languages without indent
 * rules get `fallbackIndentation`, closing brackets typed at the start of a
 * line re-indent, and Backspace removes whitespace-only lines.
 */
export function indentationSupport(): Extension {
  return [
    detectedIndentation,
    indentUnit.compute([detectedIndentation, EditorState.tabSize], (state) => {
      const detected = state.field(detectedIndentation);
      return detected.source === "tabs" ? "\t" : " ".repeat(detected.source === "spaces" ? detected.width : state.tabSize);
    }),
    Prec.highest(indentService.of((context, pos) => fallbackApplies(context.state) ? fallbackIndentation(context, pos) : undefined)),
    EditorState.languageData.of((state) => fallbackApplies(state) ? [{ indentOnInput: /^\s*[\]})]$/ }] : []),
    Prec.high(keymap.of([{ key: "Backspace", run: deleteBlankLineBackward }])),
  ];
}
