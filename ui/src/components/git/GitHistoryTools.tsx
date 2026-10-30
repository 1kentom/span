import { For, Show, createMemo, createSignal, createEffect, on } from "solid-js";
import type { GitDiff } from "../../bindings";
import type { GitWorkbench } from "../../stores/git";
import { createGitHistoryTools } from "../../stores/git-history-tools";
import { gitCommitGraph, gitCommitDate } from "../../lib/git-format";
import { GitDiffView } from "./GitDiffView";
import "../../styles/history-tools.css";

export function GitHistoryTools(props: { git: GitWorkbench; path?: string }) {
  const tools = createGitHistoryTools({ context: props.git.context });
  const [author, setAuthor] = createSignal(""), [message, setMessage] = createSignal(""), [path, setPath] = createSignal(props.path ?? "");
  const [revision, setRevision] = createSignal("HEAD"), [from, setFrom] = createSignal("HEAD"), [to, setTo] = createSignal(""), [start, setStart] = createSignal("1"), [end, setEnd] = createSignal("1");
  const [mode, setMode] = createSignal<"history" | "reflog" | "lines">("history");
  const commits = () => mode() === "lines" ? tools.lines()?.commits ?? [] : tools.history()?.commits ?? [];
  // Omitted parents never acquire a made-up connection to the next visible commit.
  const graph = createMemo(() => { const ids = new Set(commits().map(commit => commit.id)); return gitCommitGraph(commits().map(commit => ({ ...commit, parents: commit.parents.filter(id => ids.has(id)) }))); });
  const diff = createMemo<GitDiff | undefined>(() => { const value = tools.comparison(), repo = props.git.context()?.repository; return value && repo ? { repositoryId: repo.id, path: value.path ?? "", oldPath: null, side: "commit", indexRevision: "", oldText: null, newText: null, patch: value.patch, binary: false, truncated: value.truncated, summary: `${value.from} compared with ${value.to ?? "saved working tree"}`, commitId: null } : undefined; });
  const repositoryIdentity = createMemo(() => {
    const context = props.git.context();
    return JSON.stringify([context?.workspaceRoot, context?.repository?.id, context?.repository?.root, context?.enabled]);
  });
  createEffect(on(repositoryIdentity, () => {
    const initialPath = props.path ?? "";
    setAuthor(""); setMessage(""); setPath(initialPath); setMode("history");
    setRevision("HEAD"); setFrom("HEAD"); setTo(""); setStart("1"); setEnd("1");
    void tools.search({ path: initialPath });
  }));
  const search = () => { setMode("history"); void tools.search({ author: author(), message: message(), path: path() }); };
  return <div class="git-history-tools">
    <form class="git-history-tools-form" onSubmit={event => { event.preventDefault(); search(); }}>
      <strong>All references</strong><span class="git-note">Searches repository history, including branches and tags.</span>
      <label>Author<input value={author()} onInput={event => setAuthor(event.currentTarget.value)} /></label>
      <label>Message<input value={message()} onInput={event => setMessage(event.currentTarget.value)} /></label>
      <label>Repository path<input value={path()} onInput={event => setPath(event.currentTarget.value)} placeholder="All files" /></label>
      <button class="button" disabled={tools.busy().history}>Search history</button>
      <button type="button" class="button" onClick={() => { setMode("reflog"); void tools.loadReflog(); }}>Show HEAD reflog</button>
    </form>
    <For each={Object.entries(tools.errors()).filter(([, value]) => value)}>{([key, value]) => <div class="git-error" role="alert">{key}: {value}</div>}</For>
    <Show when={mode() === "reflog"}>
      <p class="git-note">HEAD reflog records local reference movements. It can change between pages.</p>
      <For each={tools.reflog()?.entries}>{entry => <article class="git-history-item"><code>{entry.selector}</code><p>{entry.subject}</p><button class="git-text-action" onClick={() => { setRevision(entry.commitId); setFrom(entry.commitId); }}>{entry.commitId.slice(0, 8)} · Use revision</button></article>}</For>
      <Show when={tools.reflog()?.nextSkip != null}><button class="button" disabled={tools.busy().reflog} onClick={() => void tools.loadReflog(true)}>More reflog entries</button></Show>
    </Show>
    <Show when={mode() === "lines" && tools.lineRange()}>{range => <p class="git-note">Tracing {range().path}, lines {range().start} to {range().end} at {range().revision}</p>}</Show>
    <Show when={mode() !== "reflog"}>
      <For each={commits()}>{(commit, index) => <article class="git-history-item"><div class="git-history-row">
        <svg class="git-history-graph" width={Math.min(88, Math.max(18, ...graph().map(row => row.width)))} height="38" aria-hidden="true"><For each={graph()[index()]?.edges}>{edge => <path d={edge.path} class={`git-graph-lane-${edge.lane % 4}`} />}</For><circle cx={graph()[index()]?.x ?? 8} cy="18" r={commit.parents.length > 1 ? 4 : 3} /></svg>
        <button class="git-history-entry" onClick={() => props.git.openDiff(path() || undefined, "commit", commit)}><span class="git-history-subject">{commit.subject}</span><span class="git-history-meta">{commit.author} · {commit.id.slice(0, 8)} · {gitCommitDate(commit.timestamp).label}</span></button>
        <button class="git-text-action" aria-label={`Use revision ${commit.id.slice(0, 8)}`} onClick={() => { setRevision(commit.id); setFrom(commit.id); }}>Use</button>
      </div><div class="git-history-ref-list"><For each={tools.history()?.refs.filter(ref => ref.commitId === commit.id)}>{ref => <code>{ref.name}</code>}</For></div></article>}</For>
      <Show when={mode() === "history" && tools.history()?.nextSkip != null}><button class="button" disabled={tools.busy().history} onClick={() => void tools.search({}, true)}>More commits</button></Show>
      <Show when={mode() === "lines" && tools.lines()?.nextSkip != null}><button class="button" disabled={tools.busy().lines} onClick={() => void tools.lineHistory(revision(), props.path!, Number(start()), Number(end()), true)}>More line history</button></Show>
      <Show when={(tools.history() || tools.lines()) && !commits().length}><p class="git-note">No commits match this history.</p></Show>
    </Show>
    <Show when={Object.values(tools.busy()).some(Boolean)}><p class="git-note" role="status">Reading repository history…</p></Show>
    <details><summary>Revision content and comparison</summary>
      <form class="git-history-tools-form" onSubmit={event => { event.preventDefault(); void tools.read(revision(), path()); }}>
        <label>Revision<input required value={revision()} onInput={event => setRevision(event.currentTarget.value)} /></label>
        <p class="git-note">Uses the repository path above. Read-only content from a commit.</p><button class="button" disabled={!path() || tools.busy().content}>Read revision file</button>
      </form>
      <Show when={tools.content()}>{value => <div><p class="git-note">{value().revision} : {value().path}</p><Show when={value().binary || value().truncated} fallback={<pre class="git-revision-content" tabIndex={0} aria-label="Read-only revision content">{value().text}</pre>}><p class="git-note">{value().binary ? "Binary content has no text preview." : "Content exceeds the text preview limit."}</p></Show></div>}</Show>
      <form class="git-history-tools-form" onSubmit={event => { event.preventDefault(); void tools.compare(from(), to() || null, path() || null); }}>
        <label>From revision<input required value={from()} onInput={event => setFrom(event.currentTarget.value)} /></label>
        <label>To revision<input value={to()} onInput={event => setTo(event.currentTarget.value)} placeholder="Saved working tree" /></label>
        <p class="git-note">Leave To empty to compare with saved working tree files. Unsaved editor changes are excluded.</p><button class="button" disabled={tools.busy().comparison}>Compare revisions</button>
      </form>
      <Show when={tools.comparison()}><GitDiffView title="Revision comparison" diff={diff()} loading={!!tools.busy().comparison} onRefresh={() => { const value = tools.comparison()!; void tools.compare(value.from, value.to ?? null, value.path ?? null); }} /></Show>
    </details>
    <details><summary>Line history for active file</summary>
      <p class="git-note">{props.path ?? "Open a working file to trace a numeric line range."} · Line numbers refer to the selected revision.</p>
      <form class="git-history-tools-form" onSubmit={event => { event.preventDefault(); setMode("lines"); void tools.lineHistory(revision(), props.path!, Number(start()), Number(end())); }}>
        <label>Start line<input type="number" required min="1" max="10000000" step="1" value={start()} onInput={event => setStart(event.currentTarget.value)} /></label>
        <label>End line<input type="number" required min={start()} max="10000000" step="1" value={end()} onInput={event => setEnd(event.currentTarget.value)} /></label>
        <p class="git-note">Revision: {revision()}</p><button class="button" disabled={!props.path || tools.busy().lines}>Trace lines</button>
      </form>
    </details>
  </div>;
}
