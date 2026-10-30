import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { GitBlame } from "../bindings";
import { gitLineHunks, gitOriginalLine, type GitLineHunk } from "../lib/git-decorations";

export type GitBlameConfig = { baseline?: string; blame?: GitBlame; enabled: boolean };
export const setGitBlame = StateEffect.define<GitBlameConfig>();
const blameConfig = StateField.define<GitBlameConfig>({
  create: () => ({ enabled: false }),
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setGitBlame)) value = effect.value; return value; },
});
const refreshBlame = StateEffect.define<null>();
class BlameWidget extends WidgetType {
  constructor(readonly text: string, readonly detail: string) { super(); }
  eq(other: BlameWidget) { return this.text === other.text && this.detail === other.detail; }
  toDOM() {
    const dom = document.createElement("span");
    dom.className = "cm-git-blame"; dom.textContent = this.text; dom.title = this.detail;
    // Attribution is also available in the status bar. Keep the editable text's accessible value unchanged.
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }
  ignoreEvent() { return true; }
}

/** Attribution is pinned to HEAD and mapped through the live buffer, including unsaved edits. */
export function gitInlineBlame(initial: GitBlameConfig): Extension {
  return [blameConfig.init(() => initial), ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    timer: ReturnType<typeof setTimeout> | undefined;
    document?: Text;
    baseline?: string;
    hunks?: GitLineHunk[];
    constructor(readonly view: EditorView) { this.schedule(); }
    update(update: ViewUpdate) {
      const changed = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setGitBlame)));
      if (changed || update.docChanged) { this.decorations = Decoration.none; this.schedule(); }
      else if (update.selectionSet || update.focusChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshBlame)))) this.render();
    }
    schedule() {
      clearTimeout(this.timer);
      const config = this.view.state.field(blameConfig);
      if (!config.enabled || config.baseline === undefined || !config.blame) return;
      this.timer = setTimeout(() => {
        const state = this.view.state, config = state.field(blameConfig);
        if (!config.enabled || config.baseline === undefined || !config.blame) return;
        if (this.document !== state.doc || this.baseline !== config.baseline) {
          this.hunks = gitLineHunks(config.baseline, state.doc.toString());
          this.document = state.doc; this.baseline = config.baseline;
        }
        this.view.dispatch({ effects: refreshBlame.of(null) });
      }, 300);
    }
    render() {
      const state = this.view.state, config = state.field(blameConfig);
      this.decorations = Decoration.none;
      if (!config.enabled || !config.blame || this.document !== state.doc || this.baseline !== config.baseline || !this.hunks || state.selection.ranges.some(range => !range.empty)) return;
      const line = state.doc.lineAt(state.selection.main.head);
      const original = gitOriginalLine(this.hunks, line.number);
      const attribution = original === undefined ? undefined : config.blame.lines.find(entry => entry.line === original);
      if (!attribution && original !== undefined) return;
      const text = attribution ? `${attribution.author} · ${attribution.summary}` : "Uncommitted changes";
      const detail = attribution ? `${attribution.commitId.slice(0, 8)} · ${attribution.author} <${attribution.authorEmail}>\n${new Date(attribution.timestamp * 1000).toLocaleString()}\n${attribution.summary}` : "This line has changed since HEAD, including staged or unsaved changes.";
      this.decorations = Decoration.set([Decoration.widget({ widget: new BlameWidget(text, detail), side: 1 }).range(line.to)]);
    }
    destroy() { clearTimeout(this.timer); }
  }, { decorations: plugin => plugin.decorations })];
}
