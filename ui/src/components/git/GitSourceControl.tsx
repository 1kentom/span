import { For, Show, createEffect, type JSX } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import type { GitSubView, GitView } from "../../stores/git-view";
import { GitRepositoryViews } from "./GitRepositoryViews";
import { GitRemotes } from "./GitRemotes";
import { GitSetup } from "./GitSetup";
import { GitHistory } from "./GitHistory";
import { GitOperationNotice, GitPanel, GitRepositoryHeader } from "./GitPanel";

type GitSourceControlProps = {
  git: GitWorkbench; view: GitView; available: boolean;
  /** True while the sidebar shows the Git view; History only reads commits while visible. */
  active: boolean;
  /** The active editor path, used by the This file scope when no file was named explicitly. */
  activePath?: string; github?: JSX.Element; onResolveConflict?: (path: string) => void;
};

const subViews: { id: GitSubView; label: string }[] = [{ id: "changes", label: "Changes" }, { id: "history", label: "History" }, { id: "branches", label: "Branches" }, { id: "stashes", label: "Stash" }, { id: "worktrees", label: "Worktrees" }, { id: "github", label: "GitHub" }];

/** One Source Control view keeps repository workflows within the same consent boundary. */
export function GitSourceControl(props: GitSourceControlProps) {
  const g = props.git;
  const v = props.view;
  createEffect(() => { if (props.active && g.context()?.enabled && !g.remotes() && !g.resourceLoading().remotes && !g.resourceErrors().remotes) void g.loadResource("remotes"); });
  let list!: HTMLDivElement;
  const refresh = () => {
    if (v.subView() === "history") void g.refresh().then(() => g.loadHistory());
    else if (["branches", "stashes", "worktrees"].includes(v.subView())) void g.refresh().then(() => g.loadResource(v.subView() as "branches" | "stashes" | "worktrees"));
    else void g.refresh().then(() => { if (v.subView() === "changes" && (g.status()?.operation || g.status()?.entries.some(entry => entry.conflicted))) return g.loadIntegrationState(); });
  };
  function keydown(event: KeyboardEvent) {
    const index = subViews.findIndex(item => item.id === v.subView());
    const next = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) ? (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + subViews.length) % subViews.length
      : event.key === "Home" ? 0 : event.key === "End" ? subViews.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    v.setSubView(subViews[next].id);
    list.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <section class="git-source-control" tabIndex={-1} aria-label="Git source control">
      <div ref={list} class="git-subview-switch" role="tablist" aria-label="Source control view" onKeyDown={keydown}>
        <For each={subViews}>{item => (
          <button
            type="button"
            role="tab"
            id={`git-subview-${item.id}`}
            aria-selected={v.subView() === item.id}
            aria-controls={`git-subview-panel-${item.id}`}
            tabIndex={v.subView() === item.id ? 0 : -1}
            onClick={() => v.setSubView(item.id)}
          >
            {item.label}
          </button>
        )}</For>
      </div>
      <GitRepositoryHeader git={g} available={props.available} onRefresh={refresh} />
      <Show when={props.available && (!g.hasWorkspace() || (g.context() && !g.context()?.repository))}><GitSetup git={g} allowInitialize={g.hasWorkspace()} /></Show>
      <Show when={g.context()?.enabled}>
        <Show when={g.resourceErrors().remotes}><div class="git-error" role="alert">{g.resourceErrors().remotes}<button class="git-text-action" onClick={() => void g.loadResource("remotes")}>Review remotes</button></div></Show>
        <GitRemotes git={g} />
        <div class="git-remote-actions" aria-label="Remote operations">
          <Show when={g.resourceLoading().remotes}><span role="status">Reading remotes…</span></Show>
          <Show when={g.operation()}><span role="status">{g.operation()}…</span></Show>
        </div>
      </Show>
      <Show when={g.warning() && v.subView() !== "changes"}><div class="git-warning" role="status">{g.warning()}</div></Show>
      <Show when={v.subView() === "history"}><GitOperationNotice git={g} /></Show>
      <Show when={v.subView() === "changes"}>
        <div class="git-subview-panel" role="tabpanel" id="git-subview-panel-changes" aria-labelledby="git-subview-changes">
          <GitPanel git={g} available={props.available} embedded onResolveConflict={props.onResolveConflict} />
        </div>
      </Show>
      <Show when={v.subView() === "history"}>
        <div class="git-subview-panel" role="tabpanel" id="git-subview-panel-history" aria-labelledby="git-subview-history">
          <GitHistory
            git={g}
            available={props.available}
            active={props.active}
            filePath={v.scope() === "file" ? v.target() ?? props.activePath : props.activePath}
            scope={v.scope()}
            onScope={v.setScope}
            embedded
          />
        </div>
      </Show>
      <Show when={v.subView() === "github"}><div class="git-subview-panel" role="tabpanel" id="git-subview-panel-github" aria-labelledby="git-subview-github">{props.github || <p class="git-note">GitHub integration is unavailable.</p>}</div></Show>
      <For each={["branches", "stashes", "worktrees"] as const}>{kind => <Show when={v.subView() === kind}>
        <div class="git-subview-panel" role="tabpanel" id={`git-subview-panel-${kind}`} aria-labelledby={`git-subview-${kind}`}>
          <GitRepositoryViews git={g} kind={kind} active={props.active} onShowChanges={() => v.setSubView("changes")} />
        </div>
      </Show>}</For>
    </section>
  );
}
