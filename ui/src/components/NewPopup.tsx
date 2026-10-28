import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { FileIcon } from "./Icon";
import { templates } from "../lib/explorer-state";
import "../styles/explorer.css";

/** "New in <folder>" template chooser from the design reference: filter field, grouped list, arrows and Enter. */
export function NewPopup(props: { request: { folder: string; x: number; y: number }; where: string; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  let box!: HTMLDivElement; let input!: HTMLInputElement;
  const score = (label: string, q: string) => {
    const text = label.toLowerCase();
    if (text.startsWith(q)) return 3;
    if (text.split(/[\s.]+/).some(word => word.startsWith(q))) return 2;
    if (text.includes(q)) return 1;
    let at = 0; for (const ch of text) if (ch === q[at]) at++;
    return at === q.length ? .5 : 0;
  };
  const list = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return templates;
    return templates.map(item => ({ item, s: score(item.label, q) })).filter(entry => entry.s > 0).sort((a, b) => b.s - a.s).map(entry => entry.item);
  });
  onMount(() => { input.focus(); });
  createEffect(() => {
    list();
    const margin = 8; const width = box.offsetWidth; const height = box.offsetHeight;
    let x = props.request.x; let y = props.request.y;
    if (x + width > window.innerWidth - margin) x = Math.max(margin, window.innerWidth - margin - width);
    if (y + height > window.innerHeight - margin) y = Math.max(margin, window.innerHeight - margin - height);
    box.style.left = `${Math.round(x)}px`; box.style.top = `${Math.round(y)}px`;
  });
  const clamp = (value: number) => Math.min(value, Math.max(0, list().length - 1));
  function key(event: KeyboardEvent) {
    const count = list().length;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); return; }
    if (event.key === "Tab") { event.preventDefault(); props.onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) setIndex((clamp(index()) + (event.key === "ArrowDown" ? 1 : -1) + count) % count); return; }
    if (event.key === "Enter") { event.preventDefault(); const item = list()[clamp(index())]; if (item) props.onPick(item.id); }
    event.stopPropagation();
  }
  return <>
    <div class="np-scrim" onPointerDown={event => { event.preventDefault(); props.onClose(); }} onContextMenu={event => { event.preventDefault(); props.onClose(); }} />
    <div class="np" ref={box} role="dialog" aria-label={`New in ${props.where}`} onKeyDown={key}>
      <div class="np-h"><span>New in</span><b>{props.where}</b></div>
      <input ref={input} class="np-q" type="text" placeholder="Type to filter" aria-label="Filter templates" role="combobox" aria-expanded="true" aria-controls="np-list" aria-activedescendant={list()[clamp(index())] ? `np-o-${list()[clamp(index())].id}` : undefined} spellcheck={false} autocomplete="off" value={query()} onInput={event => { setQuery(event.currentTarget.value); setIndex(0); }} />
      <ul class="np-list" id="np-list" role="listbox" aria-label="Templates">
        <For each={list()}>{(item, position) => <>
          <Show when={!query() && position() > 0 && list()[position() - 1].group !== item.group}><li class="np-sep" role="separator" /></Show>
          <li role="option" id={`np-o-${item.id}`} aria-selected={clamp(index()) === position()}>
            <button type="button" tabIndex={-1} class={`np-i ${clamp(index()) === position() ? "on" : ""}`} onClick={() => props.onPick(item.id)} onMouseMove={() => { if (index() !== position()) setIndex(position()); }}>
              <FileIcon path={item.fixed ?? `x${"ext" in item && item.ext ? item.ext : item.id === "folder" ? "" : ".txt"}`} directory={item.id === "folder"} /><span class="np-l">{item.label}</span><span class="np-d">{"detail" in item ? item.detail : ""}</span>
            </button>
          </li>
        </>}</For>
      </ul>
      <Show when={list().length === 0}><div class="np-none">No template matches "{query()}"</div></Show>
      <div class="sr-only" aria-live="polite" style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}>{list().length ? `${list().length} templates` : "No templates"}</div>
    </div>
  </>;
}
