import { RangeSet, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import { gitGutterAccessibility } from "./git-gutter-accessibility";
import { gitLineHunks, type GitLineKind } from "../lib/git-decorations";
export type GitStagedBaseline = { head: string; index: string } | undefined;
export const setGitStagedBaseline = StateEffect.define<GitStagedBaseline>();
const refreshStaged = StateEffect.define<null>();
const config = StateField.define<GitStagedBaseline>({ create: () => undefined, update(value, transaction) { for (const effect of transaction.effects) if (effect.is(setGitStagedBaseline)) value = effect.value; return value; } });
type StagedLine = { kind: GitLineKind; top: boolean; start: boolean; end: boolean };
class StagedMarker extends GutterMarker {
  constructor(readonly detail: StagedLine, readonly onReview?: () => void) { super(); }
  toDOM() {
    const dom = document.createElement("button");
    dom.type = "button";
    dom.tabIndex = this.detail.start ? 0 : -1;
    dom.className = `cm-git-marker cm-git-staged-marker cm-git-${this.detail.kind}${this.detail.top ? " cm-git-deleted-top" : ""}${this.detail.start ? " cm-git-marker-start" : ""}${this.detail.end ? " cm-git-marker-end" : ""}${this.onReview ? " cm-git-marker-reviewable" : ""}`;
    dom.title = `Staged ${this.detail.kind} change, HEAD compared with index${this.onReview ? ". Review saved staged comparison." : ""}`;
    dom.setAttribute("aria-label", dom.title);
    dom.disabled = !this.onReview;
    const rail = document.createElement("span");
    rail.className = "cm-git-rail";
    dom.append(rail);
    dom.addEventListener("mousedown", event => event.preventDefault());
    dom.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.onReview?.(); });
    return dom;
  }
}

/** Only unchanged index lines retain staged authorship in the live document. */
function stagedLines(head: string, index: string, live: string): Map<number, StagedLine> {
  const staged = gitLineHunks(head, index), working = gitLineHunks(index, live), result = new Map<number, StagedLine>();
  if (!staged || !working) return result;
  const indexToLive = new Map<number, number>();
  const count = live ? live.replace(/\r\n?/g, "\n").split("\n").length : 0;
  let cursor = 0, offset = 0;
  for (let line = 1; line <= count; line++) {
    while (cursor < working.length && line >= working[cursor].newStart + working[cursor].after.length) {
      offset += working[cursor].before.length - working[cursor].after.length;
      cursor++;
    }
    if (cursor < working.length && line >= working[cursor].newStart) continue;
    indexToLive.set(line + offset, line);
  }
  for (const hunk of staged) {
    if (!hunk.after.length) {
      // A deletion occupies a boundary, with BOF above the first surviving line.
      const top = hunk.newStart === 1;
      const anchor = indexToLive.get(top ? 1 : hunk.newStart - 1);
      if (anchor !== undefined || !index && !live) result.set(anchor ?? 1, { kind: "deleted", top, start: true, end: true });
      continue;
    }
    const mapped = hunk.after.map((_, n) => indexToLive.get(hunk.newStart + n));
    mapped.forEach((line, n) => {
      if (line !== undefined) result.set(line, { kind: hunk.kind, top: false,
        start: n === 0 || mapped[n - 1] !== line - 1,
        end: n === mapped.length - 1 || mapped[n + 1] !== line + 1 });
    });
  }
  return result;
}

export function stagedLineKinds(head: string, index: string, live: string): Map<number, GitLineKind> {
  return new Map([...stagedLines(head, index, live)].map(([line, detail]) => [line, detail.kind]));
}
export function gitStagedGutter(initial: GitStagedBaseline, onReviewStaged?: () => void): Extension {
  return [config.init(() => initial), ViewPlugin.fromClass(class {
    markers: RangeSet<GutterMarker> = RangeSet.empty;
    timer?: ReturnType<typeof setTimeout>;
    constructor(readonly view: import("@codemirror/view").EditorView) { this.schedule(); }
    update(update: import("@codemirror/view").ViewUpdate) {
      const reset = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setGitStagedBaseline)));
      if (reset) this.markers = RangeSet.empty;
      else if (update.docChanged) {
        const retained: Range<GutterMarker>[] = [];
        for (let cursor = this.markers.iter(); cursor.value; cursor.next()) {
          const marker = cursor.value as StagedMarker;
          const line = update.startState.doc.lineAt(cursor.from);
          const deletion = marker.detail.kind === "deleted";
          const protectedFrom = deletion ? update.startState.doc.line(Math.max(1, line.number - 1)).from : line.from;
          const protectedTo = deletion ? update.startState.doc.line(Math.min(update.startState.doc.lines, line.number + 1)).to : line.to;
          let touched = false;
          update.changes.iterChangedRanges((from, to, newFrom, newTo) => {
            // Whole lines inserted above an unchanged line can move its marker safely.
            const insertAbove = !deletion && from === to && from === line.from
              && update.state.doc.sliceString(newFrom, newTo).endsWith("\n");
            if (!insertAbove && from <= protectedTo && to >= protectedFrom) touched = true;
          });
          if (touched) continue;
          const position = update.changes.mapPos(line.from, 1);
          const mappedLine = update.state.doc.lineAt(position);
          if (mappedLine.from === position && mappedLine.text === line.text) retained.push(marker.range(position));
        }
        this.markers = RangeSet.of(retained, true);
      }
      if (reset || update.docChanged) this.schedule();
    }
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { const baseline = this.view.state.field(config); this.markers = baseline ? RangeSet.of([...stagedLines(baseline.head, baseline.index, this.view.state.doc.toString())].map(([line, detail]) => new StagedMarker(detail, onReviewStaged).range(this.view.state.doc.line(line).from)), true) : RangeSet.empty; this.view.dispatch({ effects: refreshStaged.of(null) }); }, 130); }
    destroy() { clearTimeout(this.timer); }
  }, { provide: plugin => gutter({ class: "cm-git-gutter cm-git-staged-gutter", markers: view => view.plugin(plugin)?.markers ?? RangeSet.empty, initialSpacer: () => new class extends GutterMarker { toDOM() { const span = document.createElement("span"); span.className = "cm-git-spacer"; return span; } }() }) }), gitGutterAccessibility];
}
