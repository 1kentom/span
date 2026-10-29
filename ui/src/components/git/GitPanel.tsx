import { For, Show, createSignal, createEffect } from "solid-js";
import type { GitChange } from "../../bindings";
import { workspaceGitPath, type GitWorkbench } from "../../stores/git";
import Icon, { FileIcon, MenuIcon } from "../Icon";
import { api } from "../../lib/client";
import "../../styles/git.css";

type GitPanelProps = { git: GitWorkbench; available: boolean };
/** Embedded panels skip the repository header because the Source Control view shows it once. */
type GitPanelViewProps = GitPanelProps & { embedded?: boolean };

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
            <p class="git-note">Git can run filters and hooks, plus remote helpers configured for this repository.</p>
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
  const [confirmDiscard, setConfirmDiscard] = createSignal(false);
  const entry = () => props.entry;
  const status = () => entry().conflicted ? "!" : entry().untracked ? "U" : props.staged ? entry().indexStatus : entry().worktreeStatus;
  const reason = () => entry().unsupportedReason || (
    entry().conflicted ? "Save your conflict resolution, then mark the file resolved."
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
      (target || document.querySelector<HTMLTextAreaElement>(".git-commit-message"))?.focus();
    }
  };
  const finishRowAction = async (button: HTMLButtonElement, action: () => Promise<boolean>) => {
    const hadFocus = document.activeElement === button;
    if (await action()) {
      setConfirmDiscard(false);
      if (hadFocus && !button.isConnected && document.activeElement === document.body) document.querySelector<HTMLTextAreaElement>(".git-commit-message")?.focus();
    }
  };
  const review = () => props.git.openDiff(entry().path!, props.staged ? "staged" : "working");
  return (
    <div class="git-change-item"><div class="git-change-row" classList={{ "is-conflicted": entry().conflicted }}>
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
      <Show when={entry().conflicted && !props.staged}>
        <button class="git-row-action" aria-label={`Open conflict file ${entry().displayPath}`} title={workspaceGitPath(props.git.context(), entry().path || "") === undefined ? "This conflict is outside the opened folder. Open the repository folder to edit it." : "Open conflict markers in the editor"} disabled={!props.git.canOpenWorkingFile() || !entry().path || workspaceGitPath(props.git.context(), entry().path || "") === undefined} onClick={() => props.git.openWorkingFile(entry().path!)}><Icon name="Edit2" size={14} /></button>
        <button class="git-row-action" aria-label={`Mark ${entry().displayPath} resolved`} title="Save your resolution, then mark this file resolved" disabled={!props.git.integrationReady() || !entry().path} onClick={event => void finishRowAction(event.currentTarget, () => props.git.markResolved(entry().path!))}><Icon name="TickCircle" size={14} /></button>
      </Show>
      <Show when={!props.staged && props.git.supportsDiscard() && props.git.mutable(entry()) && !entry().untracked && !entry().oldPath && entry().worktreeStatus === "M"}>
        <button class="git-row-action git-danger" aria-label={`Discard saved changes in ${entry().displayPath}`} title="Restore the index version of this text file, preserving a recovery copy" disabled={!props.git.ready()} aria-expanded={confirmDiscard()} onClick={() => setConfirmDiscard(value => !value)}><Icon name="Trash" size={13} /></button>
      </Show>
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
    <Show when={confirmDiscard()}><div class="git-confirmation" role="group" aria-label={`Confirm discard of ${entry().displayPath}`}><p>Restore the saved index version of {entry().displayPath}? Span will keep a recovery copy of the current saved content. Save or close unsaved editor changes first.</p><div class="git-inline-actions"><button class="button" onClick={() => setConfirmDiscard(false)}>Cancel</button><button class="button" disabled={!props.git.ready()} onClick={event => void finishRowAction(event.currentTarget, () => props.git.discardFile(entry().path!))}>Discard saved changes</button></div></div></Show>
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

export function GitPanel(props: GitPanelViewProps) {
  const g = props.git;
  const [abortConfirmation, setAbortConfirmation] = createSignal(false);
  const isRebasing = () => !!g.status()?.operation?.includes("rebase");
  createEffect(() => { if (isRebasing() && !g.integrationState() && !g.integrationLoading() && !g.integrationError()) void g.loadIntegrationState(); });
  const [helpError, setHelpError] = createSignal("");
  const openHelp = (event: MouseEvent, url: string) => {
    event.preventDefault();
    setHelpError("");
    void api.openExternal(url).catch(() => setHelpError(`Could not open troubleshooting. Open ${url} in your browser.`));
  };
  const commitShortcut = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (g.canCommit()) void g.commit();
    }
  };
  return (
    <section class="git-panel" tabIndex={-1} aria-label={props.embedded ? "Git changes" : "Git source control"} aria-busy={g.loading()}>
      <Show when={!props.embedded}><GitRepositoryHeader git={g} available={props.available} /></Show>
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
        <Show when={g.errorHelp()}>{url => <>
          <a href={url()} target="_blank" rel="noopener noreferrer" onClick={event => openHelp(event, url())}>Troubleshoot Git startup</a>
          <Show when={helpError()}><span role="status">{helpError()}</span></Show>
        </>}</Show>
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
          <Show when={status().operation || status().entries.some(entry => entry.conflicted)}>
            <div class="git-integration-banner">
              <strong>{isRebasing() ? "Rebase in progress" : status().entries.some(entry => entry.conflicted) ? "Resolve merge conflicts" : "Git operation in progress"}</strong>
              <p>{status().entries.some(entry => entry.conflicted) ? "Open each conflicted file, save your resolution, then mark it resolved." : isRebasing() ? "All conflicts are resolved. Continue the rebase when the staged changes are ready." : "Finish the current Git operation before committing."}</p>
              <Show when={isRebasing()}><div class="git-inline-actions"><button class="button" disabled={!g.integrationReady() || status().entries.some(entry => entry.conflicted)} onClick={() => void g.rebaseControl("continue")}>Continue rebase</button><button class="button" aria-expanded={abortConfirmation()} disabled={!g.integrationReady()} onClick={() => setAbortConfirmation(value => !value)}>Abort rebase…</button></div></Show>
              <Show when={g.integrationError()}><div class="git-error" role="alert">{g.integrationError()}<button class="git-text-action" onClick={() => void g.loadIntegrationState()}>Refresh conflict state</button></div></Show>
              <Show when={abortConfirmation()}><div class="git-confirmation" role="group" aria-label="Confirm rebase abort"><p>Abort this rebase and restore its starting state? Saved conflict resolutions may be discarded.</p><div class="git-inline-actions"><button class="button" onClick={() => setAbortConfirmation(false)}>Cancel</button><button class="button" disabled={!g.integrationReady()} onClick={async event => { const button = event.currentTarget; const hadFocus = document.activeElement === button; if (await g.rebaseControl("abort")) { setAbortConfirmation(false); if (hadFocus && !button.isConnected && document.activeElement === document.body) document.querySelector<HTMLTextAreaElement>(".git-commit-message")?.focus(); } }}>Abort rebase</button></div></div></Show>
            </div>
          </Show>
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
            <p class="git-note">Git operation in progress: {status().operation}. Commits are unavailable while it is active.</p>
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
