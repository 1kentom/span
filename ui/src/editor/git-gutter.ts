import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { gitLineHunks, type GitLineHunk } from "../lib/git-decorations";
import { iconAssetPath } from "../lib/menuIcons";

export const setGitBaseline = StateEffect.define<string | undefined>();
const setGitHunks = StateEffect.define<{ document: Text; hunks: GitLineHunk[] }>();
const previewGitHunk = StateEffect.define<GitLineHunk | undefined>();
type GitGutterState = { baseline?: string; hunks: GitLineHunk[]; markers: RangeSet<GutterMarker>; preview?: GitLineHunk };

function anchorLine(hunk: GitLineHunk, lines: number) {
  return Math.max(1, Math.min(lines, hunk.after.length ? hunk.newStart : hunk.newStart - 1));
}
class GitMarker extends GutterMarker {
  constructor(readonly hunk: GitLineHunk, readonly top: boolean) { super(); }
  eq(other: GutterMarker) { return other instanceof GitMarker && this.hunk === other.hunk && this.top === other.top; }
  toDOM(view: EditorView) {
    const marker = document.createElement("span");
    marker.className = `cm-git-marker cm-git-${this.hunk.kind}${this.top ? " cm-git-deleted-top" : ""}`;
    marker.title = `${this.hunk.kind === "deleted" ? this.hunk.before.length : this.hunk.after.length} ${this.hunk.kind} ${Math.max(this.hunk.before.length, this.hunk.after.length) === 1 ? "line" : "lines"}. Click to review change.`;
    marker.addEventListener("mousedown", event => event.preventDefault());
    marker.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); view.dispatch({ effects: previewGitHunk.of(this.hunk) }); });
    return marker;
  }
}

const gitGutterState = StateField.define<GitGutterState>({
  create: () => ({ hunks: [], markers: RangeSet.empty }),
  update(value, transaction) {
    if (transaction.docChanged) value = { ...value, hunks: [], markers: RangeSet.empty, preview: undefined };
    for (const effect of transaction.effects) {
      if (effect.is(setGitBaseline)) value = { baseline: effect.value, hunks: [], markers: RangeSet.empty };
      if (effect.is(previewGitHunk)) value = { ...value, preview: effect.value };
      if (effect.is(setGitHunks) && effect.value.document === transaction.state.doc) {
        const hunks = effect.value.hunks;
        const ranges = hunks.flatMap(hunk => {
          const start = anchorLine(hunk, transaction.state.doc.lines);
          return Array.from({ length: Math.max(1, hunk.after.length) }, (_, index) => {
            const line = transaction.state.doc.line(Math.min(transaction.state.doc.lines, start + index));
            return new GitMarker(hunk, !hunk.after.length && hunk.newStart === 1).range(line.from);
          });
        });
        value = { ...value, hunks, markers: RangeSet.of(ranges, true) };
      }
    }
    return value;
  },
});

function hunkTooltip(hunk: GitLineHunk): Tooltip {
  // The tooltip facet sets the position from the current document.
  return {
    pos: 0,
    above: false,
    create(view) {
      const dom = document.createElement("section");
      dom.className = "cm-git-preview";
      dom.setAttribute("role", "dialog");
      dom.setAttribute("aria-label", "Git change preview");
      const header = document.createElement("header"), title = document.createElement("strong");
      title.textContent = "Working change";
      header.append(title);
      for (const direction of [-1, 1] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.title = button.ariaLabel = direction < 0 ? "Previous Git change" : "Next Git change";
        const icon = document.createElement("span");
        icon.style.maskImage = `url('${iconAssetPath(direction < 0 ? "arrow-up3" : "arrow-down4")}')`;
        button.append(icon);
        button.addEventListener("click", () => navigateGitChange(view, direction));
        header.append(button);
      }
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "×"; close.ariaLabel = "Close Git change preview";
      close.addEventListener("click", () => { view.dispatch({ effects: previewGitHunk.of(undefined) }); view.focus(); });
      header.append(close); dom.append(header);
      for (const [label, lines, kind] of [["Index", hunk.before, "before"], ["Current buffer", hunk.after, "after"]] as const) {
        const caption = document.createElement("div"); caption.className = "cm-git-preview-caption"; caption.textContent = label;
        const code = document.createElement("pre"); code.className = `cm-git-preview-${kind}`;
        code.textContent = lines.length ? lines.slice(0, 40).join("\n").slice(0, 12_000) + (lines.length > 40 || lines.join("\n").length > 12_000 ? "\n… Preview shortened" : "") : "(no lines)";
        dom.append(caption, code);
      }
      dom.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); view.dispatch({ effects: previewGitHunk.of(undefined) }); view.focus(); } });
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

/** Recompute after a short typing pause. Never map old line numbers onto an edited document. */
export function gitGutter(initialBaseline?: string, onCount?: (count: number) => void): Extension {
  return [gitGutterState.init(() => ({ baseline: initialBaseline, hunks: [], markers: RangeSet.empty })),
    gutter({ class: "cm-git-gutter", markers: view => view.state.field(gitGutterState).markers, initialSpacer: () => new class extends GutterMarker { toDOM() { const span = document.createElement("span"); span.className = "cm-git-spacer"; return span; } }() }),
    // A separate facet can read document positions, so previews follow the hunk being reviewed.
    showTooltip.compute([gitGutterState], state => {
      const hunk = state.field(gitGutterState).preview;
      return hunk ? { ...hunkTooltip(hunk), pos: state.doc.line(anchorLine(hunk, state.doc.lines)).from } : null;
    }),
    ViewPlugin.fromClass(class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) { this.schedule(0); }
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
      destroy() { clearTimeout(this.timer); }
    }),
    keymap.of([{ key: "Escape", run: view => { if (!view.state.field(gitGutterState).preview) return false; view.dispatch({ effects: previewGitHunk.of(undefined) }); return true; } }]),
  ];
}
