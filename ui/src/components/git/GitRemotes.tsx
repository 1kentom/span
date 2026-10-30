import { GitSetup } from "./GitSetup";
import { For, Show, createSignal, createMemo, createEffect, on } from "solid-js";
import type { GitWorkbench } from "../../stores/git";

export function GitRemotes(props: { git: GitWorkbench }) {
  const g = props.git;
  const repositoryIdentity = createMemo(() => g.context()?.repository?.id);
  const [selected, setSelected] = createSignal("");
  const [target, setTarget] = createSignal("");
  const [upstream, setUpstream] = createSignal(true);
  const [reviewed, setReviewed] = createSignal(false);
  const [completed, setCompleted] = createSignal(false);
  const selectedRemote = () => g.remotes()?.remotes.find(remote => remote.name === selected());
  createEffect(on(() => g.status()?.repository.branch, branch => { if (branch && !target()) setTarget(branch); }));
  createEffect(on(() => g.remotes()?.configFingerprint, () => { setReviewed(false); }));
  createEffect(on(repositoryIdentity, () => {
    setSelected(""); setTarget(g.status()?.repository.branch || ""); setReviewed(false); setCompleted(false);
  }));
  createEffect(() => {
    const remotes = g.remotes()?.remotes;
    if (remotes && !remotes.some(remote => remote.name === selected())) setSelected((remotes.find(remote => remote.current) || remotes[0])?.name || "");
  });
  const editNetwork = () => { setReviewed(false); setCompleted(false); };
  const run = async (action: "fetch" | "pull" | "push") => {
    const root = repositoryIdentity();
    const succeeded = await g.remoteSelected(action, selected(), action === "fetch" ? undefined : target(), action === "push" && upstream());
    if (succeeded && repositoryIdentity() === root) { setCompleted(true); setReviewed(false); }
  };
  const [editing, setEditing] = createSignal<string>();
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [remove, setRemove] = createSignal<string>();
  createEffect(on(repositoryIdentity, () => { setEditing(undefined); setRemove(undefined); setName(""); setUrl(""); }));
  return <><div class="git-inline-form" aria-label="Selected remote operations">
    <label for="git-network-remote">Remote</label><select id="git-network-remote" value={selected()} disabled={!!g.operation()} onChange={event => { setSelected(event.currentTarget.value); editNetwork(); }}><For each={g.remotes()?.remotes}>{remote => <option value={remote.name} selected={selected() === remote.name}>{remote.name}</option>}</For></select>
    <Show when={selectedRemote()}>{remote => <p class="git-note">Fetch: {remote().fetchUrl}<br />Push: {remote().pushUrl}</p>}</Show>
    <label for="git-network-branch">Remote branch (pull or push)</label><input id="git-network-branch" value={target()} disabled={!!g.operation()} placeholder={g.status()?.repository.branch || "branch name"} onInput={event => { setTarget(event.currentTarget.value); editNetwork(); }} />
    <label class="git-auto-fetch"><input type="checkbox" checked={upstream()} onChange={event => { setUpstream(event.currentTarget.checked); editNetwork(); }} />Set upstream after push</label>
    <p class="git-note">Push sends the current branch to the named remote branch without force. Pull uses fast-forward only.</p>
    <label class="git-auto-fetch"><input type="checkbox" checked={reviewed()} disabled={!selectedRemote() || !!g.operation()} onChange={event => { setReviewed(event.currentTarget.checked); setCompleted(false); }} />I reviewed this remote and target</label>
    <div class="git-inline-actions"><button class="git-text-action" disabled={!g.ready() || !reviewed() || completed()} onClick={() => void run("fetch")}>Fetch</button><button class="git-text-action" disabled={!g.ready() || !reviewed() || completed() || !target().trim()} onClick={() => void run("pull")}>Pull</button><button class="git-text-action" disabled={!g.ready() || !reviewed() || completed() || !target().trim() || !g.status()?.repository.branch} onClick={() => void run("push")}>Push</button></div>
  </div><details class="git-remotes-editor"><summary>Manage remotes</summary>
    <For each={g.remotes()?.remotes}>{remote => <div class="git-inline-form"><strong>{remote.name}</strong><span class="git-worktree-path">{remote.fetchUrl}</span><div class="git-inline-actions"><button class="git-text-action" disabled={!g.ready()} onClick={() => { setEditing(remote.name); setName(remote.name); setUrl(remote.fetchUrl); }}>Edit URL</button><button class="git-text-action git-danger" disabled={!g.ready()} onClick={() => setRemove(remote.name)}>Remove</button></div><Show when={remove() === remote.name}><div class="git-confirmation"><p>Remove remote {remote.name} and its remote tracking configuration?</p><button class="button" onClick={() => setRemove(undefined)}>Cancel</button><button class="button" disabled={!g.ready()} onClick={async () => { const root = repositoryIdentity(); if (await g.configureRemote("remove", remote.name) && repositoryIdentity() === root) setRemove(undefined); }}>Remove remote</button></div></Show></div>}</For>
    <button class="git-text-action" disabled={!g.ready()} onClick={() => { setEditing(""); setName(""); setUrl(""); }}>Add remote</button>
    <Show when={editing() !== undefined}><form class="git-inline-form" onSubmit={async event => { event.preventDefault(); const root = repositoryIdentity(); if (await g.configureRemote(editing() ? "setUrl" : "add", name().trim(), url().trim()) && repositoryIdentity() === root) setEditing(undefined); }}><label for="git-remote-name">Name</label><input id="git-remote-name" required disabled={!!editing()} value={name()} onInput={event => setName(event.currentTarget.value)} /><label for="git-remote-url">URL</label><input id="git-remote-url" required value={url()} onInput={event => setUrl(event.currentTarget.value)} /><div class="git-inline-actions"><button type="button" class="button" onClick={() => setEditing(undefined)}>Cancel</button><button class="button" disabled={!g.ready() || !name().trim() || !url().trim()}>Save remote</button></div></form></Show>
    <label class="git-auto-fetch"><input type="checkbox" checked={g.autoFetchEnabled()} onChange={event => g.setAutoFetchEnabled(event.currentTarget.checked)} />Automatically fetch this repository</label>
    <Show when={g.autoFetchEnabled()}><label class="git-auto-fetch">Fetch interval (minutes)<input type="number" min="1" max="1440" value={g.autoFetchMinutes()} onChange={event => g.setAutoFetchMinutes(Number(event.currentTarget.value))} /></label></Show>
    <p class="git-note" role="status"><Show when={g.autoFetching()}>Fetching in background. </Show>{g.lastFetch() ? `Last background fetch: ${new Date(g.lastFetch()!).toLocaleTimeString()}` : "No background fetch this session."}{g.autoFetchError() ? ` ${g.autoFetchError()}` : ""}</p>
    <details class="git-clone-another"><summary>Clone another repository</summary><GitSetup git={g} allowInitialize={false} /></details>
  </details></>;
}
