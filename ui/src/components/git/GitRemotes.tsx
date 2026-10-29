import { GitSetup } from "./GitSetup";
import { For, Show, createSignal, createMemo, createEffect, on } from "solid-js";
import type { GitWorkbench } from "../../stores/git";

export function GitRemotes(props: { git: GitWorkbench }) {
  const g = props.git;
  const [editing, setEditing] = createSignal<string>();
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [remove, setRemove] = createSignal<string>();
  const repositoryIdentity = createMemo(() => g.context()?.repository?.id);
  createEffect(on(repositoryIdentity, () => { setEditing(undefined); setRemove(undefined); setName(""); setUrl(""); }));
  return <details class="git-remotes-editor"><summary>Manage remotes</summary>
    <For each={g.remotes()?.remotes}>{remote => <div class="git-inline-form"><strong>{remote.name}</strong><span class="git-worktree-path">{remote.fetchUrl}</span><div class="git-inline-actions"><button class="git-text-action" disabled={!g.ready()} onClick={() => { setEditing(remote.name); setName(remote.name); setUrl(remote.fetchUrl); }}>Edit URL</button><button class="git-text-action git-danger" disabled={!g.ready()} onClick={() => setRemove(remote.name)}>Remove</button></div><Show when={remove() === remote.name}><div class="git-confirmation"><p>Remove remote {remote.name} and its remote tracking configuration?</p><button class="button" onClick={() => setRemove(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={async () => { if (await g.configureRemote("remove", remote.name)) setRemove(undefined); }}>Remove remote</button></div></Show></div>}</For>
    <button class="git-text-action" disabled={!g.ready()} onClick={() => { setEditing(""); setName(""); setUrl(""); }}>Add remote</button>
    <Show when={editing() !== undefined}><form class="git-inline-form" onSubmit={async event => { event.preventDefault(); if (await g.configureRemote(editing() ? "setUrl" : "add", name().trim(), url().trim())) setEditing(undefined); }}><label for="git-remote-name">Name</label><input id="git-remote-name" required disabled={!!editing()} value={name()} onInput={event => setName(event.currentTarget.value)} /><label for="git-remote-url">URL</label><input id="git-remote-url" required value={url()} onInput={event => setUrl(event.currentTarget.value)} /><div class="git-inline-actions"><button type="button" class="button" onClick={() => setEditing(undefined)}>Cancel</button><button class="button" disabled={!g.ready() || !name().trim() || !url().trim()}>Save remote</button></div></form></Show>
    <label class="git-auto-fetch"><input type="checkbox" checked={g.autoFetchEnabled()} onChange={event => g.setAutoFetchEnabled(event.currentTarget.checked)} />Automatically fetch this repository</label>
    <Show when={g.autoFetchEnabled()}><label class="git-auto-fetch">Fetch interval (minutes)<input type="number" min="1" max="1440" value={g.autoFetchMinutes()} onChange={event => g.setAutoFetchMinutes(Number(event.currentTarget.value))} /></label></Show>
    <p class="git-note" role="status"><Show when={g.autoFetching()}>Fetching in background. </Show>{g.lastFetch() ? `Last background fetch: ${new Date(g.lastFetch()!).toLocaleTimeString()}` : "No background fetch this session."}{g.autoFetchError() ? ` ${g.autoFetchError()}` : ""}</p>
    <details class="git-clone-another"><summary>Clone another repository</summary><GitSetup git={g} allowInitialize={false} /></details>
  </details>;
}
