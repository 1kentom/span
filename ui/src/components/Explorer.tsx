import { type JSX, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { FileEntry } from "../bindings";
import type { Workbench } from "../stores/workbench";
import Icon, { FileIcon } from "./Icon";
import { fileIndexMessage } from "../lib/file-index";
import { MAX_CHAIN_DEPTH, compactChain, isSourceRoot } from "../lib/compact-tree";
import { compactFolders } from "../lib/explorer-prefs";
import type { ExplorerState } from "../lib/explorer-state";
import { createInternalDrag, type InternalDragState } from "../lib/internal-drag";
import type { EditorDropTarget } from "../lib/drop-zones";
import { currentPlatform } from "../lib/commands";
import { fileName, parentPath } from "../lib/navigation";
import "../styles/explorer.css";

type DragItem = { paths: string[]; generation: number };
type DragTarget = { kind: "folder"; path: string } | { kind: "editor"; target: EditorDropTarget };

export function Explorer(props: { git?: JSX.Element; history?: JSX.Element; workbench: Workbench; view: "Files" | "Search" | "Git" | "History"; onNavigate: (path: string, line?: number) => void; onOpenToSide: (path: string) => void; state: ExplorerState; onEditorTarget: (x: number, y: number) => EditorDropTarget | undefined; onEditorPreview: (target: EditorDropTarget | undefined) => void; onEditorDrop: (paths: string[], target: EditorDropTarget) => void }) {
  const w = props.workbench; const state = props.state;
  const mac = currentPlatform() === "mac";
  let treeElement!: HTMLDivElement;
  let dragPaths: string[] = [];
  const [drag, setDrag] = createSignal<InternalDragState<DragItem, DragTarget>>();
  const dropFolder = () => { const target = drag()?.target; return target?.kind === "folder" ? target.path : undefined; };
  let hoverTimer: ReturnType<typeof setTimeout> | undefined; let hoverFolder: string | undefined;
  onCleanup(() => clearTimeout(hoverTimer));
  function scroller(): HTMLElement | undefined {
    for (let node: HTMLElement | null = treeElement; node; node = node.parentElement) { const overflow = getComputedStyle(node).overflowY; if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node; }
    return undefined;
  }
  const dragger = createInternalDrag<DragItem, DragTarget>({
    valid: item => item.generation === w.workspaceGeneration() && !w.busy() && !state.edit(),
    targetAt: (x, y) => {
      const editor = dragPaths.every(path => !state.isDirectory(path)) ? props.onEditorTarget(x, y) : undefined;
      if (editor) return { kind: "editor", target: editor };
      const element = document.elementFromPoint(x, y);
      const row = element?.closest<HTMLElement>('.file-tree [role="treeitem"]');
      let folder: string | undefined;
      if (row) { const path = row.dataset.path ?? ""; folder = state.isDirectory(path) ? path : parentPath(path); }
      else if (element?.closest(".file-tree, .tree-root, .explorer-panel .tree-loading")) folder = "";
      if (folder === undefined) return undefined;
      return dragPaths.some(path => folder === path || folder!.startsWith(`${path}/`)) ? undefined : { kind: "folder", path: folder };
    },
    preview: next => {
      setDrag(next);
      props.onEditorPreview(next?.target?.kind === "editor" ? next.target.target : undefined);
      const folder = next?.target?.kind === "folder" ? next.target.path : undefined;
      if (folder !== hoverFolder) {
        hoverFolder = folder; clearTimeout(hoverTimer);
        if (folder) hoverTimer = setTimeout(() => { if (hoverFolder === folder && !w.expanded().has(folder)) void w.toggleDirectory(folder); }, 700);
      }
      if (next) { const box = scroller(); if (box) { const rect = box.getBoundingClientRect(); if (next.y < rect.top + 28) box.scrollTop -= 14; else if (next.y > rect.bottom - 28) box.scrollTop += 14; } }
    },
    drop: (item, target, copy) => { if (target.kind === "folder") void state.transfer(item.paths, target.path, copy); else props.onEditorDrop(item.paths.filter(path => !state.isDirectory(path)), target.target); },
  });
  onCleanup(dragger.dispose);
  createEffect(() => { w.workspaceGeneration(); dragger.cancel(); });
  function startDrag(event: PointerEvent, path: string) {
    const selected = state.selection();
    dragPaths = selected.includes(path) ? [...selected] : [path];
    dragger.start(event, { paths: dragPaths, generation: w.workspaceGeneration() });
  }
  const rowElement = (path: string) => treeElement.querySelector<HTMLElement>(`[role="treeitem"][data-path="${CSS.escape(path)}"]`);
  let typed = ""; let typedAt = 0;
  const [query, setQuery] = createSignal("");
  let timer: ReturnType<typeof setTimeout>;
  onCleanup(() => clearTimeout(timer));
  const search = (value: string) => { setQuery(value); clearTimeout(timer); timer = setTimeout(() => void w.search(value), 180); };
  function treeKey(event: KeyboardEvent) {
    if ((event.target as Element).closest(".tree-edit-row")) return;
    const row = (event.target as Element).closest<HTMLElement>('[role="treeitem"]');
    const paths = state.visiblePaths();
    const current = row?.dataset.path ?? state.focus() ?? paths[0];
    const index = Math.max(0, paths.indexOf(current ?? ""));
    const mod = mac ? event.metaKey : event.ctrlKey; const key = event.key; const lower = key.toLowerCase();
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    const focusPath = (path: string) => { state.setFocus(path); rowElement(path)?.focus(); state.scrollTo(path); };
    const move = (to: number, extend: boolean) => { const path = paths[Math.max(0, Math.min(paths.length - 1, to))]; if (!path) return; if (extend) state.selectRange(path); else state.selectOnly(path); focusPath(path); };
    const directory = current !== undefined && state.isDirectory(current);
    const open = current !== undefined && w.expanded().has(current);
    if (key === "ArrowDown") { stop(); move(index + 1, event.shiftKey); return; }
    if (key === "ArrowUp") { stop(); move(index - 1, event.shiftKey); return; }
    if (key === "Home") { stop(); move(0, event.shiftKey); return; }
    if (key === "End") { stop(); move(paths.length - 1, event.shiftKey); return; }
    if (key === "PageDown" || key === "PageUp") { stop(); const page = Math.max(1, Math.floor(treeElement.clientHeight / 26) - 1); move(index + (key === "PageDown" ? page : -page), event.shiftKey); return; }
    if (key === "ArrowRight" && current) { stop(); if (directory && !open) row?.click(); else if (directory) move(index + 1, false); return; }
    if (key === "ArrowLeft" && current) {
      stop();
      if (directory && open) { row?.click(); return; }
      for (let parent = parentPath(current); parent; parent = parentPath(parent)) if (paths.includes(parent)) { state.selectOnly(parent); focusPath(parent); return; }
      return;
    }
    if (key === "F2" || (key === "Enter" && mac)) { stop(); void state.startRename(current); return; }
    if (key === "Enter" && mod && current && !directory) { stop(); props.onOpenToSide(current); return; }
    if (key === "Enter" && current) { stop(); row?.click(); return; }
    if (key === "Delete" || (key === "Backspace" && mod)) { stop(); void state.trash(); return; }
    if (key === "Escape") { if (state.clipboard()) { stop(); state.clearClipboard(); } else if (state.selection().length) { stop(); state.clearSelection(); } return; }
    if (mod && !event.altKey && !event.shiftKey) {
      if (lower === "c") { stop(); state.setClip(false); return; }
      if (lower === "x") { stop(); state.setClip(true); return; }
      if (lower === "v") { stop(); void state.paste(); return; }
      if (lower === "a") { stop(); state.selectAll(); return; }
      if (lower === "z") { stop(); void state.undo(); return; }
      if (key === "-") { stop(); state.collapseAll(); return; }
    }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(key)) {
      stop(); const now = Date.now(); typed = now - typedAt > 700 ? key.toLowerCase() : typed + key.toLowerCase(); typedAt = now;
      const order = [...paths.slice(index + (typed.length > 1 ? 0 : 1)), ...paths.slice(0, index + 1)];
      const hit = order.find(path => fileName(path).toLowerCase().startsWith(typed));
      if (hit) { state.selectOnly(hit); focusPath(hit); }
    }
  }
  function EditRow(editProps: { depth: number }) {
    let input!: HTMLInputElement;
    const edit = () => state.edit()!;
    onMount(() => { input.focus(); const [from, to] = edit().select ?? [0, 0]; input.setSelectionRange(from, to); });
    return <div class="tree-edit-row" style={{ "padding-left": `${12 + editProps.depth * 16}px` }}>
      <span class="tree-indent" />
      <FileIcon path={edit().value || "x"} directory={edit().kind === "folder"} />
      <input ref={input} class="tree-edit-input" type="text" value={edit().value} aria-label={edit().mode === "rename" ? "Rename" : edit().kind === "folder" ? "New folder name" : "New file name"} aria-invalid={!!edit().error} aria-describedby="tree-edit-message" spellcheck={false} autocomplete="off" autocapitalize="off"
        onInput={event => state.setEditValue(event.currentTarget.value)}
        onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); void state.commitEdit(); } else if (event.key === "Escape") { event.preventDefault(); state.cancelEdit(); queueMicrotask(() => (treeElement.querySelector<HTMLElement>(`[role="treeitem"][data-path="${CSS.escape(state.focus() ?? "")}"]`) ?? treeElement.querySelector<HTMLElement>('[role="treeitem"]'))?.focus()); } }}
        onBlur={() => { const current = state.edit(); if (!current || current.busy) return; if (!current.value.trim() || (current.mode === "rename" && current.value === fileName(current.path!))) state.cancelEdit(); else if (!current.error) void state.commitEdit(); }} />
      <Show when={edit().error || edit().warning}><div id="tree-edit-message" class={`tree-edit-msg ${edit().error ? "error" : "warn"}`} role="alert">{edit().error || edit().warning}</div></Show>
    </div>;
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
  const TreeRows = (rowProps: { path: string; depth: number }) => <><Show when={state.edit()?.mode === "create" && state.edit()!.parent === rowProps.path}><EditRow depth={rowProps.depth} /></Show><For each={w.directories[rowProps.path] || []}>{entry => <TreeRow entry={entry} depth={rowProps.depth} />}</For></>;
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
      <Show when={state.edit()?.mode === "rename" && state.edit()!.path === target()} fallback={<button class={`tree-row internal-drag-source ${w.activePath() === entry.path ? "selected" : ""} ${state.selection().includes(target()) ? "sel" : ""} ${state.clipboard()?.cut && state.clipboard()!.paths.includes(target()) ? "cut" : ""} ${dropFolder() === target() && entry.isDir ? "droptgt" : ""}`} role="treeitem" data-path={target()} tabIndex={state.focus() && state.focus() !== target() ? -1 : 0} aria-busy={entry.isDir && w.loadingDirectories().has(target())} aria-level={rowProps.depth + 1} aria-expanded={entry.isDir ? expanded() : undefined} aria-label={entry.isDir && merged() ? target() : undefined} aria-selected={state.selection().includes(target()) || (!entry.isDir && w.activePath() === entry.path)} draggable={false} onPointerDown={event => { if (event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey) startDrag(event, target()); }} onFocus={() => state.setFocus(target())} style={{ "padding-left": `${12 + rowProps.depth * 16}px` }} onClick={event => {
        if (event.metaKey || event.ctrlKey) { state.toggleSelect(target()); return; }
        if (event.shiftKey) { state.selectRange(target()); return; }
        state.selectOnly(target());
        if (entry.isDir) toggle(); else props.onNavigate(entry.path);
      }} title={target()}>
        <Show when={entry.isDir} fallback={<span class="tree-indent" />}><Icon name={expanded() ? "arrow-down4" : "arrow-right4"} size={13} /></Show>
        <FileIcon path={target()} directory={entry.isDir} open={expanded()} plain={chain()?.inSourceRoot} />
        <span class="tree-name"><Show when={merged()} fallback={entry.name}><For each={chain()!.segments}>{(segment, index) => <>{index() > 0 && <span class="tree-separator" aria-hidden="true">{chain()!.separator}</span>}<span class="tree-segment" data-segment-path={segment.path}>{segment.name}</span></>}</For></Show></span>
        <Show when={w.dirty(entry.path)}><span class="dirty-dot" aria-label="Unsaved changes" /></Show>
      </button>}><EditRow depth={rowProps.depth} /></Show>
      <Show when={entry.isDir && expanded()}><Show when={w.loadingDirectories().has(target())}><div class="tree-loading" role="status" style={{ "padding-left": `${28 + rowProps.depth * 16}px` }}>Loading folder…</div></Show><TreeRows path={target()} depth={rowProps.depth + 1} /></Show>
    </>;
  };
  return <>
    <Show when={props.view === "Files"}>
      <Show when={w.workspace()} fallback={<div class="panel-empty"><Icon name="Folder2" size={28} /><strong>No folder open</strong><p>Open a folder to start editing.</p><button class="button" onClick={w.requestWorkspace}>Open folder</button></div>}>
        <div class="tree-root"><button onClick={() => void w.toggleDirectory("")} aria-expanded={w.expanded().has("")}><Icon name={w.expanded().has("") ? "arrow-down4" : "arrow-right4"} size={13} /><strong class="tree-root-name" title={w.workspace()?.name}>{w.workspace()?.name}</strong></button><button class="icon-button subtle" aria-label="Refresh explorer" title="Refresh" onClick={() => void w.refreshFiles()}><Icon name="Refresh2" size={15} /></button><button class="icon-button subtle" aria-label="Collapse all folders" title="Collapse all" onClick={() => state.collapseAll()}><Icon name="Minus" size={15} /></button><button class="icon-button subtle" aria-label="Open folder" title="Open folder" onClick={w.requestWorkspace}><Icon name="Folder2" size={15} /></button></div>
        <div class="file-index-status" role="status" title={w.indexError() || w.indexStatus()?.lastError || w.indexStatus()?.watcherError || undefined}>{fileIndexMessage(w.indexStatus(), w.indexError())}</div>
        <Show when={w.loadingDirectories().has("")}><div class="tree-loading" role="status">Loading folder…</div></Show>
        <div class={`file-tree ${dropFolder() === "" ? "dropall" : ""}`} ref={treeElement} aria-busy={w.loadingDirectories().has("")} role="tree" aria-multiselectable="true" aria-label="Workspace files" onKeyDown={treeKey} onPointerDown={event => { if (event.target === event.currentTarget) state.clearSelection(); }}><Show when={w.expanded().has("")}><TreeRows path="" depth={0} /></Show></div>
      </Show>
    </Show>
    <Show when={state.notice()}><div class="tree-notice" role="status">{state.notice()}</div></Show>
    <Show when={drag()}>{current => <div class="explorer-drag-pill" role="status" aria-live="off" style={{ left: `${(current().x + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px`, top: `${(current().y + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px` }}>{current().item.paths.length > 1 ? `${current().item.paths.length} items` : fileName(current().item.paths[0])}{current().target === undefined ? " (no drop target)" : current().copy ? " (copy)" : ""}</div>}</Show>
    <Show when={props.view === "Search"}>
      <div class="search-box"><Icon name="SearchNormal1" /><input id="workspace-search" aria-label="Search workspace" placeholder="Search in files" value={query()} onInput={e => search(e.currentTarget.value)} /><Show when={query()}><button class="close-button" aria-label="Clear search" onClick={() => search("")}>×</button></Show></div>
      <div class="search-summary" aria-live="polite">{w.searching() ? "Searching…" : query() ? `${w.searchResults().length} results` : "Find text across your workspace"}</div>
      <div class="search-results"><For each={w.searchResults()}>{match => <button class="search-result" onClick={() => props.onNavigate(match.path, match.line)} title={`${match.path}:${match.line}`}><span class="search-result-file"><FileIcon path={match.path} /><span>{match.path.split("/").pop()}</span><span class="dim">:{match.line}</span></span><span class="search-result-text">{match.text}</span><span class="search-result-path">{match.path}</span></button>}</For></div>
    </Show>
    <Show when={props.view === "Git"}>{props.git}</Show>
    <Show when={props.view === "History"}>{props.history}</Show>
  </>;
}
