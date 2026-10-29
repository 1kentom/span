import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { GitDiff, GitCommit, GitHunkDiff } from "../../bindings";
import { gitCommitDate } from "../../lib/git-format";
import Icon from "../Icon";
import { gitDiffLinesCapped, gitNewFileRows, gitPatchRows, MAX_GIT_DIFF_LINES, gitSplitRows, gitWordSegments } from "../../lib/git-diff";
import "../../styles/git.css";
import "../../styles/git-review.css";

type GitDiffViewProps = {
  title: string;
  diff?: GitDiff;
  loading: boolean;
  refreshDisabled?: boolean;
  error?: string;
  onRefresh(): void;
  onOpenFile?: () => void;
  outsideWorkspace?: boolean;
  repositoryRoot?: string;
  commit?: GitCommit;
  hunkData?: GitHunkDiff;
  hunkActionDisabled?: boolean;
  onHunkAction?: (id: string) => void;
  actionError?: string;
};

export function GitDiffView(props: GitDiffViewProps) {
  const [layout, setLayout] = createSignal<"unified" | "split">("unified");
  const [words, setWords] = createSignal(true);
  const [visible, setVisible] = createSignal(300);
  createEffect(on(() => props.diff, () => setVisible(300)));
  const newFileContent = () => !!props.diff && !props.diff.patch && props.diff.oldText == null && props.diff.newText != null;
  const rows = createMemo(() => newFileContent() ? gitNewFileRows(props.diff!.newText!) : gitPatchRows(props.diff?.patch || ""));
  const splitRows = createMemo(() => gitSplitRows(rows()));
  const capped = createMemo(() => gitDiffLinesCapped(props.diff?.patch || props.diff?.newText || ""));
  const side = () => props.diff?.side === "staged" ? "HEAD compared with index"
    : props.diff?.side === "commit" ? "Commit changes" : "Index compared with working file";
  return (
    <section class="git-diff-view" aria-label="Git comparison" aria-busy={props.loading}>
      <header class="git-diff-header">
        <div><strong>{props.title}</strong><span>{side()} · Read only</span></div>
        <Show when={props.onOpenFile || props.outsideWorkspace}>
          <button
            class="button"
            disabled={!props.onOpenFile}
            title={props.outsideWorkspace ? "Open the repository folder to edit this file" : undefined}
            onClick={props.onOpenFile}
          >
            Open working file
          </button>
        </Show>
        <button class="icon-button" aria-label="Refresh Git comparison" disabled={props.loading || props.refreshDisabled} onClick={props.onRefresh}>
          <Icon name="Refresh2" />
        </button>
      </header>
      <Show when={props.repositoryRoot}><p class="git-note">Repository: {props.repositoryRoot}</p></Show>
      <Show when={props.outsideWorkspace}>
        <p class="git-note">This file is outside the opened folder. Open the repository folder to edit it.</p>
      </Show>
      <Show when={props.commit}>{commit => (
        <details class="git-commit-details">
          <summary>{commit().subject}</summary>
          <p>{commit().author} · {gitCommitDate(commit().timestamp).detail}</p>
          <code>{commit().id}</code>
          <pre>{commit().body}</pre>
        </details>
      )}</Show>
      <Show when={props.diff?.side !== "commit"}>
        <p class="git-note">Saved disk and index snapshots. Unsaved editor content is not included.</p>
      </Show>
      <Show when={props.actionError}><div class="git-error" role="alert">{props.actionError}</div></Show>
      <Show when={props.error}><div class="git-error" role="alert">{props.error}</div></Show>
      <Show when={props.loading && !props.diff}><div class="git-empty" role="status">Loading comparison…</div></Show>
      <Show when={props.diff}>{diff => (
        <>
          <Show when={diff().truncated}>
            <p class="git-note" role="status">This comparison exceeds the display limit. Git returned a partial preview.</p>
          </Show>
          <Show when={capped()}><p class="git-note" role="status">This view shows the first {MAX_GIT_DIFF_LINES.toLocaleString()} lines.</p></Show>
          <Show when={diff().summary}><p class="git-note">{diff().summary}</p></Show>
          <Show when={diff().binary}>
            <div class="git-empty">Binary file changed. A text comparison is unavailable.</div>
          </Show>
          <Show
            when={!diff().binary && rows().length > 0}
            fallback={!props.loading && !diff().binary ? <div class="git-empty">{newFileContent() ? "Empty file, no text content." : "No changes in this comparison."}</div> : undefined}
          >
            <div class="git-review-toolbar" role="toolbar" aria-label="Diff display">
              <button class="button" aria-pressed={layout() === "unified"} onClick={() => setLayout("unified")}>Unified</button>
              <button class="button" aria-pressed={layout() === "split"} onClick={() => setLayout("split")}>Split</button>
              <label><input type="checkbox" checked={words()} onChange={event => setWords(event.currentTarget.checked)} /> Word changes in split view</label>
            </div>
            <Show when={layout() === "split"}><div class="git-split-scroll" tabIndex={0} role="region" aria-label="Read-only split comparison">
              <div class="git-split-labels"><span>Before</span><span>After</span></div>
              <For each={splitRows().slice(0, visible())}>{row => {
                const segments = () => row.left?.kind === "removed" && row.right?.kind === "added" && words() ? gitWordSegments(row.left.text.slice(1), row.right.text.slice(1)) : undefined;
                return <Show when={!row.header} fallback={<div class="git-split-header">{row.header?.text}<Show when={props.onHunkAction && props.hunkData?.hunks.find(hunk => hunk.header === row.header?.text)}>{hunk => <button class="git-hunk-action" disabled={props.loading || props.hunkActionDisabled} onClick={() => props.onHunkAction?.(hunk().id)}>{props.diff?.side === "staged" ? "Unstage hunk" : "Stage hunk"}</button>}</Show></div>}>
                  <div class="git-split-row"><For each={[row.left, row.right]}>{(cell, index) => <div class={`git-split-cell git-line-${cell?.kind || "empty"}`}><span class="git-line-number" aria-hidden="true">{index() === 0 ? cell?.oldLine : cell?.newLine}</span><code><Show when={segments()} fallback={cell?.text.slice(1) || " "}>{parts => <For each={parts()[index()]}>{part => <span classList={{ "git-word-change": part.changed }}>{part.text}</span>}</For>}</Show></code></div>}</For></div>
                </Show>;
              }}</For>
              <Show when={visible() < splitRows().length}><button class="button git-more" onClick={() => setVisible(value => value + 300)}>Show next lines ({splitRows().length - visible()} remaining)</button></Show>
            </div></Show>
            <Show when={layout() === "unified"}><div class="git-patch-scroll" tabIndex={0} role="region" aria-label="Read-only Git patch">
              <pre class="git-patch">
                <For each={rows().slice(0, visible())}>{row => (
                  <span class={`git-patch-line git-line-${row.kind}`}>
                    <span class="git-line-number" aria-hidden="true">{row.oldLine}</span>
                    <span class="git-line-number" aria-hidden="true">{row.newLine}</span>
                    <span>{row.text || " "}</span>
                    <Show when={props.onHunkAction && row.kind === "header" && props.hunkData?.hunks.find(hunk => hunk.header === row.text)}>{hunk => <button class="git-hunk-action" disabled={props.loading || props.hunkActionDisabled} aria-label={`${props.diff?.side === "staged" ? "Unstage" : "Stage"} hunk ${hunk().header}`} onClick={() => props.onHunkAction?.(hunk().id)}>{props.diff?.side === "staged" ? "Unstage hunk" : "Stage hunk"}</button>}</Show>{"\n"}
                  </span>
                )}</For>
              </pre>
              <Show when={visible() < rows().length}>
                <button class="button git-more" onClick={() => setVisible(value => value + 300)}>
                  Show next {Math.min(300, rows().length - visible())} lines ({rows().length - visible()} remaining)
                </button>
              </Show>
            </div></Show>
          </Show>
        </>
      )}</Show>
    </section>
  );
}
