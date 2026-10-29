import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";

/** Block nodes whose text is not Markdown markup: no list continuation, formatting or snippets there. */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "CommentBlock", "FrontMatter", "ProcessingInstructionBlock"]);
const INLINE_CODE_NODES = new Set(["InlineCode", "URL", "Autolink"]);

/** True when the document's language is Markdown. */
export function isMarkdown(state: EditorState): boolean {
  return state.facet(language)?.name === "markdown";
}

/** True inside a fenced or indented code block, an HTML block or front matter; with `inline`, also inside inline code and URLs. */
export function inCode(state: EditorState, pos: number, inline = false): boolean {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, state.doc.lineAt(pos).to), 200) ?? syntaxTree(state);
  // At a line start look forward, so the line after a closing fence is not code.
  const side = pos === state.doc.lineAt(pos).from ? 1 : -1;
  for (let node: { name: string; parent: unknown } | null = tree.resolveInner(pos, side); node; node = node.parent as typeof node) {
    if (CODE_NODES.has(node.name) || (inline && INLINE_CODE_NODES.has(node.name))) return true;
  }
  return false;
}
