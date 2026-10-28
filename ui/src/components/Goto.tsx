import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, untrack } from "solid-js";
import type { FileEntry, FileIndexStatus, SearchMatch, Workspace } from "../bindings";
import { LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadLanguage } from "../editor/languages";
import { actionDefinitions, shortcutLabel, type ActionHandlers, type ResolvedKeybindings } from "../lib/commands";
import { fileName, fileResults, parentPath, parseFileQuery, relativePath } from "../lib/navigation";
import { Modal } from "./Modal";
import { fileIndexMessage } from "../lib/file-index";
import { fuzzyMatch, symbolKindIcon, symbolKindLabel } from "../lib/lsp-navigation";
import type { SymbolItem, SymbolSource } from "../stores/navigation";
import Icon, { FileIcon } from "./Icon";
import "../styles/navigation.css";

export type GotoProps = {
  files: FileEntry[]; workspace?: Workspace | null; recentPaths?: readonly string[]; activePath?: string;
  handlers?: ActionHandlers; bindings?: ResolvedKeybindings;
  onPreview?: (path: string) => Promise<string>;
  onQueryFiles?: (query: string) => Promise<FileEntry[]>;
  indexStatus?: FileIndexStatus | null; indexError?: string; workspaceGeneration?: number;
  onSearch?: (query: string) => Promise<SearchMatch[]>;
  /** Symbol quick pick: `@` file symbols, `@:` grouped by kind, `#` workspace symbols. */
  symbols?: SymbolSource; initialQuery?: string;
  onOpen: (path: string, line?: number, column?: number) => void; onClose: () => void; onOpenFolder: () => void;
};
type Mode = "Goto" | "Actions" | "Tools" | "Text Search";
type Result = { id: string; label: string; detail: string; path?: string; line?: number; shortcut?: string; run: () => void; icon?: string; depth?: number; section?: string; kind?: string };
type PreviewToken = { text: string; class?: string };
const modes: Mode[] = ["Goto", "Actions", "Tools", "Text Search"];
const binaryFile = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|zip|gz|tar|exe|dll|so|dylib|wasm|mp[34]|mov|sqlite|db)$/i;

const kindHeading = (kind: SymbolItem["kind"]) => { const label = symbolKindLabel(kind); return /[^aeiou]y$/.test(label) ? `${label.slice(0, -1)}ies` : /(?:s|ss)$/.test(label) ? `${label}es` : `${label}s`; };

export function Goto(props: GotoProps) {
  let input!: HTMLInputElement; let list!: HTMLDivElement;
  const instanceId = createUniqueId();
  const [mode, setMode] = createSignal<Mode>("Goto");
  const [query, setQuery] = createSignal(props.initialQuery ?? ""); const [selected, setSelected] = createSignal(0);
  const [matches, setMatches] = createSignal<SearchMatch[]>([]);
  const [searching, setSearching] = createSignal(false); const [searchError, setSearchError] = createSignal("");
  const [preview, setPreview] = createSignal(""); const [previewState, setPreviewState] = createSignal("");
  const [highlighted, setHighlighted] = createSignal<{ from: number; to: number; class: string }[]>([]);
  let previewGeneration = 0; let searchGeneration = 0; let highlightGeneration = 0; let fileGeneration = 0;
  const [remoteFiles, setRemoteFiles] = createSignal<{ root?: string; workspaceGeneration?: number; filter: string; files: FileEntry[] }>();
  const [findingFiles, setFindingFiles] = createSignal(false);
  const [fileError, setFileError] = createSignal("");
  const [fileRefresh, setFileRefresh] = createSignal(0);
  const symbolMode = createMemo<"file" | "workspace" | undefined>(() => mode() !== "Goto" || !props.symbols ? undefined : query().startsWith("@") ? "file" : query().startsWith("#") ? "workspace" : undefined);
  const grouped = createMemo(() => symbolMode() === "file" && query().startsWith("@:"));
  const symbolTerm = createMemo(() => query().slice(grouped() ? 2 : 1).trim());
  const [symbolItems, setSymbolItems] = createSignal<SymbolItem[]>([]);
  const [symbolMessage, setSymbolMessage] = createSignal(""); const [symbolsLoading, setSymbolsLoading] = createSignal(false);
  let symbolGeneration = 0;
  createEffect(() => {
    const kind = symbolMode(); const term = kind === "workspace" ? symbolTerm() : ""; const request = ++symbolGeneration;
    props.workspace?.root; props.workspaceGeneration;
    if (!kind || !props.symbols) { setSymbolItems([]); setSymbolMessage(""); setSymbolsLoading(false); return; }
    setSymbolsLoading(true);
    // File symbols load once per entry into the mode. Workspace queries are debounced and a newer one cancels the older.
    const timer = setTimeout(() => {
      const source = kind === "file" ? props.symbols!.fileSymbols() : props.symbols!.workspaceSymbols(term);
      void source.then(pick => { if (request !== symbolGeneration) return; setSymbolItems(pick.items); setSymbolMessage(pick.message ?? ""); setSelected(0); })
        .catch(error => { if (request === symbolGeneration) { setSymbolItems([]); setSymbolMessage(String(error)); } })
        .finally(() => { if (request === symbolGeneration) setSymbolsLoading(false); });
    }, kind === "workspace" ? 150 : 0);
    onCleanup(() => clearTimeout(timer));
  });
  const symbolResults = createMemo<Result[]>(() => {
    const kind = symbolMode(); if (!kind) return [];
    const term = symbolTerm();
    const toResult = (item: SymbolItem, extra: Partial<Result> = {}): Result => ({ id: item.id, label: item.name, detail: item.container, path: item.location?.external ? undefined : item.path, line: item.line, icon: symbolKindIcon(item.kind), kind: item.kind, run: () => props.symbols!.open(item), ...extra });
    if (kind === "workspace") return symbolItems().map(item => ({ item, match: fuzzyMatch(term, item.name) })).filter(row => row.match).sort((a, b) => b.match!.score - a.match!.score).map(row => toResult(row.item, { detail: `${row.item.container ? `${row.item.container} · ` : ""}${row.item.location?.displayPath || row.item.path}` }));
    const matched = symbolItems().map(item => ({ item, match: fuzzyMatch(term, item.name) })).filter(row => row.match);
    if (grouped()) return matched.sort((a, b) => symbolKindLabel(a.item.kind).localeCompare(symbolKindLabel(b.item.kind)) || b.match!.score - a.match!.score || a.item.line - b.item.line).map(row => toResult(row.item, { section: kindHeading(row.item.kind) }));
    if (!term) return matched.map(row => toResult(row.item, { depth: row.item.depth }));
    return matched.sort((a, b) => b.match!.score - a.match!.score).map(row => toResult(row.item, { detail: row.item.container }));
  });
  const knownFiles = createMemo(() => {
    const remote = remoteFiles();
    return remote && remote.root === props.workspace?.root && remote.workspaceGeneration === props.workspaceGeneration ? [...props.files, ...remote.files] : props.files;
  });
  const fileQuery = createMemo(() => parseFileQuery(query(), knownFiles(), props.workspace?.root));
  const fileFilter = createMemo(() => fileQuery().filter);
  const invalidFilePosition = createMemo(() => !!fileQuery().invalidPosition);
  const files = createMemo(() => {
    if (symbolMode()) return [];
    const parsed = fileQuery();
    if (parsed.suffix && !parsed.filter && props.activePath && !parsed.invalidPosition) {
      const active = knownFiles().find(file => !file.isDir && relativePath(file.path, props.workspace?.root) === relativePath(props.activePath!, props.workspace?.root));
      return active ? [active] : [];
    }
    if (parsed.invalidPosition) return [];
    if (!props.onQueryFiles) return fileResults(props.files, query(), props.recentPaths, props.workspace?.root);
    const response = remoteFiles();
    const ranked = response && response.root === props.workspace?.root && response?.workspaceGeneration === props.workspaceGeneration && response?.filter === parsed.filter ? response.files : [];
    const recent = !parsed.filter.trim() ? (props.recentPaths || []).map(path => ({ path, name: fileName(path), isDir: false })) : [];
    // Preserve backend fuzzy ranking. Applying the local substring filter would lose matches.
    const visible = fileResults(knownFiles(), query(), props.recentPaths, props.workspace?.root);
    return [...new Map([...recent, ...ranked, ...visible].filter(file => !file.isDir).map(file => [file.path, file])).values()].slice(0, 100);
  });
  const recentCount = createMemo(() => !query().trim() ? files().filter(file => props.recentPaths?.includes(file.path)).length : 0);
  const results = createMemo<Result[]>(() => {
    const term = query().trim().toLowerCase();
    if (symbolMode()) return symbolResults();
    if (mode() === "Goto") return files().map(file => ({ id: file.path, label: file.name, detail: parentPath(relativePath(file.path, props.workspace?.root)) || props.workspace?.name || "", path: file.path, line: fileQuery().line, run: () => { const position = fileQuery(); if (position.column !== undefined) props.onOpen(file.path, position.line, position.column); else props.onOpen(file.path, position.line); } }));
    if (mode() === "Text Search") return matches().map((match, index) => ({ id: `${match.path}:${match.line}:${index}`, label: `${fileName(match.path)}:${match.line}`, detail: match.text.trim(), path: match.path, line: match.line, run: () => props.onOpen(match.path, match.line) }));
    return actionDefinitions.filter(action => props.handlers?.[action.id] && (!term || `${action.label} ${action.category}`.toLowerCase().includes(term)) && (mode() !== "Tools" || ["settings", "openFolder", "toggleProject", "toggleAssistant", "toggleTerminal", "splitEditor"].includes(action.id))).map(action => ({ id: action.id, label: action.label, detail: action.category, shortcut: props.bindings ? shortcutLabel(action.id, props.bindings) : "", run: () => props.handlers?.[action.id]?.() }));
  });
  const current = createMemo(() => results()[Math.min(selected(), results().length - 1)]);
  const previewPath = createMemo(() => current()?.path);
  const optionId = (item: Result) => `${instanceId}-result-${encodeURIComponent(item.id)}`;
  const open = (result?: Result) => { if (result) { props.onClose(); result.run(); } };
  function completeFile() {
    const candidate = current() || results()[0];
    if (!candidate?.path) return false;
    const completion = relativePath(candidate.path, props.workspace?.root) + fileQuery().suffix;
    setQuery(completion); setSelected(Math.max(0, results().findIndex(item => item.id === candidate.id)));
    input.value = completion; input.focus(); input.setSelectionRange(completion.length, completion.length); return true;
  }
  function updateQuery(value: string) {
    const previous = mode() === "Goto" ? fileQuery().filter : query();
    const selectedId = current()?.id;
    setQuery(value);
    if (mode() !== "Goto" || fileQuery().filter !== previous) setSelected(0);
    else setSelected(Math.max(0, results().findIndex(item => item.id === selectedId)));
  }
  function switchMode(next: Mode) { setMode(next); setSelected(0); input?.focus(); }
  createEffect(() => {
    const status = props.indexStatus;
    // Do not supersede a slow query just because another progress sample arrived.
    if (status && !untrack(findingFiles)) setFileRefresh(value => value + 1);
  });
  createEffect(() => {
    const term = fileFilter(); const active = mode() === "Goto" && !symbolMode();
    const root = props.workspace?.root; const workspaceGeneration = props.workspaceGeneration;
    // Status refreshes requery a still-open picker as scan batches and watcher events arrive.
    fileRefresh();
    const request = ++fileGeneration;
    setFindingFiles(false); setFileError("");
    if (!active || !root || !props.onQueryFiles || invalidFilePosition()) return;
    setFindingFiles(true);
    const timer = setTimeout(() => {
      void props.onQueryFiles!(term).then(files => {
        if (request !== fileGeneration || root !== props.workspace?.root || workspaceGeneration !== props.workspaceGeneration) return;
        const id = current()?.id;
        setRemoteFiles({ root, workspaceGeneration, filter: term, files });
        setSelected(Math.max(0, results().findIndex(item => item.id === id)));
      }).catch(error => { if (request === fileGeneration) setFileError(String(error)); })
        .finally(() => { if (request === fileGeneration) setFindingFiles(false); });
    }, term ? 80 : 0);
    onCleanup(() => { clearTimeout(timer); fileGeneration++; });
  });
  createEffect(() => {
    const term = query().trim(); const active = mode() === "Text Search"; const request = ++searchGeneration;
    props.workspace?.root; props.workspaceGeneration;
    setMatches([]); setSearchError(""); setSearching(false);
    if (!active || !term || !props.onSearch) return;
    setSearching(true);
    const timer = setTimeout(() => {
      void props.onSearch!(term).then(matches => { if (request === searchGeneration) setMatches(matches.slice(0, 100)); }).catch(error => { if (request === searchGeneration) setSearchError(String(error)); }).finally(() => { if (request === searchGeneration) setSearching(false); });
    }, 180);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    const path = previewPath(); const request = ++previewGeneration;
    props.workspace?.root; props.workspaceGeneration;
    setPreview(""); setPreviewState("");
    if (!path || !props.onPreview) return;
    if (binaryFile.test(path)) { setPreviewState("Preview is unavailable for this file type"); return; }
    setPreviewState("Loading preview…");
    const timer = setTimeout(() => {
      void props.onPreview!(path).then(text => {
        if (request !== previewGeneration) return;
        if (text.includes("\0")) { setPreviewState("Preview is unavailable for this file type"); return; }
        setPreview(text.slice(0, 64_000)); setPreviewState(text ? "" : "Empty file");
      }).catch(() => { if (request === previewGeneration) setPreviewState("Could not load file preview"); });
    }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    const item = current();
    if (item) queueMicrotask(() => list?.querySelector<HTMLElement>(`[id="${optionId(item)}"]`)?.scrollIntoView?.({ block: "nearest" }));
  });
  createEffect(() => {
    const text = preview(); const path = previewPath(); const request = ++highlightGeneration;
    setHighlighted([]);
    if (!text || !path) return;
    void loadLanguage("", path).then(support => {
      if (!support || request !== highlightGeneration) return;
      const language = support instanceof LanguageSupport ? support.language : support;
      const tokens: { from: number; to: number; class: string }[] = [];
      highlightTree(language.parser.parse(text), classHighlighter, (from, to, className) => tokens.push({ from, to, class: className }));
      if (request === highlightGeneration) setHighlighted(tokens);
    }).catch(() => {});
  });
  onCleanup(() => { fileGeneration += 1; previewGeneration += 1; searchGeneration += 1; highlightGeneration += 1; });
  const previewLines = createMemo(() => {
    const start = Math.max(0, (current()?.line || 1) - 4); let offset = 0;
    return preview().split("\n").map((text, index) => {
      const from = offset; const to = from + text.length; offset = to + 1;
      const tokens: PreviewToken[] = []; let cursor = from;
      if (index >= start && index < start + 7) for (const token of highlighted()) {
        if (token.to <= from || token.from >= to) continue;
        const tokenStart = Math.max(from, token.from); const tokenEnd = Math.min(to, token.to);
        if (tokenStart > cursor) tokens.push({ text: text.slice(cursor - from, tokenStart - from) });
        tokens.push({ text: text.slice(tokenStart - from, tokenEnd - from), class: token.class }); cursor = tokenEnd;
      }
      if (cursor < to || !text) tokens.push({ text: text.slice(cursor - from) });
      return { tokens, number: index + 1 };
    }).slice(start, start + 7);
  });
  const emptyText = () => symbolMode() ? symbolsLoading() ? "Finding symbols…" : symbolMessage() || (symbolMode() === "workspace" && !symbolTerm() ? "Type to search symbols in the workspace" : "No matching symbols") : mode() === "Goto" ? fileQuery().invalidPosition ? "Use a positive line and column number" : !props.workspace && !props.files.length ? "Open a folder to find files" : fileError() ? "Could not query the file index. Try typing again." : findingFiles() ? "Finding files…" : props.indexStatus?.status === "scanning" ? "No matches yet. Files are still being indexed." : "No matching files" : mode() === "Text Search" ? !props.onSearch ? "Open a workspace to search its text" : !query().trim() ? "Type text to search your workspace" : searching() ? "Searching…" : searchError() ? "Could not search workspace" : "No matching text" : "No matching actions";
  return <Modal label="Goto" class="goto-modal" onClose={props.onClose}>
    <div class="goto-tabs" role="tablist" aria-label="Goto modes"><For each={modes}>{item => <button role="tab" aria-selected={mode() === item} aria-controls="goto-panel" tabIndex={mode() === item ? 0 : -1} onClick={() => switchMode(item)} onKeyDown={event => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); switchMode(modes[(modes.indexOf(item) + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length]); } }}>{item}</button>}</For></div>
    <div class="goto-input"><Icon name="SearchNormal1" size={17} /><input ref={input} autofocus role="combobox" aria-label={mode() === "Goto" ? "Find a file" : mode() === "Text Search" ? "Search workspace text" : "Search actions"} aria-controls="goto-results" aria-activedescendant={current() ? optionId(current()!) : undefined} aria-expanded="true" placeholder={mode() === "Goto" ? "Search files by name" : mode() === "Text Search" ? "Search text in files" : "Search actions"} value={query()} onInput={event => updateQuery(event.currentTarget.value)} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.key.startsWith("Arrow") || event.ctrlKey || event.metaKey)) {
        event.preventDefault(); const count = results().length;
        setSelected(index => !count ? 0 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (Math.min(index, count - 1) + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      } else if (event.key === "Enter") { event.preventDefault(); open(current()); }
      else if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && mode() === "Goto") { if (completeFile()) event.preventDefault(); }
      else if (event.key === "Tab" && event.ctrlKey) { event.preventDefault(); switchMode(modes[(modes.indexOf(mode()) + (event.shiftKey ? -1 : 1) + modes.length) % modes.length]); }
    }} autocomplete="off" spellcheck={false} /><kbd>esc</kbd></div>
    <div id="goto-panel" class="goto-panel" role="tabpanel" aria-label={mode()}>
    <Show when={mode() === "Goto"}><div class="goto-filters"><span class="goto-chip">{symbolMode() === "workspace" ? "Workspace symbols" : symbolMode() ? "Symbols" : "Files"}</span><span>{symbolMode() ? "@ file symbols · @: grouped by kind · # workspace symbols" : "Tab completes the path · :line:column jumps to a position · @ symbols · # workspace symbols"}</span></div><Show when={props.onQueryFiles && props.workspace}><div class="goto-index-status" role="status" title={props.indexError || props.indexStatus?.lastError || props.indexStatus?.watcherError || undefined}>{fileIndexMessage(props.indexStatus, props.indexError)}</div></Show></Show>
    <div class="goto-section">{symbolMode() ? (grouped() ? "Symbols by kind" : symbolMode() === "workspace" ? "Workspace symbols" : "Symbols in file") : mode() === "Goto" ? query().trim() ? "Files" : recentCount() ? "Recent files" : "Workspace files" : mode() === "Text Search" ? "Text matches" : mode()}</div>
    <div ref={list} id="goto-results" class="goto-results" role="listbox" aria-label={mode()} aria-busy={mode() === "Goto" ? findingFiles() : searching()}><For each={results()}>{(item, index) => <><Show when={mode() === "Goto" && !symbolMode() && recentCount() > 0 && index() === recentCount()}><div class="goto-section">Workspace files</div></Show><Show when={item.section && item.section !== results()[index() - 1]?.section}><div class="goto-section">{item.section}</div></Show><button id={optionId(item)} data-index={index()} class={`goto-result ${current()?.id === item.id ? "selected" : ""}`} role="option" aria-selected={current()?.id === item.id} tabIndex={-1} onMouseMove={() => setSelected(index())} onClick={() => open(item)}><Show when={item.icon} fallback={<Show when={item.path} fallback={<Icon name="Command" size={15} />}><FileIcon path={item.path!} /></Show>}><span class="goto-symbol-icon" style={{ "margin-left": `${(item.depth ?? 0) * 14}px` }} title={item.kind}><Icon name={item.icon!} size={15} /></span></Show><span class="goto-name">{item.label}</span><span class="goto-detail">{item.detail}</span><Show when={item.shortcut}><kbd>{item.shortcut}</kbd></Show></button></>}</For><Show when={!results().length}><div class="goto-empty" role="status">{emptyText()}</div></Show></div>
    <Show when={(mode() === "Goto" || mode() === "Text Search") && props.onPreview}><div class="goto-preview" aria-label="File preview"><div class="goto-preview-path">{current()?.path || "File preview"}</div><Show when={preview()} fallback={<div class="goto-preview-message" role="status">{current()?.path ? previewState() : "Select a file to preview"}</div>}><For each={previewLines()}>{line => <div class="goto-preview-line"><span>{line.number}</span><code><For each={line.tokens}>{token => <span class={token.class}>{token.text}</span>}</For></code></div>}</For></Show></div></Show>
    <div class="goto-footer"><span>↑↓ select · Enter open · Ctrl+Tab switch mode</span><button onClick={() => { props.onClose(); props.onOpenFolder(); }}>Open folder…</button></div>
    </div>
  </Modal>;
}
