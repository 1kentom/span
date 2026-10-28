import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { actionContext, actionDefinitions, currentPlatform, formatShortcut, resolveKeybindings, shortcutFromEvent, validateKeybindings, type ActionId, type KeybindingOverrides, type Platform } from "../lib/commands";
import { MenuIcon } from "./Icon";
import type { SettingsScope } from "../bindings";
import "../styles/keyboard-settings.css";

export function KeyboardSettings(props: {
  keybindings: KeybindingOverrides;
  onChange: (keybindings: KeybindingOverrides) => Promise<void>;
  platform?: Platform;
  onRecordingChange?: (recording: boolean) => void;
  bindingSources?: Partial<Record<ActionId, "User" | "Workspace">>;
  scope?: SettingsScope;
}) {
  const [query, setQuery] = createSignal("");
  const [searchKey, setSearchKey] = createSignal<string>();
  const [recordSearch, setRecordSearch] = createSignal(false);
  const [userOnly, setUserOnly] = createSignal(false);
  const [editing, setEditing] = createSignal<ActionId>();
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  let searchInput!: HTMLInputElement;
  createEffect(() => props.onRecordingChange?.(Boolean(editing() || recordSearch())));
  onCleanup(() => props.onRecordingChange?.(false));
  const platform = () => props.platform ?? currentPlatform();
  const bindings = createMemo(() => resolveKeybindings(props.keybindings, platform()));
  const customized = (id: ActionId) => Object.hasOwn(props.keybindings, id);
  const source = (id: ActionId) => customized(id) ? props.bindingSources?.[id] ?? "User" : "Default";
  const canReset = (id: ActionId) => customized(id) && (!props.scope || source(id) === (props.scope === "user" ? "User" : "Workspace"));
  const hasResettable = () => actionDefinitions.some(action => canReset(action.id));
  const matches = createMemo(() => {
    const onlyUser = userOnly() || /@source:user\b/i.test(query());
    const onlyDefault = /@source:default\b/i.test(query());
    const words = query().replace(/@source:(?:user|default)\b/gi, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return actionDefinitions.filter(action => {
      if ((onlyUser && !customized(action.id)) || (onlyDefault && customized(action.id))) return false;
      if (searchKey()) return bindings()[action.id].includes(searchKey()!);
      const text = `${action.id} ${action.label} ${action.category} ${actionContext(action.id).label} ${source(action.id)} ${bindings()[action.id].map(key => `${key} ${formatShortcut(key, platform())}`).join(" ")}`.toLowerCase();
      return words.every(word => text.includes(word));
    });
  });
  const draftIssue = createMemo(() => {
    const id = editing(); if (!id || !draft()) return "";
    return validateKeybindings({ ...props.keybindings, [id]: [draft()] }, platform())[0]?.message ?? "";
  });
  async function persist(next: KeybindingOverrides) {
    if (busy()) return;
    const issues = validateKeybindings(next, platform());
    if (issues.length) { setError(issues[0].message); return; }
    setBusy(true); setError(""); setStatus("");
    try { await props.onChange(next); setEditing(undefined); setStatus("Keyboard shortcuts saved."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function edit(id: ActionId) { if (busy()) return; setRecordSearch(false); setEditing(id); setDraft(""); setError(""); setStatus(""); }
  function cancelEdit() { setEditing(undefined); setError(""); }
  function reset(id: ActionId) { const next = { ...props.keybindings }; delete next[id]; void persist(next); }
  function capture(event: KeyboardEvent) {
    if (event.isComposing || event.repeat || event.getModifierState("AltGraph")) return;
    return shortcutFromEvent(event);
  }
  function toggleRecordSearch() {
    if (busy()) return;
    setEditing(undefined); setRecordSearch(!recordSearch()); setError("");
    queueMicrotask(() => searchInput.focus());
  }
  function Keycaps(keyProps: { shortcut: string }) {
    return <span class="kb-keycaps" aria-label={formatShortcut(keyProps.shortcut, platform())}><For each={keyProps.shortcut.split("+")}>{(part, index) => <><Show when={index() > 0 && platform() !== "mac"}><span class="kb-key-plus" aria-hidden="true">+</span></Show><kbd>{formatShortcut(part, platform())}</kbd></>}</For></span>;
  }
  return <section class="keyboard-settings" aria-label="Keyboard shortcuts">
    <h2>Keyboard shortcuts</h2>
    <div class={`kb-search ${recordSearch() ? "recording" : ""}`}>
      <MenuIcon name="search" size={15} /><input ref={searchInput} type="search" aria-label="Search keyboard shortcuts" placeholder={recordSearch() ? "Press a shortcut to search" : "Search commands or keybindings"} value={query()} readOnly={recordSearch()} data-shortcut-recorder={recordSearch() ? "true" : undefined} onInput={event => { setQuery(event.currentTarget.value); setSearchKey(undefined); }} onKeyDown={event => {
        if (!recordSearch()) return;
        event.stopPropagation(); if (event.key === "Tab") return; event.preventDefault();
        if (event.key === "Escape" || (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey)) { setRecordSearch(false); return; }
        const shortcut = capture(event); if (shortcut) { setSearchKey(shortcut); setQuery(formatShortcut(shortcut, platform())); }
      }} />
      <Show when={query()}><button class="kb-tool" aria-label="Clear shortcut search" title="Clear search" onClick={() => { setQuery(""); setSearchKey(undefined); searchInput.focus(); }}><MenuIcon name="cancel" size={14} /></button></Show>
      <button class={`kb-tool kb-record ${recordSearch() ? "selected" : ""}`} aria-label="Record keys to search" aria-pressed={recordSearch()} title="Record keys to search" disabled={busy()} onClick={toggleRecordSearch}><MenuIcon name="keyboard" size={15} /><span>Record keys</span></button>
    </div>
    <div class="kb-filterbar"><span class="kb-count" role="status">{matches().length} {matches().length === 1 ? "command" : "commands"}</span><span class="kb-toolbar-actions"><button class={`kb-filter ${userOnly() ? "selected" : ""}`} aria-label="Show user keybindings" aria-pressed={userOnly()} onClick={() => setUserOnly(!userOnly())}><MenuIcon name="filter" size={13} /><span>User</span></button><button class="kb-text-button" disabled={busy() || !hasResettable()} onClick={() => void persist({})}><MenuIcon name="reset" size={13} /><span>Reset all shortcuts</span></button></span></div>
    <Show when={(error() && !draftIssue()) || status()}><p role={error() ? "alert" : "status"} class={`kb-feedback ${error() ? "error-text" : ""}`}>{error() || status()}</p></Show>
    <div class="kb-table-scroll"><table class="kb-table" aria-label="Keyboard shortcut commands">
      <colgroup><col class="kb-command-col" /><col class="kb-binding-col" /><col class="kb-when-col" /><col class="kb-source-col" /></colgroup>
      <thead><tr><th scope="col">Command</th><th scope="col">Keybinding</th><th scope="col">When</th><th scope="col">Source</th></tr></thead>
      <tbody><For each={matches()}>{action => <>
        <tr class={editing() === action.id ? "kb-editing" : ""} data-command={action.id} onDblClick={() => edit(action.id)}>
          <td><div class="kb-command"><button class="kb-row-tool kb-edit" aria-label={`Change shortcut for ${action.label}`} title="Change keybinding" disabled={busy()} onClick={() => edit(action.id)}><MenuIcon name="rename" size={14} /></button><span><span class="kb-command-label" title={action.label}>{action.label}</span><span class="kb-command-id">{action.id}</span></span></div></td>
          <td><button class="kb-bindings" aria-label={`Edit keybinding for ${action.label}`} aria-description={bindings()[action.id].map(key => formatShortcut(key, platform())).join(" or ") || "Unassigned"} title={`Change shortcut for ${action.label}`} disabled={busy()} onClick={() => edit(action.id)}><Show when={bindings()[action.id].length} fallback={<span class="kb-unassigned">Unassigned</span>}><For each={bindings()[action.id]}>{shortcut => <Keycaps shortcut={shortcut} />}</For></Show></button></td>
          <td><span class="kb-context" title={actionContext(action.id).description}>{actionContext(action.id).label}</span></td>
          <td><div class="kb-source"><span class={customized(action.id) ? "kb-source-custom" : ""} title={source(action.id)}>{source(action.id)}</span><span class="kb-row-actions"><button class="kb-row-tool" aria-label={`Remove shortcut for ${action.label}`} title="Remove keybinding" disabled={busy() || !bindings()[action.id].length} onClick={() => void persist({ ...props.keybindings, [action.id]: [] })}><MenuIcon name="cancel" size={13} /></button><button class="kb-row-tool kb-reset" aria-label={`Reset shortcut for ${action.label}`} title="Reset keybinding" disabled={busy() || !canReset(action.id)} onClick={() => reset(action.id)}><MenuIcon name="reset" size={13} /></button></span></div></td>
        </tr>
        <Show when={editing() === action.id}><tr class="kb-editor-row"><td colspan={4}><div class="kb-recorder-panel"><label for={`keybinding-${action.id}`}>Change keybinding for {action.label}</label><div class="kb-recorder-controls shortcut-controls"><input id={`keybinding-${action.id}`} ref={element => queueMicrotask(() => element.isConnected && element.focus())} class="kb-recorder" data-shortcut-recorder="true" aria-label={`Record shortcut for ${action.label}`} placeholder="Press a key combination" value={draft() ? formatShortcut(draft(), platform()) : ""} readOnly onKeyDown={event => {
          event.stopPropagation(); if (event.key === "Tab") return; event.preventDefault();
          if (event.key === "Escape") { cancelEdit(); return; }
          if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) { if (draft() && !draftIssue()) void persist({ ...props.keybindings, [action.id]: [draft()] }); return; }
          const shortcut = capture(event); if (!shortcut) return;
          setDraft(shortcut.replace(platform() === "mac" ? /^Meta(?=\+)/ : /^Ctrl(?=\+)/, "Mod")); setError("");
        }} /><button class="button primary" disabled={!draft() || busy()} onClick={() => void persist({ ...props.keybindings, [action.id]: [draft()] })}>Save</button><button class="button" disabled={busy()} onClick={cancelEdit}>Cancel</button></div><Show when={draftIssue()}><p class="error-text kb-recorder-error" role="alert">{draftIssue()}</p></Show><p class="kb-recorder-hint">Press one key combination. Saving replaces this command's bindings. Multi-step chords are not supported.</p></div></td></tr></Show>
      </>}</For></tbody>
    </table></div>
    <Show when={!matches().length}><div class="kb-empty"><strong>No matching commands</strong><p>Try a different command, keybinding, or source.</p><button class="kb-text-button" onClick={() => { setQuery(""); setSearchKey(undefined); setUserOnly(false); setRecordSearch(false); }}>Clear filters</button></div></Show>
    <p class="kb-help">When shows the built-in focus rule for each command. Custom When expressions are not supported.</p>
  </section>;
}
