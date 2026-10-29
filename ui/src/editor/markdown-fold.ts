import { foldService } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

const REGION_START = /^\s*<!--\s*#?region\b.*-->\s*$/;
const REGION_END = /^\s*<!--\s*#?endregion\b.*-->\s*$/;

/** Folds `<!-- #region -->` to its matching `<!-- #endregion -->`, nesting aware. Header sections and fenced code fold through lang-markdown. */
export function regionFold(state: EditorState, lineStart: number, lineEnd: number): { from: number; to: number } | null {
  const start = state.doc.lineAt(lineStart);
  if (!REGION_START.test(start.text)) return null;
  let depth = 1;
  for (let number = start.number + 1; number <= state.doc.lines; number++) {
    const text = state.doc.line(number).text;
    if (REGION_START.test(text)) depth++;
    else if (REGION_END.test(text) && --depth === 0) return { from: lineEnd, to: state.doc.line(number).to };
  }
  return null;
}

export const markdownRegionFolding = foldService.of(regionFold);
