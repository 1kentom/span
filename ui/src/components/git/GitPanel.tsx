import { For, Show } from "solid-js";
import type { GitChange } from "../../bindings";
import type { GitWorkbench } from "../../stores/git";
import Icon, { FileIcon, MenuIcon } from "../Icon";
import "../../styles/git.css";

type GitPanelProps = { git: GitWorkbench; available: boolean };

export function GitRepositoryHeader(props: GitPanelProps & { onRefresh?: () => void }) {
  const repository = () => props.git.status()?.repository || props.git.context()?.repository;
  const refresh = () => {
    if (props.onRefresh) props.onRefresh();
    else void props.git.refresh();
  };
  return (
    <header class="git-repo-header">
      <div class="git-repo-row">
        <strong>{repository() ? "Repository" : "Source control"}</strong>
        <button
          class="icon-button"
          aria-label="Refresh Git"
          title="Refresh Git"
          disabled={!props.available || !props.git.hasWorkspace() || props.git.loading() || !!props.git.operation()}
          onClick={refresh}
        >
          <Icon name="Refresh2" size={15} />
        </button>
      </div>
      <Show when={repository()}>{repo => (
        <>
          <div class="git-repo-path" title={repo().root}>{repo().root}</div>
          <div class="git-repo-branch">
            <Icon name="Hierarchy" size={14} />
            <span>
              {!props.git.context()?.enabled ? "Git not enabled" : repo().detached ? `Detached HEAD · ${repo().head?.slice(0, 8)}` : repo().branch || "Unborn branch"}
              {props.git.context()?.enabled && repo().unborn ? " · No commits" : ""}
            </span>
          </div>
          <Show when={!props.git.context()?.enabled}>
            <p class="git-note">Git can run filters and hooks configured for this repository.</p>
            <button class="button" aria-label="Enable Git" disabled={props.git.loading() || !!props.git.operation()} onClick={() => void props.git.enable()}>
              {props.git.operation() === "enable" ? "Enabling Git…" : "Enable Git"}
            </button>
          </Show>
          <Show when={repo().workspacePrefix}>
            <div class="git-note">
              Opened folder: {repo().workspacePrefix}. This view includes the whole repository.
            </div>
          </Show>
        </>
      )}</Show>
    </header>
  );
}

function GitChangeRow(props: { git: GitWorkbench; entry: GitChange; staged: boolean }) {
  const entry = () => props.entry;
  const status = () => entry().conflicted ? "!" : entry().untracked ? "U" : props.staged ? entry().indexStatus : entry().worktreeStatus;
  const reason = () => entry().unsupportedReason || (
    entry().conflicted ? "Resolve this conflict outside Span, then refresh."
      : entry().submodule ? "Submodule changes are shown for review; staging submodules is unavailable."
        : undefined
  );
  const statusClass = () => entry().conflicted ? "conflict"
    : status() === "D" ? "deleted"
      : status() === "A" || entry().untracked ? "added" : "modified";
  let actionButton!: HTMLButtonElement;
  const changeAction = async () => {
    const current = entry();
    const hadFocus = document.activeElement === actionButton;
    const succeeded = await (props.staged ? props.git.unstage([current]) : props.git.stage([current]));
    if (succeeded && hadFocus && !actionButton.isConnected && document.activeElement === document.body) {
      const label = `Review ${props.staged ? "working" : "staged"} changes in ${current.displayPath}`;
      const target = [...document.querySelectorAll<HTMLButtonElement>(".git-change-open")].find(button => button.getAttribute("aria-label") === label);
      target?.focus();
    }
  };
  const review = () => props.git.openDiff(entry().path!, props.staged ? "staged" : "working");
  return (
    <div class="git-change-row">
      <button
        class="git-change-open"
        aria-label={`Review ${props.staged ? "staged" : "working"} changes in ${entry().displayPath}`}
        disabled={!entry().path || !!entry().unsupportedReason}
        title={reason() || `${entry().displayOldPath ? `${entry().displayOldPath} renamed to ` : ""}${entry().displayPath}`}
        onClick={review}
      >
        <FileIcon path={entry().displayPath} />
        <span class="git-change-name">{entry().displayPath}</span>
        <span class={`git-change-status ${statusClass()}`} aria-label={`Git status ${status()}`}>
          {status()}
        </span>
      </button>
      <button
        ref={actionButton}
        class="git-row-action"
        aria-label={`${props.staged ? "Unstage" : "Stage"} ${entry().displayPath}`}
        disabled={!props.git.ready() || !props.git.mutable(entry())}
        title={reason() || `${props.staged ? "Unstage" : "Stage"} saved file`}
        onClick={changeAction}
      >
        <Icon name={props.staged ? "Minus" : "Add"} size={14} />
      </button>
    </div>
  );
}

function GitChanges(props: { git: GitWorkbench; staged: boolean }) {
  const entries = () => props.staged ? props.git.staged() : props.git.changed();
  const mutable = () => entries().filter(props.git.mutable);
  const changeAll = () => {
    if (props.staged) void props.git.unstage(mutable());
    else void props.git.stage(mutable());
  };
  return (
    <section aria-label={props.staged ? "Staged changes" : "Working changes"}>
      <div class="git-section-heading">
        <strong>{props.staged ? "Staged changes" : "Changes"}</strong>
        <span class="git-count">{entries().length}</span>
        <button
          class="git-row-action"
          aria-label={props.staged ? "Unstage all changes" : "Stage all changes"}
          title={mutable().length !== entries().length ? "Some entries are unsupported here. Use per-file actions for the supported files." : props.staged ? "Unstage all changes" : "Stage all changes"}
          disabled={!props.git.ready() || !mutable().length || mutable().length !== entries().length || !!props.git.status()?.truncated}
          onClick={changeAll}
        >
          <Icon name={props.staged ? "Minus" : "Add"} size={14} />
        </button>
      </div>
      <For each={entries().map(entry => entry.id)}>{id => {
        const initial = entries().find(entry => entry.id === id)!;
        return <GitChangeRow git={props.git} entry={entries().find(entry => entry.id === id) || initial} staged={props.staged} />;
      }}</For>
    </section>
  );
}

export function GitPanel(props: GitPanelProps) {
  const g = props.git;
  const commitShortcut = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (g.canCommit()) void g.commit();
    }
  };
  return (
    <section class="git-panel" tabIndex={-1} aria-label="Git source control" aria-busy={g.loading()}>
      <GitRepositoryHeader git={g} available={props.available} />
      <Show when={!props.available}>
        <div class="git-empty">
          <strong>Native Git required</strong>
          <span>Open the desktop app to review and commit real repository changes. Browser preview does not run Git.</span>
        </div>
      </Show>
      <Show when={props.available && !g.hasWorkspace()}>
        <div class="git-empty"><strong>No folder open</strong><span>Open a folder inside a Git repository to review changes.</span></div>
      </Show>
      <Show when={g.error()}><div class="git-error" role="alert">
        {g.error()}
        <Show when={g.errorHelp()}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">Troubleshoot Git startup</a>}</Show>
      </div></Show>
      <Show when={g.warning()}><div class="git-warning" role="status">Commit completed with a warning: {g.warning()}</div></Show>
      <Show when={g.notice()}><div class="git-success" role="status">{g.notice()}</div></Show>
      <Show when={props.available && g.context() && !g.context()?.repository}>
        <div class="git-empty">
          <strong>No repository available</strong>
          <span>{g.context()?.unavailableReason || "Open a folder inside a Git repository."}</span>
        </div>
      </Show>
      <Show when={g.status()}>{status => (
        <>
          <div class="git-commit-box">
            <label for="git-commit-message">Commit message</label>
            <textarea
              id="git-commit-message"
              class="git-commit-message"
              aria-label="Git commit message"
              placeholder="Describe the staged changes"
              value={g.message()}
              onInput={event => g.setMessage(event.currentTarget.value)}
              onKeyDown={commitShortcut}
            />
            <div class="git-commit-actions">
              <button class="button primary" disabled={!g.canCommit()} onClick={() => void g.commit()}>
                <MenuIcon name="save" size={14} />
                {g.operation() === "commit" ? "Committing…" : `Commit ${g.staged().length} staged ${g.staged().length === 1 ? "file" : "files"}`}
              </button>
            </div>
            <span class="git-note">Staging uses saved files on disk. Unsaved editor changes stay in the editor.</span>
          </div>
          <Show when={status().operation}>
            <p class="git-note">Git operation in progress: {status().operation}. Finish it outside Span before committing here.</p>
          </Show>
          <Show when={status().truncated}>
            <p class="git-error">The repository exceeds the status display limit. Whole-repository actions and Commit are unavailable until the complete staged list can be reviewed.</p>
          </Show>
          <div class="git-scroll">
            <GitChanges git={g} staged />
            <GitChanges git={g} staged={false} />
            <Show when={!status().entries.length}>
              <div class="git-empty"><strong>Working tree clean</strong><span>No staged or working changes.</span></div>
            </Show>
          </div>
        </>
      )}</Show>
      <Show when={g.loading() && !g.status()}><div class="git-empty" role="status">Reading repository…</div></Show>
    </section>
  );
}
