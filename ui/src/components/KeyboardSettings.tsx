import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { actionDefinitions, currentPlatform, formatShortcut, resolveKeybindings, shortcutFromEvent, validateKeybindings, type ActionId, type KeybindingOverrides, type Platform } from "../lib/commands";
export function KeyboardSettings(props: { keybindings: KeybindingOverrides; onChange: (keybindings: KeybindingOverrides) => Promise<void>; platform?: Platform; onRecordingChange?: (recording: boolean) => void }) {
  const [query, setQuery] = createSignal(""); const [editing, setEditing] = createSignal<ActionId>(); const [draft, setDraft] = createSignal(""); const [error, setError] = createSignal(""); const [busy, setBusy] = createSignal(false); const [status, setStatus] = createSignal("");
  createEffect(() => props.onRecordingChange?.(Boolean(editing())));
  onCleanup(() => props.onRecordingChange?.(false));
  const platform = () => props.platform ?? currentPlatform();
  const bindings = createMemo(() => resolveKeybindings(props.keybindings, platform()));
  const matches = createMemo(() => actionDefinitions.filter(action => `${action.label} ${action.category} ${bindings()[action.id].map(key => formatShortcut(key, platform())).join(" ")}`.toLowerCase().includes(query().toLowerCase())));
  async function persist(next: KeybindingOverrides) {
    const issues = validateKeybindings(next, platform()); if (issues.length) { setError(issues[0].message); return; }
    setBusy(true); setError(""); setStatus("");
    try { await props.onChange(next); setEditing(undefined); setStatus("Keyboard shortcuts saved."); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function reset(id: ActionId) { const next = { ...props.keybindings }; delete next[id]; void persist(next); }
  return <section aria-label="Keyboard shortcuts">
    <h2>Keyboard shortcuts</h2><p class="settings-description">Search commands, record a shortcut, or restore a default. Command on macOS and Control on Windows or Linux are saved as Mod. Empty bindings disable a shortcut.</p>
    <div class="settings-json-actions"><input class="settings-search" aria-label="Search keyboard shortcuts" placeholder="Search commands or shortcuts" value={query()} onInput={event => setQuery(event.currentTarget.value)} /><button class="button" disabled={busy() || !Object.keys(props.keybindings).length} onClick={() => void persist({})}>Reset all shortcuts</button></div>
    <p role={error() ? "alert" : "status"} class={error() ? "error-text" : "dim"}>{error() || status()}</p>
    <For each={matches()}>{action => <div class="setting-row shortcut-row"><div><strong>{action.label}</strong><p>{action.category}<Show when={Object.hasOwn(props.keybindings, action.id)}> · Customized</Show></p></div><div class="shortcut-controls">
      <Show when={editing() === action.id} fallback={<><button class="button shortcut-key" aria-label={`Change shortcut for ${action.label}`} onClick={() => { setEditing(action.id); setDraft(""); setError(""); }}><Show when={bindings()[action.id].length} fallback="Unassigned"><For each={bindings()[action.id]}>{(key, index) => <><Show when={index() > 0}><span class="dim"> / </span></Show><kbd>{formatShortcut(key, platform())}</kbd></>}</For></Show></button><button class="button" aria-label={`Remove shortcut for ${action.label}`} disabled={busy() || !bindings()[action.id].length} onClick={() => void persist({ ...props.keybindings, [action.id]: [] })}>Remove</button><button class="button" aria-label={`Reset shortcut for ${action.label}`} disabled={busy() || !Object.hasOwn(props.keybindings, action.id)} onClick={() => reset(action.id)}>Reset</button></>}>
        <input ref={element => queueMicrotask(() => element.isConnected && element.focus())} class="shortcut-recorder" data-shortcut-recorder="true" aria-label={`Record shortcut for ${action.label}`} placeholder="Press shortcut" value={draft() ? formatShortcut(draft(), platform()) : ""} autofocus readOnly onKeyDown={event => {
          event.stopPropagation(); if (event.key === "Tab") return; event.preventDefault();
          if (event.key === "Escape") { setEditing(undefined); return; }
          const shortcut = shortcutFromEvent(event); if (!shortcut) return;
          const portable = shortcut.replace(platform() === "mac" ? /^Meta(?=\+)/ : /^Ctrl(?=\+)/, "Mod"); setDraft(portable); setError("");
        }} /><button class="button primary" disabled={!draft() || busy()} onClick={() => void persist({ ...props.keybindings, [action.id]: [draft()] })}>Save</button><button class="button" onClick={() => setEditing(undefined)}>Cancel</button>
      </Show>
    </div></div>}</For><Show when={!matches().length}><p class="dim">No commands match your search.</p></Show>
  </section>;
}
