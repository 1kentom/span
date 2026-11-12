import { For, Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import type { GitSubView, GitView } from "../../stores/git-view";
import { GitRepositoryViews } from "./GitRepositoryViews";
import { GitRemotes } from "./GitRemotes";
import { GitSetup } from "./GitSetup";
import { GitHistory } from "./GitHistory";
import { GitOperationNotice, GitPanel, GitRepositoryHeader } from "./GitPanel";
import Icon from "../Icon";

type GitSourceControlProps = {
  git: GitWorkbench; view: GitView; available: boolean;
  /** True while the sidebar shows the Git view; History only reads commits while visible. */
  active: boolean;
  /** The active editor path, used by the This file scope when no file was named explicitly. */
  activePath?: string; github?: JSX.Element; onResolveConflict?: (path: string) => void;
};

const subViews: { id: GitSubView; label: string; icon: string }[] = [{ id: "changes", label: "Changes", icon: "DocumentText" }, { id: "history", label: "History", icon: "Clock" }, { id: "branches", label: "Branches", icon: "Hierarchy" }, { id: "stashes", label: "Stash", icon: "u-box" }, { id: "worktrees", label: "Worktrees", icon: "Folder2" }, { id: "github", label: "GitHub", icon: "Code1" }];

/** One Source Control view keeps repository workflows within the same consent boundary. */
export function GitSourceControl(props: GitSourceControlProps) {
  const g = props.git;
  const v = props.view;
  const [toolsOpen, setToolsOpen] = createSignal(false);
  let tools!: HTMLDivElement;
  let toolsButton!: HTMLButtonElement;
  createEffect(on(() => g.context()?.repository?.id, (id, previousId) => { if (id !== previousId) setToolsOpen(false); }));
  createEffect(() => { if (!props.active || !g.context()?.enabled) setToolsOpen(false); });
  createEffect(() => {
    if (!toolsOpen()) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !tools?.contains(event.target)) setToolsOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  });
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
      <GitRepositoryHeader git={g} available={props.available} onRefresh={refresh} tools={<Show when={g.context()?.enabled}>
        <div ref={tools} class="git-repo-tools" data-open={toolsOpen() ? "true" : "false"} onKeyDown={event => { if (event.key === "Escape" && toolsOpen()) { event.preventDefault(); event.stopPropagation(); setToolsOpen(false); toolsButton?.focus(); } }}>
          <button ref={toolsButton} type="button" class="git-repo-tools-trigger" aria-label="Repository actions" title="Repository actions" aria-expanded={toolsOpen()} aria-controls="git-repository-actions" onClick={() => setToolsOpen(value => !value)}><Icon name="3DotsMore" size={14} /></button>
          <div id="git-repository-actions" class="git-repo-tools-body" hidden={!toolsOpen()} role="group" aria-label="Repository actions"><GitRemotes git={g} /></div>
        </div>
      </Show>} />
      <div ref={list} class="git-subview-switch" role="tablist" aria-label="Source control view" onKeyDown={keydown}>
        <For each={subViews}>{item => (
          <button
            type="button"
            role="tab"
            aria-label={item.label}
            title={item.label}
            id={`git-subview-${item.id}`}
            aria-selected={v.subView() === item.id}
            aria-controls={`git-subview-panel-${item.id}`}
            tabIndex={v.subView() === item.id ? 0 : -1}
            onClick={() => v.setSubView(item.id)}
          >
            <Icon name={item.icon} size={14} /><span class="git-subview-label">{item.label}</span>
          </button>
        )}</For>
      </div>
      <Show when={props.available && (!g.hasWorkspace() || (g.context() && !g.context()?.repository))}><GitSetup git={g} allowInitialize={g.hasWorkspace()} /></Show>
      <Show when={g.context()?.enabled}>
        <Show when={g.resourceErrors().remotes}><div class="git-error" role="alert">{g.resourceErrors().remotes}<button class="git-text-action" onClick={() => void g.loadResource("remotes")}>Review remotes</button></div></Show>
        <Show when={g.resourceLoading().remotes || g.operation()}><div class="git-remote-actions" aria-label="Remote operations">
          <Show when={g.resourceLoading().remotes}><span role="status">Reading remotes…</span></Show>
          <Show when={g.operation()}><span role="status">{g.operation()}…</span></Show>
        </div></Show>
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
