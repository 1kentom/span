import { EditorSelection, Prec, type EditorState, type Extension, type StateCommand, type Transaction } from "@codemirror/state";
import { acceptCompletion, completionStatus, hasNextSnippetField } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { keymap, type Command } from "@codemirror/view";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { EmmetKnownSyntax, emmetConfig, expandAbbreviation } from "@emmetio/codemirror6-plugin";

function eligible(state: EditorState, position: number) {
  if (!ensureSyntaxTree(state, position, 20)) return false;
  const css = cssLanguage.isActiveAt(state, position, -1);
  const html = htmlLanguage.isActiveAt(state, position, -1);
  if (!css && !html) return false;
  let inCssBlock = false;
  for (let node = syntaxTree(state).resolveInner(position, -1); node; node = node.parent!) {
    if (/Comment|String|Attribute|ScriptText|ProcessingInst|Doctype|CDATA/.test(node.name)) return false;
    if (html && /^(?:OpenTag|CloseTag|SelfClosingTag|TagName)$/.test(node.name)) return false;
    if (node.name === "Block") inCssBlock = true;
  }
  return html || inCssBlock;
}

/** Delegate expansion and snippet generation to the official Emmet CM6 plugin. */
export const expandEmmet: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly || state.selection.ranges.some((range) => !range.empty || !eligible(state, range.head))) return false;
  const expansions: Transaction[] = [];
  let output: Transaction;
  try {
    for (const range of state.selection.ranges) {
      const cursorState = state.update({ selection: EditorSelection.single(range.head) }).state;
      let expanded: Transaction | undefined;
      const handled = expandAbbreviation({ state: cursorState, dispatch: (transaction) => { expanded = transaction; } });
      if (!handled || !expanded?.docChanged) return false;
      expansions.push(expanded);
    }
    if (expansions.length === 1) {
      const transaction = expansions[0];
      output = state.update({ changes: transaction.changes, selection: transaction.state.selection, effects: transaction.effects, userEvent: "input.emmet", scrollIntoView: true });
    } else {
      let index = 0;
      const spec = state.changeByRange(() => { const transaction = expansions[index++]; return { changes: transaction.changes, range: transaction.state.selection.main }; });
      output = state.update(spec, { userEvent: "input.emmet", scrollIntoView: true });
    }
  } catch {
    // Invalid abbreviations leave the document untouched and allow normal Tab.
    return false;
  }
  dispatch(output);
  return true;
};

export const emmetTab: Command = (view) => {
  if (completionStatus(view.state)) { acceptCompletion(view); return true; }
  if (hasNextSnippetField(view.state)) return false;
  return expandEmmet(view);
};

export function emmetSupport(syntax: "html" | "css"): Extension {
  return [emmetConfig.of({ syntax: syntax === "html" ? EmmetKnownSyntax.html : EmmetKnownSyntax.css }), Prec.high(keymap.of([{ key: "Tab", run: emmetTab }]))];
}
