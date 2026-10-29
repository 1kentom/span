import { Show, createSignal } from "solid-js";
import type { GitWorkbench } from "../../stores/git";

export function GitSetup(props: { git: GitWorkbench; allowInitialize?: boolean }) {
  const [cloning, setCloning] = createSignal(false);
  const [source, setSource] = createSignal("");
  const [destination, setDestination] = createSignal("");
  return <div class="git-inline-form">
    <p class="git-note">Clone into a new folder, or initialize the open folder when it has no repository. Git access still requires enabling the repository.</p>
    <div class="git-inline-actions"><Show when={props.allowInitialize !== false}><button class="button" disabled={!!props.git.operation()} onClick={() => void props.git.initializeRepository()}>Initialize repository</button></Show><button class="button" aria-expanded={cloning()} onClick={() => setCloning(value => !value)}>Clone repository</button></div>
    <Show when={cloning()}><form onSubmit={async event => { event.preventDefault(); if (await props.git.cloneRepository(source().trim(), destination().trim())) { setCloning(false); setSource(""); setDestination(""); } }}>
      <label for="git-clone-source">Repository URL or local path</label><input id="git-clone-source" required value={source()} onInput={event => setSource(event.currentTarget.value)} />
      <label for="git-clone-destination">Absolute destination folder</label><input id="git-clone-destination" required value={destination()} onInput={event => setDestination(event.currentTarget.value)} />
      <p class="git-note">Choose a new folder that does not yet exist. Public HTTPS or an already configured SSH agent can authenticate the clone.</p>
      <button class="button" disabled={!!props.git.operation() || !source().trim() || !destination().trim()}>Clone</button>
    </form></Show>
  </div>;
}
