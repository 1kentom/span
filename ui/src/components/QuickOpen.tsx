import { For, createMemo, createSignal } from "solid-js";
import type { FileEntry } from "../bindings";
import { Modal } from "./Modal";
import Icon, { FileIcon } from "./Icon";
export function QuickOpen(props: { files: FileEntry[]; onOpen: (path: string, line?: number) => void; onClose: () => void; onOpenFolder: () => void }) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const results = createMemo(() => {
    const term = query().replace(/:\d+$/, "").toLowerCase();
    return props.files.filter(f => !f.isDir && (!term || f.path.toLowerCase().includes(term))).slice(0, 40);
  });
  const open = (path: string) => { const line = query().match(/:(\d+)$/)?.[1]; props.onOpen(path, line ? Number(line) : undefined); props.onClose(); };
  return <Modal label="Quick open" class="quick-open" onClose={props.onClose}>
    <div class="quick-input"><Icon name="SearchNormal1" size={18} /><input aria-label="Find a file" autofocus placeholder="Search files by name" value={query()} onInput={e => { setQuery(e.currentTarget.value); setSelected(0); }} onKeyDown={e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setSelected(i => Math.max(0, Math.min(results().length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); }
      if (e.key === "Enter" && results()[selected()]) open(results()[selected()].path);
    }} aria-controls="quick-results" aria-activedescendant={results().length ? `quick-${selected()}` : undefined} role="combobox" aria-expanded="true" autocomplete="off" spellcheck={false} /><kbd>esc</kbd></div>
    <div id="quick-results" class="quick-results" role="listbox" aria-label="Files"><For each={results()}>{(file, index) => <button id={`quick-${index()}`} class={`quick-result ${index() === selected() ? "selected" : ""}`} role="option" aria-selected={index() === selected()} onMouseMove={() => setSelected(index())} onClick={() => open(file.path)}><FileIcon path={file.path} /><span>{file.name}</span><span class="quick-path">{file.path.slice(0, -(file.name.length + 1))}</span></button>}</For>{!results().length && <div class="quick-empty">{props.files.length ? "No matching files" : "Open a folder to search your files"}</div>}</div>
    <div class="quick-footer"><span>Type :line to jump to a line</span><button onClick={() => { props.onClose(); props.onOpenFolder(); }}>Open folder…</button></div>
  </Modal>;
}
