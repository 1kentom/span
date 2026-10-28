import { For, Show, createEffect, createSignal } from "solid-js";
import type { Settings_Serialize as SettingsValue } from "../bindings";
import schema from "../../../crates/core/settings.schema.json";
import { api } from "../lib/client";
import { Modal } from "./Modal";
import Icon from "./Icon";

export function Settings(props: { settings: SettingsValue; workspaceName?: string; onJsonSaved: (settings: SettingsValue) => void; onChange: (patch: Partial<SettingsValue>) => Promise<void>; onClose: () => void }) {
  const [section, setSection] = createSignal("Appearance");
  const [menu, setMenu] = createSignal(false);
  const [json, setJson] = createSignal("");
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  createEffect(() => { setJson(`// Workspace settings, overrides your user settings.\n// Schema: ${schema.$id}\n${JSON.stringify(props.settings, null, 2)}\n`); });
  async function saveJson() {
    setError(""); setSaved(false);
    try { const value = await api.updateSettingsJsonc(json()); props.onJsonSaved(value); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <Modal label="Settings" class="settings-modal" onClose={props.onClose}>
    <header class="settings-heading"><strong>Settings</strong><span class="dim">{props.workspaceName || "span"}</span><button class="close-button" aria-label="Close settings" onClick={props.onClose}>×</button></header>
    <div class="settings-body"><nav class="settings-nav" aria-label="Settings sections"><For each={["Appearance", "Editor", "JSONC"]}>{item => <button class={section() === item ? "selected" : ""} onClick={() => setSection(item)}>{item}</button>}</For></nav>
      <div class="settings-content">
        <Show when={section() === "Appearance"}><h2>Appearance</h2><div class="setting-row"><div><strong>Color theme</strong><p>Choose how your workspace looks.</p></div><div class="custom-select"><button class="select-trigger" aria-label="Color theme" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}><span class={`theme-dot ${props.settings.theme.toLowerCase()}`} />{props.settings.theme}<Icon name="arrow-down4" size={13} /></button><Show when={menu()}><div class="select-menu" role="menu" aria-label="Color themes" onKeyDown={e => {
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button")); const i = items.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus(); }
          if (e.key === "Escape") { e.stopPropagation(); setMenu(false); }
        }}><For each={["Dark", "Light", "Purple"] as const}>{theme => <button role="menuitemradio" aria-checked={props.settings.theme === theme} onClick={() => { void props.onChange({ theme }); setMenu(false); }}><span class={`theme-dot ${theme.toLowerCase()}`} />{theme}<Show when={props.settings.theme === theme}><span class="menu-check">✓</span></Show></button>}</For></div></Show></div></div></Show>
        <Show when={section() === "Editor"}><h2>Editor</h2><div class="setting-row"><div><strong>Font size</strong><p>JetBrains Mono, 8 to 40 pixels.</p></div><input class="number-input" aria-label="Editor font size" type="number" min={schema.properties.fontSize.minimum} max={schema.properties.fontSize.maximum} value={props.settings.fontSize} onChange={e => void props.onChange({ fontSize: Number(e.currentTarget.value) })} /></div><div class="setting-row"><div><strong>Tab size</strong><p>Spaces per indentation level, 1 to 8.</p></div><input class="number-input" aria-label="Tab size" type="number" min={schema.properties.tabSize.minimum} max={schema.properties.tabSize.maximum} value={props.settings.tabSize} onChange={e => void props.onChange({ tabSize: Number(e.currentTarget.value) })} /></div><div class="setting-row"><div><strong>Word wrap</strong><p>Wrap long lines to the editor width.</p></div><button class={`switch ${props.settings.wordWrap ? "on" : ""}`} role="switch" aria-checked={props.settings.wordWrap} aria-label="Word wrap" onClick={() => void props.onChange({ wordWrap: !props.settings.wordWrap })}><span /></button></div></Show>
        <Show when={section() === "JSONC"}><h2>Workspace settings</h2><p class="settings-description">.span/settings.jsonc accepts comments and trailing commas. Values are validated against the bundled settings schema.</p><textarea class="settings-json" aria-label="Settings JSONC" value={json()} onInput={e => { setJson(e.currentTarget.value); setSaved(false); }} spellcheck={false} /><div class="settings-json-actions"><span role="status" class={error() ? "error-text" : "dim"}>{error() || (saved() ? "Settings saved" : "")}</span><button class="button primary" onClick={() => void saveJson()}>Save settings</button></div></Show>
      </div>
    </div><footer class="settings-footer"><span>Changes apply to this workspace.</span><button class="button" onClick={props.onClose}>Done</button></footer>
  </Modal>;
}
