import { For, Show, createEffect, createSignal, createMemo, on } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import type { GitHistoryScope } from "../../stores/git-view";
import Icon, { FileIcon } from "../Icon";
import { gitCommitGraph, gitCommitDate } from "../../lib/git-format";
import { GitRepositoryHeader } from "./GitPanel";
import { GitHistoryTools } from "./GitHistoryTools";

type GitHistoryProps = {
  git: GitWorkbench; available: boolean; active: boolean; filePath?: string;
  /** Controlled scope; without it the component keeps its own, starting at All commits. */
  scope?: GitHistoryScope; onScope?: (scope: GitHistoryScope) => void;
  /** Hides the repository header when a parent view already shows it. */
  embedded?: boolean;
};

const scopes: { id: GitHistoryScope; label: string }[] = [{ id: "all", label: "All commits" }, { id: "file", label: "This file" }];

export function GitHistory(props: GitHistoryProps) {
  const g = props.git;
  const [advanced, setAdvanced] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<string>();
  const graph = createMemo(() => gitCommitGraph(g.history()?.commits || []));
  const graphWidth = () => Math.min(88, Math.max(18, ...graph().map(row => row.width)));
  const [ownScope, setOwnScope] = createSignal<GitHistoryScope>("all");
  const scope = () => props.scope ?? ownScope();
  const setScope = (next: GitHistoryScope) => { if (props.onScope) props.onScope(next); else setOwnScope(next); };
  const workingFile = () => props.filePath && props.filePath !== "span:settings" && !props.filePath.startsWith("span:git:") && !props.filePath.startsWith("settings://") ? props.filePath : undefined;
  const activeRepoPath = () => workingFile() && g.context()?.repository
    ? [g.context()!.repository!.workspacePrefix, workingFile()].filter(Boolean).join("/")
    : undefined;
  const enabled = () => !!g.context()?.enabled && !!g.context()?.repository;
  // Load whenever the shown scope differs from what the store holds; file scope waits for a working file.
  createEffect(on(
    () => [props.active, g.context()?.repository?.id, g.context()?.enabled, scope(), activeRepoPath(), g.context()?.repository?.head, g.context()?.repository?.branch] as const,
    ([active, repository, isEnabled, current, path]) => {
      if (!active || !repository || !isEnabled) return;
      const wanted = current === "file" ? path : null;
      if (current === "file" && !wanted) return;
      if ((g.historyPath() ?? null) !== wanted || (!g.history() && !g.historyLoading())) void g.loadHistory(wanted);
    },
  ));
  const refresh = () => { void g.refresh().then(() => g.loadHistory()); };
  let group!: HTMLDivElement;
  const available = (id: GitHistoryScope) => enabled() && (id === "all" || !!activeRepoPath());
  function scopeKey(event: KeyboardEvent) {
    const index = scopes.findIndex(item => item.id === scope());
    const next = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) ? (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + scopes.length) % scopes.length
      : event.key === "Home" ? 0 : event.key === "End" ? scopes.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    if (!available(scopes[next].id)) return;
    setScope(scopes[next].id);
    group.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return (
    <section class="git-history" aria-label="Git history">
      <Show when={!props.embedded}><GitRepositoryHeader git={g} available={props.available} onRefresh={refresh} /></Show>
      <Show when={props.available && enabled()}><button class="button" aria-expanded={advanced()} onClick={() => setAdvanced(value => !value)}>{advanced() ? "Back to commit history" : "Advanced history"}</button></Show>
      <Show when={advanced()}><GitHistoryTools git={g} path={activeRepoPath()} /></Show>
      <Show when={!advanced()}>
      <div ref={group} class="git-history-filter" role="radiogroup" aria-label="History scope" onKeyDown={scopeKey}>
        <For each={scopes}>{item => (
          <button
            type="button"
            role="radio"
            aria-checked={scope() === item.id}
            tabIndex={scope() === item.id ? 0 : -1}
            disabled={scope() !== item.id && !available(item.id)}
            title={item.id === "file" ? activeRepoPath() || "Open a working file to view its history" : "Every commit in the repository"}
            onClick={() => setScope(item.id)}
          >
            {item.label}
          </button>
        )}</For>
      </div>
      <Show when={scope() === "file" && enabled() && !activeRepoPath()}><p class="git-note">Open a working file to view its history.</p></Show>
      <Show when={g.historyPath()}><p class="git-note">{g.historyPath()}</p></Show>
      <Show when={props.available && !g.context()?.repository && !g.loading()}>
        <div class="git-empty">{g.context()?.unavailableReason || "Open a folder inside a Git repository to view history."}</div>
      </Show>
      <Show when={g.error()}><div class="git-error" role="alert">{g.error()}</div></Show>
      <Show when={g.historyError()}>
        <div class="git-error" role="alert">
          {g.historyError()}
          <button class="button" onClick={() => void g.loadHistory()}>Retry history</button>
        </div>
      </Show>
      <Show when={!props.available}><div class="git-empty">Git history requires the desktop app.</div></Show>
      <Show when={g.history()?.commits.length}><div class="git-resource-filter"><Icon name="SearchNormal1" size={14} /><input type="search" aria-label="Filter loaded commits" placeholder="Filter loaded commits…" value={filter()} onInput={event => setFilter(event.currentTarget.value)} /></div></Show>
      <div class="git-scroll">
        <For each={g.history()?.commits || []}>{(commit, index) => (
          <article class="git-history-item" hidden={!!filter() && !`${commit.subject} ${commit.author} ${commit.id}`.toLocaleLowerCase().includes(filter().toLocaleLowerCase())}>
            <div class="git-history-row">
              <svg class="git-history-graph" width={scope() === "file" ? 18 : graphWidth()} height="38" viewBox={`0 0 ${scope() === "file" ? 18 : graphWidth()} 38`} aria-hidden="true">
                <Show when={scope() === "all"}><For each={graph()[index()]?.edges}>{edge => <path d={edge.path} class={`git-graph-lane-${edge.lane % 4}`} />}</For></Show>
                <circle cx={scope() === "file" ? 8 : graph()[index()]?.x || 8} cy="18" r={commit.parents.length > 1 ? 4 : 3} />
              </svg>
              <button
                class="git-history-entry"
                aria-label={`Review commit ${commit.id.slice(0, 8)}: ${commit.subject}`}
                title={commit.body || commit.subject}
                onClick={() => g.openDiff(g.historyPath(), "commit", commit)}
              >
                <span class="git-history-subject">{commit.subject}</span>
                <span class="git-history-meta">
                  <span>{commit.author}</span>
                  <code>{commit.id.slice(0, 8)}</code>
                  <time dateTime={gitCommitDate(commit.timestamp).dateTime} title={gitCommitDate(commit.timestamp).detail}>{gitCommitDate(commit.timestamp).label}</time>
                </span>
              </button>
              <button class="git-row-action" aria-label={`Show details for commit ${commit.id.slice(0, 8)}`} aria-expanded={selected() === commit.id} onClick={() => { if (selected() === commit.id) setSelected(undefined); else { setSelected(commit.id); void g.loadCommitDetails(commit); } }}><Icon name={selected() === commit.id ? "arrow-down4" : "arrow-right4"} size={12} /></button>
            </div>
            <Show when={selected() === commit.id}>
              <div class="git-history-details">
                <p>{commit.body || commit.subject}</p>
                <div class="git-history-meta"><span title={commit.authorEmail}>{commit.author}</span><span>{gitCommitDate(commit.timestamp).detail}</span></div>
                <code class="git-full-hash">{commit.id}</code>
                <Show when={commit.parents.length}><div class="git-note">{commit.parents.length > 1 ? "Merge parents" : "Parent"}: {commit.parents.map(parent => parent.slice(0, 8)).join(", ")}</div></Show>
                <Show when={g.detailsLoading()}><p class="git-note" role="status">Reading commit files…</p></Show>
                <Show when={g.detailsError()}><div class="git-error" role="alert">{g.detailsError()}<button class="git-text-action" onClick={() => void g.loadCommitDetails(commit)}>Retry</button></div></Show>
                <Show when={g.commitDetails()?.commit.id === commit.id}><For each={g.commitDetails()?.files}>{file => <button class="git-commit-file" title={file.oldPath ? `${file.oldPath} renamed to ${file.path}` : file.path} onClick={() => g.openDiff(file.path, "commit", commit)}><FileIcon path={file.path} /><span>{file.path}</span><code>{file.status}</code></button>}</For></Show>
              </div>
            </Show>
          </article>
        )}</For>
        <Show when={filter() && g.history()?.commits.length && !g.history()?.commits.some(commit => `${commit.subject} ${commit.author} ${commit.id}`.toLocaleLowerCase().includes(filter().toLocaleLowerCase()))}><div class="git-empty">No loaded commits match this filter.</div></Show>
        <Show when={g.history()?.nextSkip != null}>
          <button class="button git-more" disabled={g.historyLoading()} onClick={() => void g.loadHistory(g.historyPath(), true)}>
            Load more commits
          </button>
        </Show>
        <Show when={g.history() && !g.history()?.commits.length && !g.historyLoading()}>
          <div class="git-empty">No commits in this history.</div>
        </Show>
        <Show when={g.historyLoading()}><div class="git-empty" role="status">Reading commits…</div></Show>
      </div>
      </Show>
    </section>
  );
}
