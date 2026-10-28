import { For, Show, createSignal } from "solid-js";
import type { LanguageServerId, LanguageServerSettings_Serialize as LanguageServerSettings } from "../bindings";
import { serverLabels } from "../lib/lsp-client";
import { stateLabels, type BufferLspState } from "../stores/language-servers";
import "../styles/language-servers.css";

export interface LanguageServerSettingsProps {
  value: LanguageServerSettings;
  disabled?: boolean;
  /** Current state per server, when known. */
  states?: Partial<Record<LanguageServerId, BufferLspState["kind"]>>;
  onChange: (next: LanguageServerSettings) => Promise<void>;
}

const servers: { id: LanguageServerId; files: string }[] = [
  { id: "vtsls", files: "TypeScript and JavaScript" },
  { id: "html", files: "HTML" },
  { id: "css", files: "CSS, SCSS and Less" },
  { id: "json", files: "JSON and JSONC" },
  { id: "rust-analyzer", files: "Rust" },
  { id: "basedpyright", files: "Python" },
  { id: "jdtls", files: "Java (needs JDK 25 or newer)" },
];

export function LanguageServerSettings(props: LanguageServerSettingsProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const locked = () => props.disabled || busy();
  async function commit(next: LanguageServerSettings) {
    if (locked()) return;
    setBusy(true); setError("");
    try { await props.onChange(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const enabled = (id: LanguageServerId) => props.value.enabled[id] !== false;
  const text = (key: "javaHome" | "nodePath", raw: string) => {
    const value = raw.trim();
    return commit({ ...props.value, [key]: value ? value : null });
  };
  return <section class="lsp-settings" aria-label="Language servers">
    <div class="lsp-settings-group">
      <div class="sp-preference">
        <div class="sp-preference-label"><label for="sp-lsp-auto-install">Install language servers automatically</label><p id="sp-lsp-auto-install-help">Download a missing server the first time you open a matching file. When off, nothing downloads until you choose Install in the status bar.</p><span class="sp-setting-path">languageServers.autoInstall</span></div>
        <div class="sp-preference-control"><button id="sp-lsp-auto-install" class="sp-switch" role="switch" aria-label="Install language servers automatically" aria-describedby="sp-lsp-auto-install-help" aria-checked={props.value.autoInstall} disabled={locked()} onClick={() => void commit({ ...props.value, autoInstall: !props.value.autoInstall })}><span /></button></div>
      </div>
    </div>
    <div class="lsp-settings-group">
      <h2>Servers</h2>
      <p class="lsp-settings-note">Turn off a server you do not want. Its files then open without completions, hover or diagnostics.</p>
      <ul class="lsp-server-list">
        <For each={servers}>{item => <li class="lsp-server-row">
          <div><strong>{serverLabels[item.id]}</strong><small>{item.files}<Show when={props.states?.[item.id]}>{` · ${stateLabels[props.states![item.id]!]}`}</Show></small></div>
          <button class="sp-switch" role="switch" aria-label={`Enable ${serverLabels[item.id]}`} aria-checked={enabled(item.id)} disabled={locked()} onClick={() => void commit({ ...props.value, enabled: { ...props.value.enabled, [item.id]: !enabled(item.id) } })}><span /></button>
        </li>}</For>
      </ul>
    </div>
    <div class="lsp-settings-group">
      <h2>Runtimes</h2>
      <p class="lsp-settings-note">Leave empty to search this device. Changes apply to servers started afterwards; use Restart in the status bar for a running one.</p>
      <div class="lsp-field"><label for="sp-lsp-node">Node.js executable</label><input id="sp-lsp-node" type="text" spellcheck={false} autocomplete="off" placeholder="Search this device" value={props.value.nodePath ?? ""} disabled={locked()} aria-describedby="sp-lsp-node-help" onChange={event => void text("nodePath", event.currentTarget.value)} /><p id="sp-lsp-node-help">Used by vtsls, HTML, CSS and JSON servers.</p></div>
      <div class="lsp-field"><label for="sp-lsp-java">JDK home</label><input id="sp-lsp-java" type="text" spellcheck={false} autocomplete="off" placeholder="Search this device" value={props.value.javaHome ?? ""} disabled={locked()} aria-describedby="sp-lsp-java-help" onChange={event => void text("javaHome", event.currentTarget.value)} /><p id="sp-lsp-java-help">Used by JDT LS, which needs JDK 25 or newer.</p></div>
    </div>
    <Show when={error()}><p class="error-text" role="alert">{error()}</p></Show>
  </section>;
}

export default LanguageServerSettings;
