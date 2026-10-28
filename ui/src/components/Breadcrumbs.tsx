import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { FileEntry, SymbolDto_Serialize, Workspace } from "../bindings";
import { symbolKindIcon, symbolKindLabel, type SymbolCrumb } from "../lib/lsp-navigation";
import { setShowSymbolPath, setSymbolSortOrder, showSymbolPath, symbolSortOrder, symbolSorts, type SymbolSort } from "../lib/navigation-prefs";
import { isContextMenuKey, pathBreadcrumbs, type Breadcrumb } from "../lib/navigation";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import Icon from "./Icon";
import "../styles/navigation.css";

export function Breadcrumbs(props: { path?: string; workspace?: Workspace | null; listDirectory: (path: string) => Promise<FileEntry[]>; onOpen: (path: string) => void; onReveal?: (path: string) => void; onContextMenu?: (event: MouseEvent | KeyboardEvent, path: string, directory: boolean) => void; symbols?: SymbolCrumb[]; onSymbol?: (symbol: SymbolDto_Serialize) => void; focusRequest?: number }) {
  const crumbs = createMemo(() => props.path ? pathBreadcrumbs(props.path, props.workspace) : []);
  const [popup, setPopup] = createSignal<{ x: number; y: number; path: string }>();
  const [entries, setEntries] = createSignal<FileEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0;
  let bar!: HTMLElement;
  const [symbolMenu, setSymbolMenu] = createSignal<{ x: number; y: number; label: string; items: ContextMenuItem[] }>();
  const sortSiblings = (siblings: readonly SymbolDto_Serialize[], order: SymbolSort) => order === "position" ? [...siblings] : [...siblings].sort((a, b) => order === "name" ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const preferenceItems = (): ContextMenuItem[] => [
    { id: "show-path", label: showSymbolPath() ? "Hide symbol path" : "Show symbol path", onSelect: () => setShowSymbolPath(!showSymbolPath()) },
    ...symbolSorts.map(order => ({ id: `sort-${order}`, label: `Sort symbols by ${order}${symbolSortOrder() === order ? " (current)" : ""}`, disabled: symbolSortOrder() === order, onSelect: () => setSymbolSortOrder(order) })),
  ];
  function browseSymbols(crumb: SymbolCrumb, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setSymbolMenu({ x: rect.left, y: rect.top - 4, label: `Symbols next to ${crumb.symbol.name}`, items: sortSiblings(crumb.siblings, symbolSortOrder()).map(symbol => ({ id: `${symbol.name}:${symbol.selectionRange.start.line}`, label: symbol.name, icon: symbolKindIcon(symbol.kind), disabled: false, onSelect: () => props.onSymbol?.(symbol) })) });
  }
  // Focus Breadcrumbs: move into the bar, on the innermost crumb.
  createEffect(on(() => props.focusRequest, () => { const parts = bar?.querySelectorAll<HTMLElement>(".breadcrumb-part"); parts?.[parts.length - 1]?.focus(); }, { defer: true }));
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
  return <nav ref={bar} class="breadcrumbs path-breadcrumbs" aria-label="Active file path" onContextMenu={event => { if (!(event.target as HTMLElement).closest(".breadcrumb-part") && props.symbols) { event.preventDefault(); setSymbolMenu({ x: event.clientX, y: event.clientY, label: "Breadcrumb preferences", items: preferenceItems() }); } }} onKeyDown={event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const parts = [...bar.querySelectorAll<HTMLElement>(".breadcrumb-part")]; const index = parts.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault(); parts[Math.max(0, Math.min(parts.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)))]?.focus();
  }}><For each={crumbs()}>{(crumb, index) => <>
    <Show when={index() > 0}><Icon name="arrow-right4" size={10} /></Show>
    <button class="breadcrumb-part" aria-haspopup={crumb.directory ? "menu" : undefined} aria-expanded={crumb.directory ? popup()?.path === crumb.path : undefined} title={crumb.path || props.workspace?.root} onClick={event => {
      if (crumb.directory) void browse(crumb, event.currentTarget);
      else props.onReveal?.(crumb.path);
    }} onContextMenu={event => { if (props.onContextMenu) { event.preventDefault(); props.onContextMenu(event, crumb.path, crumb.directory); } }} onKeyDown={event => {
      if (props.onContextMenu && isContextMenuKey(event)) { event.preventDefault(); props.onContextMenu(event, crumb.path, crumb.directory); }
      else if (crumb.directory && event.key === "ArrowUp") { event.preventDefault(); void browse(crumb, event.currentTarget); }
    }}>{crumb.name}</button>
  </>}</For><Show when={showSymbolPath() && props.symbols?.length}><For each={props.symbols}>{crumb => <>
    <Icon name="arrow-right4" size={10} />
    <button class="breadcrumb-part breadcrumb-symbol" aria-haspopup="menu" aria-expanded={symbolMenu()?.label === `Symbols next to ${crumb.symbol.name}`} title={`${symbolKindLabel(crumb.symbol.kind)} ${crumb.symbol.name}`}
      onClick={event => browseSymbols(crumb, event.currentTarget)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setSymbolMenu({ x: event.clientX, y: event.clientY, label: "Breadcrumb preferences", items: preferenceItems() }); }}
      onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); browseSymbols(crumb, event.currentTarget); } }}><Icon name={symbolKindIcon(crumb.symbol.kind)} size={12} />{crumb.symbol.name}</button>
  </>}</For></Show><Show when={symbolMenu()}>{menu => <ContextMenu x={menu().x} y={menu().y} placement="above" label={menu().label} onClose={() => setSymbolMenu(undefined)} items={menu().items} />}</Show><Show when={popup()}>{popup => <ContextMenu x={popup().x} y={popup().y} placement="above" label="Browse folder" onClose={close} items={[
    ...loading() ? [{ id: "loading", label: "Loading folder…", disabled: true, onSelect: () => {} }] : [],
    ...error() ? [{ id: "error", label: "Could not read folder", disabled: true, onSelect: () => {} }] : [],
    ...!loading() && !error() && !entries().length ? [{ id: "empty", label: "Folder is empty", disabled: true, onSelect: () => {} }] : [],
    ...entries().map(entry => ({ id: entry.path, label: entry.name + (entry.isDir ? "/" : ""), fileIcon: { path: entry.path, directory: entry.isDir }, keepOpen: entry.isDir, onSelect: () => choose(entry) })),
  ]} />}</Show></nav>;
}
