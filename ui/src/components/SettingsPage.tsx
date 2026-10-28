import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import type { Settings_Serialize as SettingsValue, SettingsScope } from "../bindings";
import Icon from "./Icon";
import "../styles/settings.css";

type Section = "Appearance" | "Editor" | "Files" | "Keyboard Shortcuts" | "Agents" | "Tools" | "Language servers" | "Updates" | "Workspace" | "JSONC";
export interface SettingsPageProps {
  settings: SettingsValue;
  workspaceName?: string;
  scope?: SettingsScope;
  configuredKeys?: readonly string[];
  settingsPath?: string;
  unsupportedKeys?: readonly string[];
  onScopeChange?: (scope: SettingsScope) => Promise<void>;
  onReset?: (key: keyof SettingsValue) => Promise<void>;
  onOpenJsonc?: () => void;
  settingsJsonc?: string;
  onChange: (patch: Partial<SettingsValue>) => Promise<void>;
  onSaveJsonc: (text: string) => Promise<SettingsValue>;
  onReloadJsonc?: () => Promise<string>;
  onDirtyChange?: (dirty: boolean) => void;
  onRevertReady?: (revert: () => void) => void;
  onSaveReady?: (save: () => Promise<boolean>) => void;
  shortcuts?: JSX.Element;
  tools?: JSX.Element;
  languageServers?: JSX.Element;
  onOpenTools?: () => void;
  updates?: JSX.Element;
  onOpenAgents?: () => void;
  agentStatus?: string;
  /** Agent rows saved to user settings (warm start), shown in the Agents section. */
  agentOptions?: JSX.Element;
  agentTools?: JSX.Element;
}
interface Preference {
  key: keyof SettingsValue;
  section: Section;
  label: string;
  description: string;
  kind: "number" | "toggle" | "select";
  defaultValue: string | number | boolean | null;
  step?: number;
  min?: number;
  max?: number;
  options?: readonly { value: string; label: string }[];
}
const sections: { name: Section; icon: string; description: string }[] = [
  { name: "Appearance", icon: "MagicStar", description: "Themes and interface typography." },
  { name: "Editor", icon: "Code1", description: "Typography, indentation and file behavior." },
  { name: "Files", icon: "DocumentText", description: "Auto Save and file saving behavior." },
  { name: "Keyboard Shortcuts", icon: "Command", description: "Find commands and make their shortcuts your own." },
  { name: "Agents", icon: "collaborators", description: "Manage agent connections for this workspace." },
  { name: "Tools", icon: "Code1", description: "Inspect available command line tools on this device." },
  { name: "Language servers", icon: "Code1", description: "Completions, hover and diagnostics from language servers." },
  { name: "Updates", icon: "Refresh2", description: "Check whether a newer Span or agent version exists. Nothing is installed automatically." },
  { name: "Workspace", icon: "Folder2", description: "Panels and the defaults for this project." },
  { name: "JSONC", icon: "Setting2", description: "Edit workspace settings with comments and trailing commas." },
];
const themes = ["Dark", "Light", "Purple"] as const;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function Dropdown(props: { id: string; label: string; value: string; options: readonly { value: string; label: string }[]; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  function close(event: PointerEvent) { if (!root.contains(event.target as Node)) setOpen(false); }
  onMount(() => document.addEventListener("pointerdown", close));
  onCleanup(() => document.removeEventListener("pointerdown", close));
  function focusOption(index: number) {
    const buttons = root.querySelectorAll<HTMLButtonElement>("[role=option]");
    buttons[(index + buttons.length) % buttons.length]?.focus();
  }
  return <div class="sp-dropdown" ref={root} onKeyDown={event => {
    if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus(); }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !props.disabled) {
      event.preventDefault();
      if (!open()) { setOpen(true); focusOption(Math.max(0, props.options.findIndex(option => option.value === props.value))); }
      else { const options = [...root.querySelectorAll<HTMLButtonElement>("[role=option]")]; focusOption(options.indexOf(document.activeElement as HTMLButtonElement) + (event.key === "ArrowDown" ? 1 : -1)); }
    }
  }}>
    <button ref={trigger} id={props.id} class="sp-select" aria-label={props.label} aria-haspopup="listbox" aria-expanded={open()} disabled={props.disabled} onClick={() => setOpen(!open())}>
      <span>{props.options.find(option => option.value === props.value)?.label ?? props.value}</span><Icon name="arrow-down4" size={13} />
    </button>
    <Show when={open() && !props.disabled}><div class="sp-options" role="listbox" aria-label={props.label}>
      <For each={props.options}>{option => <button role="option" aria-selected={props.value === option.value} onClick={() => { props.onChange(option.value); setOpen(false); trigger.focus(); }}><span>{option.label}</span><Show when={props.value === option.value}><span class="sp-check">✓</span></Show></button>}</For>
    </div></Show>
  </div>;
}

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = createSignal<Section>("Appearance");
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [json, setJson] = createSignal("");
  const [baseline, setBaseline] = createSignal("");
  const [reloadReview, setReloadReview] = createSignal(false);
  const [externalChange, setExternalChange] = createSignal(false);
  let search!: HTMLInputElement;
  const scope = () => props.scope ?? "workspace";
  const scopeName = () => scope() === "user" ? "User" : "Workspace";
  const settingsPath = () => props.settingsPath ?? (scope() === "user" ? "User profile settings.jsonc" : ".span/settings.jsonc");
  const configured = (key: keyof SettingsValue, fallback: unknown) => props.configuredKeys ? props.configuredKeys.includes(key) : props.settings[key] !== fallback;
  const dirty = createMemo(() => json() !== baseline());
  const persistedJson = () => props.settingsJsonc ?? `${JSON.stringify(props.settings, null, 2)}\n`;
  createEffect(on(persistedJson, text => {
    if (!dirty()) { setJson(text); setBaseline(text); setExternalChange(false); }
    else if (text !== baseline()) setExternalChange(true);
  }));
  createEffect(() => props.onDirtyChange?.(dirty()));
  function revert() { const text = persistedJson(); setJson(text); setBaseline(text); setReloadReview(false); setExternalChange(false); setError(""); setNotice(""); }
  onMount(() => { props.onRevertReady?.(revert); props.onSaveReady?.(saveJson); });
  const preferences = createMemo<Preference[]>(() => [
    { key: "uiFontFamily", section: "Appearance", label: "Interface font", description: "Font used in tabs, panels and menus. Fonts must be installed on this device.", kind: "select", defaultValue: "Inter", options: [{ value: "Inter", label: "Inter" }, { value: "system-ui", label: "System default" }, { value: "Arial", label: "Arial" }] },
    { key: "uiFontSize", section: "Appearance", label: "Interface font size", description: "Base size of interface text, in pixels.", kind: "number", defaultValue: 13, min: 10, max: 24 },
    { key: "zoomLevel", section: "Appearance", label: "Window zoom level", description: "Scale the whole application window. Each level changes the size by 20 percent. Reset restores the inherited or global zoom preference.", kind: "number", defaultValue: null, min: -5, max: 5, step: 0.1 },
    { key: "editorFontFamily", section: "Editor", label: "Editor font", description: "Typeface for source code. Your system monospace font is used as a fallback.", kind: "select", defaultValue: "JetBrains Mono", options: [{ value: "JetBrains Mono", label: "JetBrains Mono" }, { value: "ui-monospace", label: "System monospace" }, { value: "Menlo", label: "Menlo" }, { value: "Consolas", label: "Consolas" }] },
    { key: "fontSize", section: "Editor", label: "Editor font size", description: "Size of text in the code editor, in pixels.", kind: "number", defaultValue: 13, min: 8, max: 40 },
    { key: "tabSize", section: "Editor", label: "Tab size", description: "Number of spaces in each indentation level.", kind: "number", defaultValue: 2, min: 1, max: 8 },
    { key: "wordWrap", section: "Editor", label: "Word wrap", description: "Wrap long lines at the width of the editor.", kind: "toggle", defaultValue: false },
    { key: "tabLimitEnabled", section: "Editor", label: "Limit open tabs", description: "Close the least recently used clean tabs when opening files beyond the limit. Unsaved tabs are kept.", kind: "toggle", defaultValue: true },
    { key: "tabLimit", section: "Editor", label: "Maximum open tabs", description: "Maximum number of open file tabs. The limit applies across editor groups unless per-group is enabled.", kind: "number", defaultValue: 10, min: 1, max: 200 },
    { key: "tabLimitPerGroup", section: "Editor", label: "Limit tabs per editor group", description: "Apply the maximum separately to each editor group instead of across the workspace.", kind: "toggle", defaultValue: false },
    { key: "autoSave", section: "Files", label: "Auto Save", description: "Save changed files after a delay, when the editor loses focus, or when this window loses focus. Off keeps saving manual.", kind: "select", defaultValue: "off", options: [{ value: "off", label: "Off" }, { value: "afterDelay", label: "After delay" }, { value: "onFocusChange", label: "On focus change" }, { value: "onWindowChange", label: "On window change" }] },
    { key: "autoSaveDelay", section: "Files", label: "Auto Save delay", description: "Delay in milliseconds after the last edit. Applies only when Auto Save is set to After delay.", kind: "number", defaultValue: 1000, min: 0, max: 3600000 },
    { key: "formatOnSave", section: "Files", label: "Format on save", description: "Run the formatter configured for the file language before saving. Configure formatter commands in JSONC.", kind: "toggle", defaultValue: false },
    { key: "collapsePanelsOnDrag", section: "Workspace", label: "Collapse panels on drag", description: "Collapse a side panel when you drag its divider past its minimum width.", kind: "toggle", defaultValue: true },
    { key: "markdownPreviewDefault", section: "Workspace", label: "Open Markdown in preview", description: "Show the rendered preview when opening a Markdown file.", kind: "toggle", defaultValue: true },
  ]);
  const modifiedOnly = () => /(?:^|\s)@modified(?:\s|$)/i.test(query());
  const words = createMemo(() => query().replace(/(?:^|\s)@modified(?=\s|$)/gi, " ").replace(/@id:/gi, "").trim().toLowerCase().split(/\s+/).filter(Boolean));
  const searching = createMemo(() => words().length > 0 || modifiedOnly());
  const matches = (text: string) => words().every(word => text.toLowerCase().includes(word));
  const aliases: Partial<Record<keyof SettingsValue, string>> = { autoSave: "files.autoSave", autoSaveDelay: "files.autoSaveDelay", fontSize: "editor.fontSize", editorFontFamily: "editor.fontFamily", tabSize: "editor.tabSize", wordWrap: "editor.wordWrap", tabLimitEnabled: "workbench.editor.limit.enabled", tabLimit: "workbench.editor.limit.value", tabLimitPerGroup: "workbench.editor.limit.perEditorGroup", formatOnSave: "editor.formatOnSave", zoomLevel: "window.zoomLevel" };
  const visiblePreferences = createMemo(() => preferences().filter(item => (!modifiedOnly() || configured(item.key, item.defaultValue)) && (searching() ? matches(`${item.label} ${item.description} ${item.key} ${aliases[item.key] || ""} ${item.section}`) : item.section === section())));
  const showThemes = () => (!modifiedOnly() || configured("theme", "Dark")) && (searching() ? matches("color theme appearance dark light purple") : section() === "Appearance");
  const page = () => sections.find(item => item.name === section())!;
  const matchingSections = createMemo(() => searching() && !modifiedOnly() ? sections.filter(item => ["Keyboard Shortcuts", "Agents", "Tools", "Language servers", "Updates", "JSONC"].includes(item.name) && matches(`${item.name} ${item.description}`)) : []);
  const disabled = () => busy() || dirty();
  async function change(patch: Partial<SettingsValue>) {
    if (disabled()) return;
    setBusy(true); setError(""); setNotice("");
    try { await props.onChange(patch); setNotice("Settings saved"); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function reset(key: keyof SettingsValue, fallback: unknown) {
    if (!props.onReset) { await change({ [key]: fallback } as Partial<SettingsValue>); return; }
    if (disabled()) return;
    setBusy(true); setError(""); setNotice("");
    try { await props.onReset(key); setNotice(`${scopeName()} override removed`); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function changeScope(next: SettingsScope) {
    if (disabled() || scope() === next || !props.onScopeChange) return;
    setBusy(true); setError(""); setNotice("");
    try { await props.onScopeChange(next); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function saveJson() {
    if (busy()) return false;
    const draft = json(); setBusy(true); setError(""); setNotice("");
    try { await props.onSaveJsonc(draft); setBaseline(draft); setExternalChange(false); setNotice("Settings saved"); return true; }
    catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError("");
    try { const text = props.onReloadJsonc ? await props.onReloadJsonc() : persistedJson(); setJson(text); setBaseline(text); setReloadReview(false); setExternalChange(false); setNotice("Settings reloaded"); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function go(next: Section) { if (next === "JSONC" && props.onOpenJsonc) { props.onOpenJsonc(); return; } if (next === "Tools") props.onOpenTools?.(); setSection(next); setQuery(""); setNotice(""); }
  return <section class="settings-page" aria-label="Settings" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && section() === "JSONC") { event.preventDefault(); event.stopPropagation(); if (dirty()) void saveJson(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); event.stopPropagation(); search.focus(); search.select(); }
  }}>
    <header class="sp-toolbar"><div class="sp-search"><Icon name="SearchNormal1" size={15} /><input ref={search} type="search" aria-label="Search settings" placeholder="Search settings" value={query()} onInput={event => setQuery(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Escape" && query()) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} /><Show when={query()}><button class="close-button" aria-label="Clear settings search" onClick={() => { setQuery(""); search.focus(); }}><span class="cross" /></button></Show></div><Show when={props.onOpenJsonc}><button class="sp-open-jsonc" aria-label="Open settings JSONC" title="Open settings JSONC in editor" onClick={() => props.onOpenJsonc?.()}><Icon name="DocumentText" size={17} /></button></Show><div class="sp-scope-tabs" role="group" aria-label="Settings scope"><button aria-pressed={scope() === "user"} disabled={disabled() || !props.onScopeChange} onClick={() => void changeScope("user")}>User</button><button aria-pressed={scope() === "workspace"} disabled={disabled()} onClick={() => void changeScope("workspace")}>Workspace</button></div></header>
    <div class="sp-body"><nav class="sp-nav" aria-label="Settings sections"><For each={sections}>{item => <button aria-current={!searching() && section() === item.name ? "page" : undefined} classList={{ selected: !searching() && section() === item.name }} onClick={() => go(item.name)}><Icon name={item.icon} size={15} /><span>{item.name}</span><Show when={item.name === "JSONC" && dirty()}><span class="dirty-dot" aria-label="Unsaved JSONC" /></Show></button>}</For><div class="sp-nav-foot"><span>{props.workspaceName || "Current workspace"}</span><span>{scopeName()} settings</span></div></nav>
      <main class="sp-main"><header class="sp-page-heading"><h1>{searching() ? "Search results" : section()}</h1><p>{searching() ? `${visiblePreferences().length + (showThemes() ? 1 : 0)} matching settings` : page().description}</p></header>
        <Show when={dirty() && section() !== "JSONC"}><div class="sp-banner"><Icon name="Warning2" size={16} /><span>Save or discard your JSONC draft before changing preferences or scope.</span><button onClick={() => go("JSONC")}>Review draft</button></div></Show>
        <Show when={showThemes()}><section class="sp-group" aria-labelledby="sp-theme-heading"><div class="sp-group-heading"><h2 id="sp-theme-heading">Color theme</h2><Show when={configured("theme", "Dark")}><button class="sp-reset" disabled={disabled()} onClick={() => void reset("theme", "Dark")} aria-label={props.onReset ? "Reset color theme override" : "Reset color theme to default"}>Reset</button></Show></div><p class="sp-help">Choose the color theme for this settings scope.</p><div class="sp-themes" role="radiogroup" aria-label="Color theme" onKeyDown={event => {
          const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
          if (!direction || disabled()) return;
          event.preventDefault();
          const next = (themes.indexOf(props.settings.theme) + direction + themes.length) % themes.length;
          const group = event.currentTarget;
          void change({ theme: themes[next] }).then(() => group.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus());
        }}><For each={themes}>{theme => <button class={`sp-theme sp-theme-${theme.toLowerCase()}`} role="radio" aria-label={`${theme} theme`} aria-checked={props.settings.theme === theme} tabIndex={props.settings.theme === theme ? 0 : -1} disabled={disabled()} onClick={() => void change({ theme })}><div class="sp-theme-preview" aria-hidden="true"><div class="sp-preview-sidebar"><i /><i /><i /><i /></div><div class="sp-preview-editor"><div class="sp-preview-tabs"><i /><i /></div><div class="sp-preview-code"><i /><i /><i /><i /><i /></div></div></div><div class="sp-theme-caption"><span>{theme}</span><span class="sp-theme-check" aria-hidden="true">{props.settings.theme === theme ? "✓" : ""}</span></div></button>}</For></div></section></Show>
        <Show when={visiblePreferences().length > 0}><div class="sp-preferences"><For each={visiblePreferences()}>{item => {
          const id = `sp-${item.key}`;
          const value = () => props.settings[item.key];
          const resetPreference = () => void reset(item.key, item.defaultValue);
          return <div class="sp-preference"><div class="sp-preference-label"><label for={id}>{item.label}</label><p id={`${id}-help`}>{item.description}</p><span class="sp-setting-path">{aliases[item.key] || item.key}<Show when={props.configuredKeys}><span class="sp-origin">{configured(item.key, item.defaultValue) ? `Changed in ${scopeName()}` : "Inherited"}</span></Show></span></div><div class="sp-preference-control"><Show when={item.kind === "number"}><input id={id} class="sp-number" aria-label={item.label} aria-describedby={`${id}-help`} type="number" min={item.min} max={item.max} step={item.step || 1} value={Number(value())} disabled={disabled() || item.key === "autoSaveDelay" && props.settings.autoSave !== "afterDelay"} onChange={event => { const next = Number(event.currentTarget.value); if (!Number.isFinite(next) || !item.step && !Number.isInteger(next) || next < item.min! || next > item.max!) { setError(`${item.label} must be between ${item.min} and ${item.max}`); event.currentTarget.value = String(value()); return; } const target = event.currentTarget; void change({ [item.key]: next } as Partial<SettingsValue>).then(() => { target.value = String(value()); }); }} /></Show><Show when={item.kind === "toggle"}><button id={id} class="sp-switch" role="switch" aria-label={item.label} aria-describedby={`${id}-help`} aria-checked={Boolean(value())} disabled={disabled()} onClick={() => void change({ [item.key]: !value() } as Partial<SettingsValue>)}><span /></button></Show><Show when={item.kind === "select"}><Dropdown id={id} label={item.label} value={String(value())} options={item.options || []} disabled={disabled()} onChange={next => void change({ [item.key]: next } as Partial<SettingsValue>)} /></Show><button class="sp-reset" aria-label={props.onReset ? `Reset ${item.label.toLowerCase()} override` : `Reset ${item.label.toLowerCase()} to default`} title={props.onReset ? `Remove ${scopeName().toLowerCase()} override` : "Reset to default"} disabled={disabled() || !configured(item.key, item.defaultValue)} onClick={resetPreference}>Reset</button></div></div>;
        }}</For></div></Show>
        <Show when={matchingSections().length > 0}><div class="sp-section-results"><For each={matchingSections()}>{item => <button onClick={() => go(item.name)}><Icon name={item.icon} size={16} /><span><strong>{item.name}</strong><span>{item.description}</span></span><Icon name="arrow-right4" size={14} /></button>}</For></div></Show>
        <Show when={searching() && !showThemes() && visiblePreferences().length === 0 && matchingSections().length === 0}><div class="sp-empty"><Icon name="SearchNormal1" size={24} /><strong>No settings found</strong><p>Try a setting name, such as font, theme or wrap.</p><button class="button" onClick={() => setQuery("")}>Clear search</button></div></Show>
        <Show when={!searching() && section() === "Files"}><div class="sp-formatter-note"><p>{Object.keys(props.settings.formatters).length ? `Configured formatters: ${Object.keys(props.settings.formatters).join(", ")}.` : "No formatters configured. Add a formatter command for each language to use format on save."}</p><button class="sp-text-button" onClick={() => go("JSONC")}>Configure formatters in JSONC<Icon name="arrow-right4" size={13} /></button></div></Show>
        <Show when={!searching() && section() === "Keyboard Shortcuts"}><Show when={!dirty()} fallback={<p class="sp-help">Keyboard preferences are available after you finish reviewing the JSONC draft.</p>}>{props.shortcuts}</Show></Show>
        <Show when={!searching() && section() === "Agents"}><div class="sp-information"><Icon name="collaborators" size={25} /><h2>Agent connections</h2><p>Install and connect an Agent Client Protocol agent from the assistant panel. Agent permissions and suggested edits stay reviewable in the workspace.</p><dl><dt>Connection</dt><dd>{props.agentStatus || "Managed in the assistant panel"}</dd></dl><Show when={props.onOpenAgents}><button class="button" onClick={props.onOpenAgents}>Manage agents<Icon name="arrow-right4" size={14} /></button></Show></div>{props.agentTools}</Show>
        <Show when={!searching() && section() === "Agents" && props.agentOptions}><div class="sp-preferences">{props.agentOptions}</div></Show>
        <Show when={!searching() && section() === "Tools"}>{props.tools}</Show>
        <Show when={!searching() && section() === "Language servers"}><Show when={!dirty()} fallback={<p class="sp-help">Language server preferences are available after you finish reviewing the JSONC draft.</p>}>{props.languageServers}</Show></Show>
        <Show when={!searching() && section() === "Updates"}>{props.updates}</Show>
        <Show when={!searching() && section() === "Workspace"}><div class="sp-information sp-workspace-info"><h2>Settings scope</h2><p>User settings apply across projects. Workspace settings override user values for this project. Reset removes the value in the selected scope so the inherited value takes effect. Comments and trailing commas are supported.</p><p>Current file: <code>{settingsPath()}</code></p><button class="sp-text-button" onClick={() => go("JSONC")}>Open settings JSONC<Icon name="arrow-right4" size={13} /></button></div></Show>
        <Show when={!props.onOpenJsonc && !searching() && section() === "JSONC"}><div class="sp-json-section"><div class="sp-json-path"><code>{settingsPath()}</code><span>{dirty() ? "Unsaved changes" : "Saved"}</span></div><Show when={externalChange()}><div class="sp-banner"><Icon name="Warning2" size={15} /><span>Saved settings changed while you were editing. Your draft has been kept. Reload to review the saved version.</span></div></Show><textarea class="sp-json" aria-label="Settings JSONC" aria-describedby="sp-json-help" value={json()} spellcheck={false} disabled={busy()} onInput={event => { setJson(event.currentTarget.value); setError(""); setNotice(""); }} /><p class="sp-help" id="sp-json-help">Saving validates the full settings file before applying it. An invalid draft stays here for correction. Auto Save never applies this draft.</p><Show when={reloadReview()}><div class="sp-discard-review" role="group" aria-label="Discard JSONC draft"><span>Discard your unsaved JSONC changes and load the saved file?</span><button class="button" disabled={busy()} onClick={() => setReloadReview(false)}>Keep editing</button><button class="button" disabled={busy()} onClick={() => void reload()}>Discard and reload</button></div></Show><div class="sp-json-actions"><button class="button" disabled={busy()} onClick={() => dirty() ? setReloadReview(true) : void reload()}>Reload saved</button><button class="button primary" disabled={busy() || !dirty()} onClick={() => void saveJson()}>{busy() ? "Saving…" : "Save settings"}</button></div></div></Show>
        <Show when={props.unsupportedKeys?.length}><p class="sp-help">Preserved without applying: {props.unsupportedKeys!.join(", ")}. Extension preferences and language override blocks are not implemented.</p></Show>
        <div class="sp-feedback" aria-live="polite"><Show when={error()}><p class="error-text" role="alert">{error()}</p></Show><Show when={!error() && notice()}><p role="status">{notice()}</p></Show></div>
      </main>
    </div>
  </section>;
}
