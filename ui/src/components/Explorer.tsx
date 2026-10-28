import { For, Show, createSignal, onCleanup } from "solid-js";
import type { FileEntry } from "../bindings";
import type { Workbench } from "../stores/workbench";
import Icon, { FileIcon } from "./Icon";

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
  const TreeRows = (rowProps: { path: string; depth: number }) => <For each={w.directories[rowProps.path] || []}>{entry => <TreeRow entry={entry} depth={rowProps.depth} />}</For>;
  const TreeRow = (rowProps: { entry: FileEntry; depth: number }) => {
    const entry = rowProps.entry;
    const expanded = () => w.expanded().has(entry.path);
    return <>
      <button class={`tree-row ${w.activePath() === entry.path ? "selected" : ""}`} role="treeitem" aria-level={rowProps.depth + 1} aria-expanded={entry.isDir ? expanded() : undefined} aria-selected={!entry.isDir && w.activePath() === entry.path} draggable={!entry.isDir && !!props.onFileDragStart} onDragStart={event => { if (!entry.isDir) props.onFileDragStart?.(event, entry.path); }} style={{ "padding-left": `${12 + rowProps.depth * 16}px` }} onClick={() => entry.isDir ? void w.toggleDirectory(entry.path) : props.onNavigate(entry.path)} onKeyDown={e => {
        if (entry.isDir && ((e.key === "ArrowRight" && !expanded()) || (e.key === "ArrowLeft" && expanded()))) { e.preventDefault(); void w.toggleDirectory(entry.path); }
      }} title={entry.path}>
        <Show when={entry.isDir} fallback={<span class="tree-indent" />}><Icon name={expanded() ? "arrow-down4" : "arrow-right4"} size={13} /></Show>
        <FileIcon path={entry.path} directory={entry.isDir} open={expanded()} /><span class="tree-name">{entry.name}</span><Show when={w.dirty(entry.path)}><span class="dirty-dot" aria-label="Unsaved changes" /></Show>
      </button>
      <Show when={entry.isDir && expanded()}><TreeRows path={entry.path} depth={rowProps.depth + 1} /></Show>
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
