import { For, Show, createEffect, on } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import { gitCommitDate } from "../../lib/git-format";
import { GitRepositoryHeader } from "./GitPanel";

type GitHistoryProps = { git: GitWorkbench; available: boolean; active: boolean; filePath?: string };

export function GitHistory(props: GitHistoryProps) {
  const g = props.git;
  createEffect(on(
    () => [props.active, g.context()?.repository?.id, g.context()?.enabled] as const,
    ([active, repository, enabled]) => {
      if (active && repository && enabled && !g.history() && !g.historyLoading()) void g.loadHistory();
    },
  ));
  const workingFile = () => props.filePath && props.filePath !== "span:settings" && !props.filePath.startsWith("span:git:") && !props.filePath.startsWith("settings://") ? props.filePath : undefined;
  const activeRepoPath = () => workingFile() && g.context()?.repository
    ? [g.context()!.repository!.workspacePrefix, workingFile()].filter(Boolean).join("/")
    : undefined;
  const refresh = () => { void g.refresh().then(() => g.loadHistory()); };
  return (
    <section class="git-history" aria-label="Git history">
      <GitRepositoryHeader git={g} available={props.available} onRefresh={refresh} />
      <div class="git-history-filter" role="group" aria-label="History scope">
        <button aria-pressed={!g.historyPath()} disabled={!g.context()?.enabled || !g.context()?.repository} onClick={() => void g.loadHistory(null)}>
          Repository
        </button>
        <button
          aria-pressed={!!g.historyPath()}
          disabled={!g.context()?.enabled || !activeRepoPath()}
          title={activeRepoPath() || "Open a working file to view its history"}
          onClick={() => void g.loadHistory(activeRepoPath())}
        >
          Current file
        </button>
      </div>
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
      <div class="git-scroll">
        <For each={g.history()?.commits || []}>{commit => (
          <button
            class="git-history-entry"
            aria-label={`Review commit ${commit.id.slice(0, 8)}: ${commit.subject}`}
            title={commit.body || commit.subject}
            onClick={() => g.openDiff(g.historyPath(), "commit", commit)}
          >
            <span class="git-history-subject">{commit.subject}</span>
            <span class="git-history-meta">
              <code>{commit.id.slice(0, 8)}</code>
              <span>{commit.author}</span>
              <time dateTime={gitCommitDate(commit.timestamp).dateTime} title={gitCommitDate(commit.timestamp).detail}>
                {gitCommitDate(commit.timestamp).label}
              </time>
            </span>
          </button>
        )}</For>
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
    </section>
  );
}
