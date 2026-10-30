import { RangeSet, StateEffect, StateField, type Extension, type Text, type Transaction } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { gitLineHunks, type GitLineHunk } from "../lib/git-decorations";
import { gitGutterAccessibility } from "./git-gutter-accessibility";
import { iconAssetPath } from "../lib/menuIcons";

export const setGitBaseline = StateEffect.define<string | undefined>();
const setGitHunks = StateEffect.define<{ document: Text; hunks: GitLineHunk[] }>();
const previewGitHunk = StateEffect.define<GitLineHunk | undefined>();
type GitGutterState = { baseline?: string; hunks: GitLineHunk[]; markers: RangeSet<GutterMarker>; preview?: GitLineHunk };

function anchorLine(hunk: GitLineHunk, lines: number) {
  return Math.max(1, Math.min(lines, hunk.after.length ? hunk.newStart : hunk.newStart - 1));
}
class GitMarker extends GutterMarker {
  constructor(readonly hunk: GitLineHunk, readonly top: boolean, readonly selected = false, readonly focusable = true) { super(); }
  eq(other: GutterMarker) { return other instanceof GitMarker && this.hunk === other.hunk && this.top === other.top && this.selected === other.selected && this.focusable === other.focusable; }
  toDOM(view: EditorView) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.tabIndex = this.focusable ? 0 : -1;
    marker.className = `cm-git-marker cm-git-${this.hunk.kind}${this.top ? " cm-git-deleted-top" : ""}${this.selected ? " cm-git-selected" : ""}`;
    marker.setAttribute("aria-expanded", String(this.selected));
    marker.setAttribute("aria-haspopup", "dialog");
    const rail = document.createElement("span"); rail.className = "cm-git-rail"; marker.append(rail);
    marker.title = `${this.hunk.kind === "deleted" ? this.hunk.before.length : this.hunk.after.length} ${this.hunk.kind} ${Math.max(this.hunk.before.length, this.hunk.after.length) === 1 ? "line" : "lines"}. Click to review change.`;
    marker.ariaLabel = marker.title;
    marker.addEventListener("pointerdown", event => event.preventDefault());
    marker.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); view.dispatch({ effects: previewGitHunk.of(this.hunk) }); } });
    marker.addEventListener("mousedown", event => event.preventDefault());
    marker.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); view.dispatch({ effects: previewGitHunk.of(this.hunk) }); });
    return marker;
  }
}

function markersFor(hunks: GitLineHunk[], doc: Text): RangeSet<GutterMarker> {
  return RangeSet.of(hunks.flatMap(hunk => {
    const start = anchorLine(hunk, doc.lines);
    return Array.from({ length: Math.max(1, hunk.after.length) }, (_, index) =>
      new GitMarker(hunk, !hunk.after.length && hunk.newStart === 1, false, index === 0).range(doc.line(Math.min(doc.lines, start + index)).from));
  }), true);
}

/** Retain only independently unchanged spans while the exact diff is pending. */
function retainUntouched(hunks: GitLineHunk[], transaction: Transaction): GitLineHunk[] {
  const before = transaction.startState.doc, after = transaction.state.doc;
  return hunks.flatMap(hunk => {
    const start = hunk.after.length ? hunk.newStart : anchorLine(hunk, before.lines);
    const end = Math.min(before.lines, start + Math.max(1, hunk.after.length) - 1);
    // Include surrounding line boundaries so newline joins and edits at deletion gaps invalidate the span.
    const from = before.line(Math.max(1, start - 1)).from;
    const to = before.line(Math.min(before.lines, end + 1)).to;
    let touched = false;
    transaction.changes.iterChangedRanges((fromA, toA) => { if (fromA <= to && toA >= from) touched = true; });
    if (touched) return [];
    const gap = !hunk.after.length;
    const oldPosition = gap && hunk.newStart > before.lines ? before.length : before.line(gap ? hunk.newStart : start).from;
    const position = transaction.changes.mapPos(oldPosition, 1);
    const newStart = gap && hunk.newStart > before.lines ? after.lines + 1 : after.lineAt(position).number;
    if (!gap && (after.line(newStart).from !== position || newStart + hunk.after.length - 1 > after.lines || hunk.after.some((line, index) => after.line(newStart + index).text !== line))) return [];
    return [newStart === hunk.newStart ? hunk : { ...hunk, newStart }];
  });
}

const gitGutterState = StateField.define<GitGutterState>({
  create: () => ({ hunks: [], markers: RangeSet.empty }),
  update(value, transaction) {
    if (transaction.docChanged) {
      const hunks = retainUntouched(value.hunks, transaction);
      value = { ...value, hunks, markers: markersFor(hunks, transaction.state.doc), preview: undefined };
    }
    for (const effect of transaction.effects) {
      if (effect.is(setGitBaseline)) value = { baseline: effect.value, hunks: [], markers: RangeSet.empty };
      if (effect.is(previewGitHunk) && (!effect.value || value.hunks.includes(effect.value))) {
        const preview = effect.value;
        const ranges: ReturnType<GutterMarker["range"]>[] = [];
        const cursor = value.markers.iter();
        while (cursor.value) {
          const marker = cursor.value as GitMarker;
          ranges.push(new GitMarker(marker.hunk, marker.top, marker.hunk === preview, marker.focusable).range(cursor.from));
          cursor.next();
        }
        value = { ...value, preview, markers: RangeSet.of(ranges, true) };
      }
      if (effect.is(setGitHunks) && effect.value.document === transaction.state.doc) {
        const hunks = effect.value.hunks;
        value = { ...value, hunks, markers: markersFor(hunks, transaction.state.doc) };
      }
    }
    return value;
  },
});

function hunkTooltip(hunk: GitLineHunk, onOpenReview?: () => void): Tooltip {
  return {
    pos: 0, above: false,
    create(view) {
      const dom = document.createElement("section");
      dom.className = "cm-git-preview";
      dom.setAttribute("role", "dialog"); dom.setAttribute("aria-label", "Git change preview");
      const text = (tag: string, className: string, content: string) => {
        const element = document.createElement(tag); element.className = className; element.textContent = content; return element;
      };
      const dismiss = () => { view.dispatch({ effects: previewGitHunk.of(undefined) }); view.focus(); };
      const header = document.createElement("header");
      header.append(text("strong", "cm-git-preview-title", `${hunk.kind[0].toUpperCase()}${hunk.kind.slice(1)} change`));
      const actions = text("div", "cm-git-preview-actions", "");
      for (const direction of [-1, 1] as const) {
        const button = document.createElement("button"); button.type = "button";
        button.title = button.ariaLabel = direction < 0 ? "Previous Git change" : "Next Git change";
        const icon = document.createElement("span");
        icon.style.maskImage = `url('${iconAssetPath(direction < 0 ? "arrow-up3" : "arrow-down4")}')`;
        button.append(icon); button.addEventListener("click", () => navigateGitChange(view, direction)); actions.append(button);
      }
      const close = document.createElement("button"); close.type = "button"; close.textContent = "×"; close.ariaLabel = "Close Git change preview";
      close.addEventListener("click", dismiss); actions.append(close); header.append(actions); dom.append(header);
      const hunks = view.state.field(gitGutterState).hunks;
      const range = (start: number, count: number) => count ? count === 1 ? `line ${start}` : `lines ${start}–${start + count - 1}` : "no lines";
      dom.append(text("div", "cm-git-preview-position", `Change ${hunks.indexOf(hunk) + 1} of ${hunks.length}`),
        text("div", "cm-git-preview-summary", `${hunk.before.length} removed, ${hunk.after.length} added`),
        text("div", "cm-git-preview-context", "Index compared with live buffer, including unsaved edits."));
      let remaining = 40;
      for (const [label, lines, kind, start, sign] of [["Index", hunk.before, "before", hunk.oldStart, "−"], ["Live buffer", hunk.after, "after", hunk.newStart, "+"]] as const) {
        const section = text("div", `cm-git-preview-${kind}`, "");
        section.append(text("div", "cm-git-preview-caption", `${label}: ${range(start, lines.length)}`));
        // Reserve room for both sides when a replacement is larger than the preview budget.
        const limit = Math.min(lines.length, kind === "before" && hunk.after.length ? 20 : remaining);
        for (let index = 0; index < limit; index++) {
          const row = text("div", "cm-git-preview-row", "");
          row.append(text("span", "cm-git-preview-sign", sign), text("span", "cm-git-preview-number", String(start + index)), text("code", "cm-git-preview-code", lines[index].slice(0, 300)));
          section.append(row);
        }
        remaining -= limit;
        if (!lines.length) section.append(text("div", "cm-git-preview-empty", "No lines"));
        if (lines.length > limit || lines.slice(0, limit).some(line => line.length > 300)) section.append(text("div", "cm-git-preview-shortened", "Preview shortened"));
        dom.append(section);
      }
      if (onOpenReview) {
        const review = document.createElement("button"); review.type = "button"; review.className = "cm-git-preview-review"; review.textContent = "Review saved changes";
        review.addEventListener("click", () => { dismiss(); onOpenReview(); }); dom.append(review);
        dom.append(text("div", "cm-git-preview-context", "Saved comparison excludes unsaved buffer edits."));
      }
      dom.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } });
      // Prevent pointer interaction inside the dialog from changing the editor selection.
      dom.addEventListener("mousedown", event => { if (!(event.target instanceof Element && event.target.closest("button"))) event.preventDefault(); });
      return { dom };
    },
  };
}

export function navigateGitChange(view: EditorView, direction: -1 | 1): boolean {
  const state = view.state.field(gitGutterState, false);
  if (!state?.hunks.length) return false;
  const current = view.state.doc.lineAt(view.state.selection.main.head).number;
  const activeIndex = state.preview ? state.hunks.indexOf(state.preview) : -1;
  const hunk = activeIndex >= 0 ? state.hunks[(activeIndex + direction + state.hunks.length) % state.hunks.length]
    : direction > 0 ? state.hunks.find(hunk => anchorLine(hunk, view.state.doc.lines) > current) ?? state.hunks[0]
    : [...state.hunks].reverse().find(hunk => anchorLine(hunk, view.state.doc.lines) < current) ?? state.hunks.at(-1)!;
  const position = view.state.doc.line(anchorLine(hunk, view.state.doc.lines)).from;
  view.dispatch({ selection: { anchor: position }, effects: [previewGitHunk.of(hunk), EditorView.scrollIntoView(position, { y: "center" })] });
  view.focus();
  return true;
}

/** Recompute after a short typing pause. Revalidate untouched spans against the edited document. */
export function gitGutter(initialBaseline?: string, onCount?: (count: number) => void, onOpenReview?: () => void): Extension {
  return [gitGutterState.init(() => ({ baseline: initialBaseline, hunks: [], markers: RangeSet.empty })),
    gutter({ class: "cm-git-gutter", markers: view => view.state.field(gitGutterState).markers, initialSpacer: () => new class extends GutterMarker { toDOM() { const span = document.createElement("span"); span.className = "cm-git-spacer"; return span; } }() }),
    // A separate facet can read document positions, so previews follow the hunk being reviewed.
    showTooltip.compute([gitGutterState], state => {
      const hunk = state.field(gitGutterState).preview;
      return hunk ? { ...hunkTooltip(hunk, onOpenReview), pos: state.doc.line(anchorLine(hunk, state.doc.lines)).from } : null;
    }),
    ViewPlugin.fromClass(class {
      timer: ReturnType<typeof setTimeout> | undefined;
      outside = (event: Event) => {
        if (!this.view.state.field(gitGutterState).preview) return;
        const target = event.target;
        if (target instanceof Element && (target.closest(".cm-git-preview") || this.view.dom.contains(target) && target.closest(".cm-git-marker"))) return;
        this.view.dispatch({ effects: previewGitHunk.of(undefined) });
      };
      constructor(readonly view: EditorView) { this.schedule(0); document.addEventListener("pointerdown", this.outside, true); }

      update(update: { docChanged: boolean; transactions: readonly { effects: readonly StateEffect<unknown>[] }[] }) {
        if (update.docChanged || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setGitBaseline)))) this.schedule(update.docChanged ? 120 : 0);
        if (update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setGitHunks)))) onCount?.(this.view.state.field(gitGutterState).hunks.length);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const state = this.view.state, baseline = state.field(gitGutterState).baseline;
          const hunks = baseline === undefined ? [] : gitLineHunks(baseline, state.doc.toString()) ?? [];
          this.view.dispatch({ effects: setGitHunks.of({ document: state.doc, hunks }) });
        }, delay);
      }
      destroy() { clearTimeout(this.timer); document.removeEventListener("pointerdown", this.outside, true); }
    }),
    keymap.of([{ key: "Escape", run: view => { if (!view.state.field(gitGutterState).preview) return false; view.dispatch({ effects: previewGitHunk.of(undefined) }); return true; } }]),
    gitGutterAccessibility,
  ];
}
