import { For, Show, createEffect, createSignal } from "solid-js";
import type { GitWorkbench } from "../../stores/git";
import Icon from "../Icon";
import { GitOperationNotice } from "./GitPanel";

type Resource = "branches" | "stashes" | "worktrees";
type Props = { git: GitWorkbench; kind: Resource; active: boolean; onShowChanges?: () => void };

/** Repository workflows use inline forms so drafts and the repository remain visible. */
export function GitRepositoryViews(props: Props) {
  const g = props.git;
  let createButton!: HTMLButtonElement;
  let tagButton!: HTMLButtonElement;
  const focusInput = (input: HTMLInputElement) => queueMicrotask(() => { if (input.isConnected) input.focus(); });
  const finishRemoval = async (button: HTMLButtonElement, action: () => Promise<boolean>, fallback: () => HTMLButtonElement) => {
    const hadFocus = document.activeElement === button;
    if (await action()) {
      setConfirmation(undefined);
      if (hadFocus && !button.isConnected && document.activeElement === document.body) { const target = fallback(); (target?.disabled ? target.closest(".git-source-control")?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]') : target)?.focus(); }
    }
  };
  const [tagName, setTagName] = createSignal("");
  const [showTagForm, setShowTagForm] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [path, setPath] = createSignal("");
  const [confirmation, setConfirmation] = createSignal<string>();
  const items = () => props.kind === "branches" ? g.branches() : props.kind === "stashes" ? g.stashes() : g.worktrees();
  createEffect(() => {
    if (props.active && g.context()?.enabled && !items() && !g.resourceLoading()[props.kind] && !g.resourceErrors()[props.kind]) void g.loadResource(props.kind);
  });
  createEffect(() => {
    if (props.active && props.kind === "branches" && g.context()?.enabled && !g.tags() && !g.resourceLoading().tags && !g.resourceErrors().tags) void g.loadResource("tags");
  });
  const matches = (text: string) => text.toLocaleLowerCase().includes(query().toLocaleLowerCase());
  const currentTree = (treePath: string) => treePath.replace(/\/$/, "") === g.context()?.repository?.root.replace(/\/$/, "");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const ok = props.kind === "branches" ? await g.checkout(name().trim(), true)
      : props.kind === "stashes" ? await g.stash("save", undefined, name())
        : await g.addWorktree(path().trim(), name().trim());
    if (ok) { setCreating(false); setName(""); setPath(""); createButton.focus(); }
  };
  return <section class="git-repository-view" aria-label={`Git ${props.kind}`} aria-busy={g.resourceLoading()[props.kind] || !!g.operation()}>
    <div class="git-resource-toolbar">
      <strong>{props.kind === "branches" ? "Branches" : props.kind === "stashes" ? "Stashes" : "Worktrees"}</strong>
      <span class="git-count">{items()?.length ?? ""}</span>
      <button ref={createButton} class="git-text-action" disabled={!g.ready()} aria-expanded={creating()} onClick={() => setCreating(value => !value)}>
        <Icon name="Add" size={13} />{props.kind === "stashes" ? "Stash" : "New"}
      </button>
    </div>
    <Show when={creating()}><form class="git-inline-form" onSubmit={submit}>
      <label for="git-resource-name">{props.kind === "branches" ? "New branch from HEAD" : props.kind === "stashes" ? "Stash message (optional)" : "Existing local branch"}</label>
      <input ref={focusInput} id="git-resource-name" value={name()} required={props.kind !== "stashes"} placeholder={props.kind === "branches" ? "feature/branch-name" : props.kind === "stashes" ? "Work in progress" : "feature/branch-name"} onInput={event => setName(event.currentTarget.value)} />
      <Show when={props.kind === "worktrees"}>
        <label for="git-worktree-path">Absolute folder path</label>
        <input id="git-worktree-path" value={path()} required placeholder="Absolute path to a new folder" onInput={event => setPath(event.currentTarget.value)} />
      </Show>
      <p class="git-note">{props.kind === "stashes" ? "Save tracked changes and restore a clean working tree. Untracked files remain on disk." : props.kind === "worktrees" ? "The branch must be available for checkout in a separate working directory." : "Create the branch and switch to it. Save or stash existing disk changes first."}</p>
      <div class="git-inline-actions"><button type="button" class="button" onClick={() => { setCreating(false); createButton.focus(); }}>Cancel</button><button class="button primary" disabled={!g.ready() || (props.kind !== "stashes" && !name().trim()) || (props.kind === "worktrees" && !path().trim())}>{g.operation() ? "Working…" : props.kind === "branches" ? "Create branch" : props.kind === "stashes" ? "Save stash" : "Add worktree"}</button></div>
    </form></Show>
    <Show when={items()?.length}><div class="git-resource-filter"><Icon name="SearchNormal1" size={14} /><input type="search" aria-label={`Filter ${props.kind}`} placeholder={`Filter ${props.kind}…`} value={query()} onInput={event => setQuery(event.currentTarget.value)} /></div></Show>
    <Show when={g.error()}><div class="git-error" role="alert">{g.error()}</div></Show>
    <GitOperationNotice git={g} />
    <Show when={g.resourceErrors()[props.kind]}><div class="git-error" role="alert">{g.resourceErrors()[props.kind]}<button class="git-text-action" onClick={() => void g.loadResource(props.kind)}>Try again</button></div></Show>
    <div class="git-scroll">
      <Show when={props.kind === "branches"}>
        <For each={[false, true]}>{remote => <Show when={g.branches()?.some(branch => branch.remote === remote && matches(branch.name))}>
          <div class="git-section-heading"><strong>{remote ? "Remote branches" : "Local branches"}</strong></div>
          <For each={g.branches()?.filter(branch => branch.remote === remote && matches(branch.name))}>{branch => <><div class="git-resource-entry" classList={{ "is-current": branch.current }}>
            <Icon name="Hierarchy" size={15} /><div class="git-resource-copy"><strong>{branch.name}</strong><Show when={branch.upstream}><span title={branch.upstream ?? ""}>{branch.upstream}</span></Show><Show when={branch.ahead || branch.behind}><span>{branch.ahead} ahead · {branch.behind} behind</span></Show></div>
            <Show when={branch.current} fallback={<Show when={!remote}><div class="git-branch-actions"><button class="git-text-action" aria-label={`Switch to ${branch.name}`} disabled={!g.ready()} onClick={event => void finishRemoval(event.currentTarget, () => g.checkout(branch.name), () => createButton)}>Switch</button><button class="git-text-action" aria-label={`Fast-forward merge ${branch.name}`} disabled={!g.ready()} onClick={() => setConfirmation(`merge:${branch.commitId}`)}>Merge</button><button class="git-text-action" aria-label={`Rebase onto ${branch.name}`} disabled={!g.ready()} onClick={() => setConfirmation(`rebase:${branch.commitId}`)}>Rebase</button></div></Show>}><span class="git-badge">Current</span></Show>
          </div>
          <Show when={confirmation() === `merge:${branch.commitId}`}><div class="git-confirmation" role="group" aria-label={`Confirm fast-forward merge of ${branch.name}`}><p>Fast-forward the current branch to {branch.name} at {branch.commitId.slice(0, 8)}? The working tree must be clean. Git will refuse if the branches diverged.</p><div class="git-inline-actions"><button class="button" onClick={() => setConfirmation(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={event => void finishRemoval(event.currentTarget, () => g.mergeFastForward(branch.commitId), () => createButton)}>Fast-forward merge</button></div></div></Show>
          <Show when={confirmation() === `rebase:${branch.commitId}`}><div class="git-confirmation" role="group" aria-label={`Confirm rebase onto ${branch.name}`}><p>Rebase the current branch onto {branch.name} at {branch.commitId.slice(0, 8)}? This rewrites local commit IDs. The working tree must be clean.</p><div class="git-inline-actions"><button class="button" onClick={() => setConfirmation(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={async event => { await finishRemoval(event.currentTarget, () => g.rebase(branch.commitId), () => createButton); if (g.status()?.operation?.includes("rebase")) props.onShowChanges?.(); }}>Start rebase</button></div></div></Show>
          </> }</For>
        </Show>}</For>
      </Show>
      <Show when={props.kind === "branches" && g.context()?.enabled}>
        <div class="git-section-heading"><strong>Local tags</strong><span class="git-count">{g.tags()?.length ?? ""}</span><button ref={tagButton} class="git-row-action" aria-label="Create local tag" aria-expanded={showTagForm()} disabled={!g.ready() || !g.status()?.repository.head} onClick={() => setShowTagForm(value => !value)}><Icon name="Add" size={13} /></button></div>
        <Show when={showTagForm()}><form class="git-inline-form" onSubmit={async event => { event.preventDefault(); const target = g.status()?.repository.head; if (target && await g.createTag(tagName().trim(), target)) { setTagName(""); setShowTagForm(false); tagButton.focus(); } }}>
          <label for="git-tag-name">Lightweight tag at HEAD</label><input ref={focusInput} id="git-tag-name" required placeholder="v1.0.0" value={tagName()} onInput={event => setTagName(event.currentTarget.value)} /><div class="git-inline-actions"><button type="button" class="button" onClick={() => { setShowTagForm(false); tagButton.focus(); }}>Cancel</button><button class="button" disabled={!g.ready() || !tagName().trim()}>Create tag</button></div>
        </form></Show>
        <Show when={g.resourceErrors().tags}><div class="git-error" role="alert">{g.resourceErrors().tags}<button class="git-text-action" onClick={() => void g.loadResource("tags")}>Retry tags</button></div></Show>
        <For each={g.tags()?.filter(tag => matches(tag.name))}>{tag => <article class="git-tag-entry"><div class="git-resource-entry"><Icon name="Link2" size={14} /><div class="git-resource-copy"><strong>{tag.name}</strong><code title={tag.targetId}>{tag.targetId.slice(0, 8)}{tag.annotated ? " · Annotated" : ""}</code></div><button class="git-row-action git-danger" aria-label={`Delete local tag ${tag.name}`} disabled={!g.ready()} onClick={() => setConfirmation(`tag:${tag.name}`)}><Icon name="Trash" size={13} /></button></div><Show when={confirmation() === `tag:${tag.name}`}><div class="git-confirmation" role="group" aria-label={`Confirm deletion of local tag ${tag.name}`}><p>Delete local tag {tag.name} at {tag.targetId.slice(0, 8)}? Remote tags stay unchanged.</p><div class="git-inline-actions"><button class="button" onClick={() => setConfirmation(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={event => void finishRemoval(event.currentTarget, () => g.deleteTag(tag.name, tag.objectId), () => tagButton)}>Delete local tag</button></div></div></Show></article>}</For>
        <Show when={g.tags() && !g.tags()?.length}><p class="git-note">No local tags.</p></Show>
      </Show>
      <Show when={props.kind === "stashes"}>
        <For each={g.stashes()?.filter(stash => matches(`${stash.subject} ${stash.selector}`))}>{stash => <article class="git-stash-entry">
          <div class="git-resource-entry"><Icon name="u-box" size={15} /><div class="git-resource-copy"><strong>{stash.subject}</strong><code title={stash.id}>{stash.selector} · {stash.id.slice(0, 8)}</code></div></div>
          <div class="git-inline-actions"><button class="git-text-action" disabled={!g.ready()} aria-label={`Apply ${stash.selector}`} onClick={() => void g.stash("apply", stash.id)}>Apply</button></div>
          <p class="git-note">Apply restores the saved changes and keeps this stash.</p>
        </article>}</For>
      </Show>
      <Show when={props.kind === "worktrees"}>
        <For each={g.worktrees()?.filter(tree => matches(`${tree.path} ${tree.branch || ""}`))}>{tree => <article class="git-worktree-entry">
          <div class="git-resource-entry"><Icon name="Folder2" size={15} /><div class="git-resource-copy"><strong>{tree.branch || (tree.bare ? "Bare repository" : "Detached HEAD")}</strong><span class="git-worktree-path" title={tree.path}>{tree.path}</span><code>{tree.head?.slice(0, 8)}</code></div><Show when={currentTree(tree.path)}><span class="git-badge">Current</span></Show><Show when={tree.locked}><span class="git-badge">Locked</span></Show></div>
          <Show when={!currentTree(tree.path) && !tree.bare}><div class="git-inline-actions"><button class="git-text-action git-danger" disabled={!g.ready() || tree.locked} title={tree.locked ? "Unlock this worktree using Git before removing it" : "Remove a clean worktree without force"} aria-label={`Remove worktree ${tree.path}`} onClick={() => setConfirmation(tree.path)}>Remove</button></div></Show>
          <Show when={confirmation() === tree.path}><div class="git-confirmation" role="group" aria-label="Confirm worktree removal"><p>Remove the working directory at {tree.path}? Git will refuse if it contains local changes.</p><div class="git-inline-actions"><button class="button" onClick={() => setConfirmation(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={event => void finishRemoval(event.currentTarget, () => g.removeWorktree(tree.path), () => createButton)}>Remove worktree</button></div></div></Show>
        </article>}</For>
      </Show>
      <Show when={g.resourceLoading()[props.kind]}><div class="git-loading" role="status"><span /><span /><span />Reading {props.kind}…</div></Show>
      <Show when={items() && !items()?.length && !g.resourceLoading()[props.kind]}><div class="git-empty"><strong>{props.kind === "stashes" ? "No stashed changes" : props.kind === "worktrees" ? "No worktrees" : "No branches"}</strong><span>{props.kind === "stashes" ? "Stash your tracked changes to switch tasks and restore them later." : props.kind === "branches" ? "Create a branch after the repository has its first commit." : "Use a separate working directory to work on another branch."}</span></div></Show>
      <Show when={query() && items()?.length && !(props.kind === "branches" ? g.branches()?.some(branch => matches(branch.name)) : props.kind === "stashes" ? g.stashes()?.some(stash => matches(`${stash.subject} ${stash.selector}`)) : g.worktrees()?.some(tree => matches(`${tree.path} ${tree.branch || ""}`)))}><div class="git-empty">No matching {props.kind}.</div></Show>
      <Show when={!g.context()?.enabled}><div class="git-empty">Enable Git for this repository to manage {props.kind}.</div></Show>
    </div>
  </section>;
}
