import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { FileEntry } from "../bindings";
import type { Workbench } from "../stores/workbench";
import Icon, { FileIcon } from "./Icon";
import { MAX_CHAIN_DEPTH, compactChain, isSourceRoot } from "../lib/compact-tree";
import { compactFolders } from "../lib/explorer-prefs";

export function Explorer(props: { workbench: Workbench; view: "Files" | "Search" | "Git" | "History"; onNavigate: (path: string, line?: number) => void; onFileDragStart?: (event: DragEvent, path: string) => void }) {
  const w = props.workbench;
  const [query, setQuery] = createSignal("");
  let timer: ReturnType<typeof setTimeout>;
  onCleanup(() => clearTimeout(timer));
  const search = (value: string) => { setQuery(value); clearTimeout(timer); timer = setTimeout(() => void w.search(value), 180); };
  function treeKey(event: KeyboardEvent) {
    if (!event.currentTarget || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    rows[index]?.focus(); event.preventDefault();
  }
  // Compact folder chains: one row per chain, identified by its deepest directory.
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set());
  const attempted = new Set<string>();
  const markPending = (path: string, on: boolean) => setPending(current => { const next = new Set(current); if (on) next.add(path); else next.delete(path); return next; });
  async function toggleChain(paths: string[]) {
    const deepest = paths[paths.length - 1];
    if (w.expanded().has(deepest)) { await w.toggleDirectory(deepest); return; }
    for (const path of paths) if (!w.expanded().has(path)) await w.toggleDirectory(path);
  }
  /** Load the only child directory of an expanded chain so the chain can continue. Reuses the cached lazy listing. */
  async function extendChain(parent: string, child: string) {
    const generation = w.workspaceGeneration(); attempted.add(`${generation}\0${child}`);
    markPending(child, true);
    try {
      await w.loadDirectory(child);
      if (generation !== w.workspaceGeneration() || !w.directories[child] || !w.expanded().has(parent)) return;
      if (!w.expanded().has(child)) await w.toggleDirectory(child);
    } finally { markPending(child, false); }
  }
  const TreeRows = (rowProps: { path: string; depth: number }) => <For each={w.directories[rowProps.path] || []}>{entry => <TreeRow entry={entry} depth={rowProps.depth} />}</For>;
  const TreeRow = (rowProps: { entry: FileEntry; depth: number }) => {
    const entry = rowProps.entry;
    const chain = createMemo(() => entry.isDir && compactFolders() ? compactChain(entry.path, w.directories) : undefined);
    const target = () => chain()?.deepest ?? entry.path;
    /** A tail directory discovered below an expanded parent whose listing has not arrived yet. It is shown open so the row does not flip. */
    const awaitingTail = () => { const current = chain(); if (!current || current.segments.length < 2 || w.directories[current.deepest]) return false; return w.expanded().has(current.segments[current.segments.length - 2].path) && !attempted.has(`${w.workspaceGeneration()}\0${current.deepest}`) || pending().has(current.deepest); };
    const expanded = () => entry.isDir && (w.expanded().has(target()) || pending().has(target()) || awaitingTail());
    const merged = () => (chain()?.segments.length ?? 1) > 1;
    createEffect(() => {
      const current = chain();
      if (!current || current.segments.length > MAX_CHAIN_DEPTH) return;
      const tail = current.segments[current.segments.length - 1].path;
      const previous = current.segments[current.segments.length - 2]?.path;
      // Case 1: the tail was just discovered below an expanded directory, so load and open it.
      if (previous !== undefined && !w.directories[tail] && w.expanded().has(previous) && !attempted.has(`${w.workspaceGeneration()}\0${tail}`)) { void extendChain(previous, tail); return; }
      // Case 2: the open tail lists exactly one directory, so continue the chain.
      if (!expanded() || current.segments.length >= MAX_CHAIN_DEPTH) return;
      const listing = w.directories[current.deepest];
      if (!listing || listing.length !== 1 || !listing[0].isDir) return;
      const child = listing[0].path;
      if (isSourceRoot(child) || w.directories[child] || attempted.has(`${w.workspaceGeneration()}\0${child}`)) return;
      void extendChain(current.deepest, child);
    });
    const toggle = () => void toggleChain(chain()?.segments.map(segment => segment.path) ?? [entry.path]);
    return <>
      <button class={`tree-row ${w.activePath() === entry.path ? "selected" : ""}`} role="treeitem" data-path={target()} aria-level={rowProps.depth + 1} aria-expanded={entry.isDir ? expanded() : undefined} aria-label={entry.isDir && merged() ? target() : undefined} aria-selected={!entry.isDir && w.activePath() === entry.path} draggable={!entry.isDir && !!props.onFileDragStart} onDragStart={event => { if (!entry.isDir) props.onFileDragStart?.(event, entry.path); }} style={{ "padding-left": `${12 + rowProps.depth * 16}px` }} onClick={() => entry.isDir ? toggle() : props.onNavigate(entry.path)} onKeyDown={e => {
        if (entry.isDir && ((e.key === "ArrowRight" && !expanded()) || (e.key === "ArrowLeft" && expanded()))) { e.preventDefault(); toggle(); }
      }} title={target()}>
        <Show when={entry.isDir} fallback={<span class="tree-indent" />}><Icon name={expanded() ? "arrow-down4" : "arrow-right4"} size={13} /></Show>
        <FileIcon path={target()} directory={entry.isDir} open={expanded()} plain={chain()?.inSourceRoot} />
        <span class="tree-name"><Show when={merged()} fallback={entry.name}><For each={chain()!.segments}>{(segment, index) => <>{index() > 0 && <span class="tree-separator" aria-hidden="true">{chain()!.separator}</span>}<span class="tree-segment" data-segment-path={segment.path}>{segment.name}</span></>}</For></Show></span>
        <Show when={w.dirty(entry.path)}><span class="dirty-dot" aria-label="Unsaved changes" /></Show>
      </button>
      <Show when={entry.isDir && expanded()}><TreeRows path={target()} depth={rowProps.depth + 1} /></Show>
    </>;
  };
  return <>
    <Show when={props.view === "Files"}>
      <Show when={w.workspace()} fallback={<div class="panel-empty"><Icon name="Folder2" size={28} /><strong>No folder open</strong><p>Open a folder to start editing.</p><button class="button" onClick={w.requestWorkspace}>Open folder</button></div>}>
        <div class="tree-root"><button onClick={() => void w.toggleDirectory("")} aria-expanded={w.expanded().has("")}><Icon name={w.expanded().has("") ? "arrow-down4" : "arrow-right4"} size={13} /><strong>{w.workspace()?.name}</strong></button><button class="icon-button subtle" aria-label="Open folder" title="Open folder" onClick={w.requestWorkspace}><Icon name="Folder2" size={15} /></button></div>
        <div class="file-tree" role="tree" aria-label="Workspace files" onKeyDown={treeKey}><Show when={w.expanded().has("")}><TreeRows path="" depth={0} /></Show></div>
      </Show>
    </Show>
    <Show when={props.view === "Search"}>
      <div class="search-box"><Icon name="SearchNormal1" /><input id="workspace-search" aria-label="Search workspace" placeholder="Search in files" value={query()} onInput={e => search(e.currentTarget.value)} /><Show when={query()}><button class="close-button" aria-label="Clear search" onClick={() => search("")}>×</button></Show></div>
      <div class="search-summary" aria-live="polite">{w.searching() ? "Searching…" : query() ? `${w.searchResults().length} results` : "Find text across your workspace"}</div>
      <div class="search-results"><For each={w.searchResults()}>{match => <button class="search-result" onClick={() => props.onNavigate(match.path, match.line)} title={`${match.path}:${match.line}`}><span class="search-result-file"><FileIcon path={match.path} /><span>{match.path.split("/").pop()}</span><span class="dim">:{match.line}</span></span><span class="search-result-text">{match.text}</span><span class="search-result-path">{match.path}</span></button>}</For></div>
    </Show>
    <Show when={props.view === "Git" || props.view === "History"}><div class="panel-empty"><Icon name={props.view === "Git" ? "Hierarchy" : "Clock"} size={28} /><strong>{props.view === "Git" ? "Source control" : "File history"}</strong><p>{props.view === "Git" ? "Git integration is planned for phase 0.3." : "History will be available with Git integration in phase 0.3."}</p></div></Show>
  </>;
}
