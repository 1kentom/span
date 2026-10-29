import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import { gitLineHunks, type GitLineKind } from "../lib/git-decorations";
export type GitStagedBaseline = { head: string; index: string } | undefined;
export const setGitStagedBaseline = StateEffect.define<GitStagedBaseline>();
const refreshStaged = StateEffect.define<null>();
const config = StateField.define<GitStagedBaseline>({ create: () => undefined, update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setGitStagedBaseline)) value = effect.value; return value; } });
class StagedMarker extends GutterMarker {
  constructor(readonly kind: GitLineKind) { super(); }
  toDOM() { const dom = document.createElement("span"); dom.className = `cm-git-marker cm-git-${this.kind}`; dom.title = `Staged ${this.kind} change, HEAD compared with index`; return dom; }
}
/** Staged markers map through the index into the live document. Overwritten lines lose their marker. */
export function stagedLineKinds(head: string, index: string, live: string): Map<number, GitLineKind> {
  const staged = gitLineHunks(head, index), working = gitLineHunks(index, live), result = new Map<number, GitLineKind>();
  if (!staged || !working) return result;
  const indexKinds = new Map<number, GitLineKind>();
  for (const hunk of staged) for (let n = 0; n < Math.max(1, hunk.after.length); n++) indexKinds.set(Math.max(1, hunk.after.length ? hunk.newStart + n : hunk.newStart - 1), hunk.kind);
  const count = live.split("\n").length;
  let cursor = 0, offset = 0;
  for (let line = 1; line <= count; line++) {
    while (cursor < working.length && line >= working[cursor].newStart + working[cursor].after.length) { offset += working[cursor].before.length - working[cursor].after.length; cursor++; }
    if (cursor < working.length && line >= working[cursor].newStart) continue;
    const kind = indexKinds.get(line + offset);
    if (kind) result.set(line, kind);
  }
  return result;
}
export function gitStagedGutter(initial: GitStagedBaseline): Extension {
  return [config.init(() => initial), ViewPlugin.fromClass(class {
    markers: RangeSet<GutterMarker> = RangeSet.empty;
    timer?: ReturnType<typeof setTimeout>;
    constructor(readonly view: import("@codemirror/view").EditorView) { this.schedule(); }
    update(update: import("@codemirror/view").ViewUpdate) { if (update.docChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setGitStagedBaseline)))) { this.markers = RangeSet.empty; this.schedule(); } }
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { const baseline = this.view.state.field(config); this.markers = baseline ? RangeSet.of([...stagedLineKinds(baseline.head, baseline.index, this.view.state.doc.toString())].map(([line, kind]) => new StagedMarker(kind).range(this.view.state.doc.line(line).from)), true) : RangeSet.empty; this.view.dispatch({ effects: refreshStaged.of(null) }); }, 130); }
    destroy() { clearTimeout(this.timer); }
  }, { provide: plugin => gutter({ class: "cm-git-gutter cm-git-staged-gutter", markers: view => view.plugin(plugin)?.markers ?? RangeSet.empty, initialSpacer: () => new class extends GutterMarker { toDOM() { const span = document.createElement("span"); span.className = "cm-git-spacer"; return span; } }() }) })];
}
