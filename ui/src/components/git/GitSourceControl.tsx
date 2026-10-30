import { For, Show } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import type { GitSubView, GitView } from "../../stores/git-view";
import { GitHistory } from "./GitHistory";
import { GitPanel, GitRepositoryHeader } from "./GitPanel";

type GitSourceControlProps = {
  git: GitWorkbench; view: GitView; available: boolean;
  /** True while the sidebar shows the Git view; History only reads commits while visible. */
  active: boolean;
  /** The active editor path, used by the This file scope when no file was named explicitly. */
  activePath?: string;
};

const subViews: { id: GitSubView; label: string }[] = [{ id: "changes", label: "Changes" }, { id: "history", label: "History" }];

/** One Source Control view: repository header, a Changes | History switch, then the chosen sub-view. */
export function GitSourceControl(props: GitSourceControlProps) {
  const g = props.git;
  const v = props.view;
  let list!: HTMLDivElement;
  const refresh = () => {
    if (v.subView() === "history") void g.refresh().then(() => g.loadHistory());
    else void g.refresh();
  };
  function keydown(event: KeyboardEvent) {
    const index = subViews.findIndex(item => item.id === v.subView());
    const next = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key) ? (index + 1) % subViews.length
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
      <Show when={v.subView() === "changes"}>
        <div class="git-subview-panel" role="tabpanel" id="git-subview-panel-changes" aria-labelledby="git-subview-changes">
          <GitPanel git={g} available={props.available} embedded />
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
    </section>
  );
}
