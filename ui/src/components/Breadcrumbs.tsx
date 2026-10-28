import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import type { FileEntry, Workspace } from "../bindings";
import { isContextMenuKey, pathBreadcrumbs, type Breadcrumb } from "../lib/navigation";
import { ContextMenu } from "./ContextMenu";
import Icon from "./Icon";
import "../styles/navigation.css";

export function Breadcrumbs(props: { path?: string; workspace?: Workspace | null; listDirectory: (path: string) => Promise<FileEntry[]>; onOpen: (path: string) => void; onReveal?: (path: string) => void; onContextMenu?: (event: MouseEvent | KeyboardEvent, path: string, directory: boolean) => void }) {
  const crumbs = createMemo(() => props.path ? pathBreadcrumbs(props.path, props.workspace) : []);
  const [popup, setPopup] = createSignal<{ x: number; y: number; path: string }>();
  const [entries, setEntries] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  onCleanup(() => { generation += 1; });
  const close = () => { generation += 1; setPopup(undefined); };
  async function loadDirectory(crumb: Breadcrumb, position: { x: number; y: number }) {
    const request = ++generation;
    setPopup({ ...position, path: crumb.path });
    setEntries([]); setLoading(true); setError("");
    try {
      const files = await props.listDirectory(crumb.path);
      if (request === generation) setEntries(files);
    } catch (error) { if (request === generation) setError(String(error)); }
    finally { if (request === generation) setLoading(false); }
  }
  function browse(crumb: Breadcrumb, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    void loadDirectory(crumb, { x: rect.left, y: rect.top - 4 });
  }
  const choose = (entry: FileEntry) => {
    if (!entry.isDir) { close(); props.onOpen(entry.path); return; }
    props.onReveal?.(entry.path);
    const position = popup();
    if (position) void loadDirectory({ name: entry.name, path: entry.path, directory: true }, position);
  };
  return <nav class="breadcrumbs path-breadcrumbs" aria-label="Active file path"><For each={crumbs()}>{(crumb, index) => <>
    <Show when={index() > 0}><Icon name="arrow-right4" size={10} /></Show>
    <button class="breadcrumb-part" aria-haspopup={crumb.directory ? "menu" : undefined} aria-expanded={crumb.directory ? popup()?.path === crumb.path : undefined} title={crumb.path || props.workspace?.root} onClick={event => {
      if (crumb.directory) void browse(crumb, event.currentTarget);
      else props.onReveal?.(crumb.path);
    }} onContextMenu={event => { if (props.onContextMenu) { event.preventDefault(); props.onContextMenu(event, crumb.path, crumb.directory); } }} onKeyDown={event => {
      if (props.onContextMenu && isContextMenuKey(event)) { event.preventDefault(); props.onContextMenu(event, crumb.path, crumb.directory); }
      else if (crumb.directory && event.key === "ArrowUp") { event.preventDefault(); void browse(crumb, event.currentTarget); }
    }}>{crumb.name}</button>
  </>}</For><Show when={popup()}>{popup => <ContextMenu x={popup().x} y={popup().y} placement="above" label="Browse folder" onClose={close} items={[
    ...loading() ? [{ id: "loading", label: "Loading folder…", disabled: true, onSelect: () => {} }] : [],
    ...error() ? [{ id: "error", label: "Could not read folder", disabled: true, onSelect: () => {} }] : [],
    ...!loading() && !error() && !entries().length ? [{ id: "empty", label: "Folder is empty", disabled: true, onSelect: () => {} }] : [],
    ...entries().map(entry => ({ id: entry.path, label: entry.name + (entry.isDir ? "/" : ""), keepOpen: entry.isDir, onSelect: () => choose(entry) })),
  ]} />}</Show></nav>;
}
