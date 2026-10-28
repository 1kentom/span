import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { FileEntry, SearchMatch, Workspace } from "../bindings";
import { LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadLanguage } from "../editor/languages";
import { actionDefinitions, shortcutLabel, type ActionHandlers, type ResolvedKeybindings } from "../lib/commands";
import { fileName, fileResults, parentPath } from "../lib/navigation";
import { Modal } from "./Modal";
import Icon, { FileIcon } from "./Icon";
import "../styles/navigation.css";

export type GotoProps = {
  files: FileEntry[]; workspace?: Workspace | null; recentPaths?: readonly string[];
  handlers?: ActionHandlers; bindings?: ResolvedKeybindings;
  onPreview?: (path: string) => Promise<string>;
  onSearch?: (query: string) => Promise<SearchMatch[]>;
  onOpen: (path: string, line?: number) => void; onClose: () => void; onOpenFolder: () => void;
};
type Mode = "Goto" | "Actions" | "Tools" | "Text Search";
type Result = { id: string; label: string; detail: string; path?: string; line?: number; shortcut?: string; run: () => void };
type PreviewToken = { text: string; class?: string };
const modes: Mode[] = ["Goto", "Actions", "Tools", "Text Search"];
const binaryFile = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|zip|gz|tar|exe|dll|so|dylib|wasm|mp[34]|mov|sqlite|db)$/i;

export function Goto(props: GotoProps) {
  let input!: HTMLInputElement; let list!: HTMLDivElement;
  const [mode, setMode] = createSignal<Mode>("Goto");
  const [query, setQuery] = createSignal(""); const [selected, setSelected] = createSignal(0);
  const [matches, setMatches] = createSignal<SearchMatch[]>([]);
  const [searching, setSearching] = createSignal(false); const [searchError, setSearchError] = createSignal("");
  const [preview, setPreview] = createSignal(""); const [previewState, setPreviewState] = createSignal("");
  const [highlighted, setHighlighted] = createSignal<{ from: number; to: number; class: string }[]>([]);
  let previewGeneration = 0; let searchGeneration = 0; let highlightGeneration = 0;
  const files = createMemo(() => fileResults(props.files, query(), props.recentPaths));
  const recentCount = createMemo(() => !query().trim() ? files().filter(file => props.recentPaths?.includes(file.path)).length : 0);
  const results = createMemo<Result[]>(() => {
    const term = query().trim().toLowerCase();
    if (mode() === "Goto") return files().map(file => ({ id: file.path, label: file.name, detail: parentPath(file.path) || props.workspace?.name || "", path: file.path, run: () => props.onOpen(file.path, Number(query().match(/:(\d+)$/)?.[1]) || undefined) }));
    if (mode() === "Text Search") return matches().map((match, index) => ({ id: `${match.path}:${match.line}:${index}`, label: `${fileName(match.path)}:${match.line}`, detail: match.text.trim(), path: match.path, line: match.line, run: () => props.onOpen(match.path, match.line) }));
    return actionDefinitions.filter(action => props.handlers?.[action.id] && (!term || `${action.label} ${action.category}`.toLowerCase().includes(term)) && (mode() !== "Tools" || ["settings", "openFolder", "toggleProject", "toggleAssistant", "toggleTerminal", "splitEditor"].includes(action.id))).map(action => ({ id: action.id, label: action.label, detail: action.category, shortcut: props.bindings ? shortcutLabel(action.id, props.bindings) : "", run: () => props.handlers?.[action.id]?.() }));
  });
  const current = createMemo(() => results()[Math.min(selected(), results().length - 1)]);
  const open = (result?: Result) => { if (result) { props.onClose(); result.run(); } };
  function switchMode(next: Mode) { setMode(next); setSelected(0); input?.focus(); }
  createEffect(() => {
    const term = query().trim(); const active = mode() === "Text Search"; const request = ++searchGeneration;
    setMatches([]); setSearchError(""); setSearching(false);
    if (!active || !term || !props.onSearch) return;
    setSearching(true);
    const timer = setTimeout(() => {
      void props.onSearch!(term).then(matches => { if (request === searchGeneration) setMatches(matches.slice(0, 100)); }).catch(error => { if (request === searchGeneration) setSearchError(String(error)); }).finally(() => { if (request === searchGeneration) setSearching(false); });
    }, 180);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => {
    const item = current(); const request = ++previewGeneration;
    setPreview(""); setPreviewState("");
    if (!item?.path || !props.onPreview) return;
    if (binaryFile.test(item.path)) { setPreviewState("Preview is unavailable for this file type"); return; }
    const path = item.path; setPreviewState("Loading preview…");
    const timer = setTimeout(() => {
      void props.onPreview!(path).then(text => {
        if (request !== previewGeneration) return;
        if (text.includes("\0")) { setPreviewState("Preview is unavailable for this file type"); return; }
        setPreview(text.slice(0, 64_000)); setPreviewState(text ? "" : "Empty file");
      }).catch(() => { if (request === previewGeneration) setPreviewState("Could not load file preview"); });
    }, 100);
    onCleanup(() => clearTimeout(timer));
  });
  createEffect(() => { const index = selected(); queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" })); });
  createEffect(() => {
    const text = preview(); const path = current()?.path; const request = ++highlightGeneration;
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
  onCleanup(() => { previewGeneration += 1; searchGeneration += 1; highlightGeneration += 1; });
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
  const emptyText = () => mode() === "Goto" ? props.files.length ? "No matching files" : "Open a folder to find files" : mode() === "Text Search" ? !props.onSearch ? "Open a workspace to search its text" : !query().trim() ? "Type text to search your workspace" : searching() ? "Searching…" : searchError() ? "Could not search workspace" : "No matching text" : "No matching actions";
  return <Modal label="Goto" class="goto-modal" onClose={props.onClose}>
    <div class="goto-tabs" role="tablist" aria-label="Goto modes"><For each={modes}>{item => <button role="tab" aria-selected={mode() === item} aria-controls="goto-panel" tabIndex={mode() === item ? 0 : -1} onClick={() => switchMode(item)} onKeyDown={event => { if (["ArrowRight", "ArrowLeft"].includes(event.key)) { event.preventDefault(); switchMode(modes[(modes.indexOf(item) + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length]); } }}>{item}</button>}</For></div>
    <div class="goto-input"><Icon name="SearchNormal1" size={17} /><input ref={input} autofocus role="combobox" aria-label={mode() === "Goto" ? "Find a file" : mode() === "Text Search" ? "Search workspace text" : "Search actions"} aria-controls="goto-results" aria-activedescendant={current() ? `goto-result-${Math.min(selected(), results().length - 1)}` : undefined} aria-expanded="true" placeholder={mode() === "Goto" ? "Search files by name" : mode() === "Text Search" ? "Search text in files" : "Search actions"} value={query()} onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.key.startsWith("Arrow") || event.ctrlKey || event.metaKey)) {
        event.preventDefault(); const count = results().length;
        setSelected(index => !count ? 0 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (Math.min(index, count - 1) + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      } else if (event.key === "Enter") { event.preventDefault(); open(current()); }
      else if (event.key === "Tab" && event.ctrlKey) { event.preventDefault(); switchMode(modes[(modes.indexOf(mode()) + (event.shiftKey ? -1 : 1) + modes.length) % modes.length]); }
    }} autocomplete="off" spellcheck={false} /><kbd>esc</kbd></div>
    <div id="goto-panel" class="goto-panel" role="tabpanel" aria-label={mode()}>
    <Show when={mode() === "Goto"}><div class="goto-filters"><span class="goto-chip">Files</span><span>Type :line to jump to a line</span></div></Show>
    <div class="goto-section">{mode() === "Goto" ? query().trim() ? "Files" : recentCount() ? "Recent files" : "Workspace files" : mode() === "Text Search" ? "Text matches" : mode()}</div>
    <div ref={list} id="goto-results" class="goto-results" role="listbox" aria-label={mode()}><For each={results()}>{(item, index) => <><Show when={mode() === "Goto" && recentCount() > 0 && index() === recentCount()}><div class="goto-section">Workspace files</div></Show><button id={`goto-result-${index()}`} data-index={index()} class={`goto-result ${current()?.id === item.id ? "selected" : ""}`} role="option" aria-selected={current()?.id === item.id} tabIndex={-1} onMouseMove={() => setSelected(index())} onClick={() => open(item)}><Show when={item.path} fallback={<Icon name="Command" size={15} />}><FileIcon path={item.path!} /></Show><span class="goto-name">{item.label}</span><span class="goto-detail">{item.detail}</span><Show when={item.shortcut}><kbd>{item.shortcut}</kbd></Show></button></>}</For><Show when={!results().length}><div class="goto-empty" role="status">{emptyText()}</div></Show></div>
    <Show when={current()?.path && props.onPreview}><div class="goto-preview" aria-label="File preview"><div class="goto-preview-path">{current()?.path}</div><Show when={preview()} fallback={<div class="goto-preview-message" role="status">{previewState()}</div>}><For each={previewLines()}>{line => <div class="goto-preview-line"><span>{line.number}</span><code><For each={line.tokens}>{token => <span class={token.class}>{token.text}</span>}</For></code></div>}</For></Show></div></Show>
    <div class="goto-footer"><span>↑↓ select · Enter open · Ctrl+Tab switch mode</span><button onClick={() => { props.onClose(); props.onOpenFolder(); }}>Open folder…</button></div>
    </div>
  </Modal>;
}
