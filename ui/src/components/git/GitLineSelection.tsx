import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { GitLineReview } from "../../bindings";
import { createGitLineSelection } from "../../stores/git-line-selection";
import "../../styles/git-line-selection.css";

export type GitLineAction = (review: GitLineReview, lineIds: string[], includeMetadata: boolean) => Promise<void> | void;
export function GitLineSelection(props: { review: GitLineReview; disabled?: boolean; onAction?: GitLineAction; onHunkAction?: (id: string) => void }) {
  const selection = createGitLineSelection(() => props.review);
  const [pending, setPending] = createSignal(false), [error, setError] = createSignal<string>();
  const [visible, setVisible] = createSignal(300);
  const identity = createMemo(() => JSON.stringify(props.review));
  createEffect(() => { identity(); setError(undefined); setVisible(300); });
  const verb = () => props.review.diff.side === "staged" ? "Unstage" : "Stage";
  const blocked = () => props.disabled || pending() || !selection.supported();
  async function apply() {
    const request = selection.request();
    if (!request || blocked() || !props.onAction || (!request.lineIds.length && !request.includeMetadata)) return;
    setPending(true); setError(undefined);
    try { await props.onAction(request.review, request.lineIds, request.includeMetadata); }
    catch (reason) { setError(String(reason)); }
    finally { setPending(false); }
  }
  return <section class="git-line-selection" aria-label="Select reviewed Git lines" aria-busy={pending()}>
    <div class="git-review-toolbar" role="toolbar" aria-label="Selected line actions">
      <button class="button" disabled={blocked() || !props.onAction || (!selection.selected().size && !selection.metadata())} onClick={apply}>{verb()} selected ({selection.selected().size})</button>
      <button class="button" disabled={pending()} onClick={selection.clear}>Clear selection</button>
      <span>Space selects a changed line. Shift selects a range.</span>
    </div>
    <Show when={!selection.supported()}><p class="git-note" role="status">Selected-line actions are unavailable for binary, truncated, commit, or over 10,000-line reviews. Use whole-file actions.</p></Show>
    <Show when={props.review.metadata.length}><label class="git-line-metadata"><input type="checkbox" checked={selection.metadata()} disabled={blocked()} onChange={event => selection.setMetadata(event.currentTarget.checked)} /> Include file metadata: {props.review.metadata.join(", ")}</label></Show>
    <Show when={error()}><div class="git-error" role="alert">{error()} Selection is preserved. Refresh the comparison manually before retrying a stale review.</div></Show>
    <div class="git-line-review-scroll" role="region" aria-label="Read-only selectable comparison" tabIndex={0}>
      <For each={props.review.hunks}>{(hunk, hunkIndex) => {
        const offset = () => props.review.hunks.slice(0, hunkIndex()).reduce((count, value) => count + value.lines.length, 0);
        return <Show when={offset() < visible()}><div class="git-split-header">{hunk.header}<Show when={props.onHunkAction}><button class="git-hunk-action" disabled={blocked()} onClick={() => props.onHunkAction?.(hunk.id)}>{verb()} hunk</button></Show></div>
          <For each={hunk.lines.slice(0, Math.max(0, Math.min(visible(), 10_000) - offset()))}>{line => <div class="git-selectable-line" classList={{ "git-line-added": line.kind === "insert", "git-line-removed": line.kind === "delete", "git-line-selected": selection.selected().has(line.id) }}>
            <Show when={line.id && (line.kind === "insert" || line.kind === "delete")} fallback={<span class="git-line-selector" />}><button class="git-line-selector" role="checkbox" aria-checked={selection.selected().has(line.id)} aria-label={`Select ${line.kind === "insert" ? "added" : "removed"} line ${line.newLine ?? line.oldLine}`} disabled={blocked()} onClick={event => selection.toggle(line.id, event.shiftKey)} onKeyDown={event => { if (event.key === " " && event.shiftKey) { event.preventDefault(); selection.toggle(line.id, true); } }}>{selection.selected().has(line.id) ? "✓" : ""}</button></Show>
            <span class="git-line-number" aria-hidden="true">{line.oldLine}</span><span class="git-line-number" aria-hidden="true">{line.newLine}</span><code>{line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " "}{line.text.replace(/\n$/, "") || " "}</code>
          </div>}</For></Show>;
      }}</For>
      <Show when={visible() < Math.min(10_000, props.review.hunks.reduce((count, hunk) => count + hunk.lines.length, 0))}><button class="button git-more" onClick={() => setVisible(value => value + 300)}>Show next lines</button></Show>
    </div>
  </section>;
}
