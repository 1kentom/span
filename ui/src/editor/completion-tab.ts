import { acceptCompletion, closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { Prec, type Extension } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";

/** Completion owns Tab while open or pending, before snippets, Emmet, or indentation. */
export const completionFirstTab: Command = view => {
  if (!completionStatus(view.state)) return false;
  if (view.state.readOnly) { closeCompletion(view); return false; }
  acceptCompletion(view);
  return true;
};

/** CodeMirror's public Tab focus mode bypasses Tab keymaps before this command runs. */
export const completionTabSupport: Extension = Prec.highest(keymap.of([{ key: "Tab", run: completionFirstTab }]));
