import { For, createMemo, createSignal } from "solid-js";
import { actionDefinitions, currentPlatform, shortcutLabel, type ActionHandlers, type Platform, type ResolvedKeybindings } from "../lib/commands";
import { Modal } from "./Modal";
export function CommandPalette(props: { bindings: ResolvedKeybindings; handlers: ActionHandlers; onClose: () => void; platform?: Platform }) {
  const [query, setQuery] = createSignal(""); const [selected, setSelected] = createSignal(0);
  const matches = createMemo(() => actionDefinitions.filter(action => props.handlers[action.id] && `${action.category} ${action.label}`.toLowerCase().includes(query().replace(/^>/, "").trim().toLowerCase())));
  function execute(index: number) { const action = matches()[index]; if (!action) return; props.onClose(); props.handlers[action.id]?.(); }
  return <Modal label="Command palette" class="quick-open command-palette" onClose={props.onClose}>
    <div class="quick-input"><span aria-hidden="true">&gt;</span><input aria-label="Search commands" placeholder="Type a command" autofocus value={query()} onInput={event => { setQuery(event.currentTarget.value); setSelected(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const count = matches().length; if (count) setSelected((selected() + (event.key === "ArrowDown" ? 1 : count - 1)) % count); }
      else if (event.key === "Enter") { event.preventDefault(); execute(selected()); }
    }} aria-controls="command-results" aria-activedescendant={matches()[selected()] ? `command-${matches()[selected()].id}` : undefined} role="combobox" aria-expanded="true" /></div>
    <div class="quick-results" id="command-results" role="listbox" aria-label="Commands"><For each={matches()}>{(action, index) => <button id={`command-${action.id}`} role="option" aria-selected={index() === selected()} class={`quick-result ${index() === selected() ? "selected" : ""}`} onMouseMove={() => setSelected(index())} onClick={() => execute(index())}><span><small class="dim">{action.category}: </small>{action.label}</span><kbd>{shortcutLabel(action.id, props.bindings, props.platform ?? currentPlatform())}</kbd></button>}</For><div class="dim" role="status" style={{ display: matches().length ? "none" : "block", padding: "16px" }}>No commands match your search.</div></div>
  </Modal>;
}
