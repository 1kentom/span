import { For, Show, createSignal, type JSX } from "solid-js";
import type { LanguageServerId, LanguageServerSettings_Serialize as LanguageServerSettings } from "../bindings";
import { serverLabels } from "../lib/lsp-client";
import { stateLabels, type BufferLspState } from "../stores/language-servers";
import "../styles/language-servers.css";

export interface LanguageServerSettingsProps {
  /** Values of the scope being edited. Used for the per server switches. */
  value: LanguageServerSettings;
  /** Effective values. autoInstall, runProjectCode, javaHome and nodePath are user settings, so they are read from here. Defaults to `value`. */
  userValue?: LanguageServerSettings;
  disabled?: boolean;
  /** The language intelligence panel, shown first. When given it replaces the plain server list, because it has the same switches. */
  panel?: JSX.Element;
  /** Current state per server, when known. */
  states?: Partial<Record<LanguageServerId, BufferLspState["kind"]>>;
  /**
   * Writes exactly one key, for example `languageServers.enabled.vtsls`. `scope` is "user" for the
   * user-only keys and "current" for the scope being edited. A null value removes the key.
   */
  onChange: (key: string, value: unknown, scope: "user" | "current") => Promise<void>;
}

const servers: { id: LanguageServerId; files: string }[] = [
  { id: "vtsls", files: "TypeScript and JavaScript" },
  { id: "html", files: "HTML" },
  { id: "css", files: "CSS, SCSS and Less" },
  { id: "json", files: "JSON and JSONC" },
  { id: "rust-analyzer", files: "Rust" },
  { id: "basedpyright", files: "Python" },
  { id: "jdtls", files: "Java (needs JDK 25 or newer)" },
  { id: "svelte", files: "Svelte" },
  { id: "vue", files: "Vue" },
  { id: "astro", files: "Astro" },
];

export function LanguageServerSettings(props: LanguageServerSettingsProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const locked = () => props.disabled || busy();
  const user = () => props.userValue ?? props.value;
  async function commit(key: string, value: unknown, scope: "user" | "current") {
    if (locked()) return;
    setBusy(true); setError("");
    try { await props.onChange(`languageServers.${key}`, value, scope); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const enabled = (id: LanguageServerId) => props.value.enabled[id] !== false;
  const text = (key: "javaHome" | "nodePath", raw: string) => {
    const value = raw.trim();
    return commit(key, value ? value : null, "user");
  };
  return <section class="lsp-settings" aria-label="Language servers">
    <Show when={props.panel}>{panel => <div class="lsp-settings-group">{panel()}</div>}</Show>
    <div class="lsp-settings-group">
      <div class="sp-preference">
        <div class="sp-preference-label"><label for="sp-lsp-auto-install">Install language servers automatically</label><p id="sp-lsp-auto-install-help">Download a missing server the first time you open a matching file. When off, nothing downloads until you choose Install in the language intelligence panel.</p><span class="sp-setting-path">languageServers.autoInstall</span> <span class="lsp-scope-note">User setting</span></div>
        <div class="sp-preference-control"><button id="sp-lsp-auto-install" class="sp-switch" role="switch" aria-label="Install language servers automatically" aria-describedby="sp-lsp-auto-install-help" aria-checked={user().autoInstall} disabled={locked()} onClick={() => void commit("autoInstall", !user().autoInstall, "user")}><span /></button></div>
      </div>
    </div>
    <div class="lsp-settings-group">
      <div class="sp-preference">
        <div class="sp-preference-label"><label for="sp-lsp-run-project-code">Run project build code (build.rs, proc macros, Gradle and Maven import)</label><p id="sp-lsp-run-project-code-help">Lets Rust and Java support run the project's own build tools. Opening an untrusted project with this on can run its code on your machine. When off, they start in a restricted mode and some features are missing.</p><span class="sp-setting-path">languageServers.runProjectCode</span> <span class="lsp-scope-note">User setting</span></div>
        <div class="sp-preference-control"><button id="sp-lsp-run-project-code" class="sp-switch" role="switch" aria-label="Run project build code" aria-describedby="sp-lsp-run-project-code-help" aria-checked={user().runProjectCode} disabled={locked()} onClick={() => void commit("runProjectCode", !user().runProjectCode, "user")}><span /></button></div>
      </div>
    </div>
    <Show when={!props.panel}><div class="lsp-settings-group">
      <h2>Servers</h2>
      <p class="lsp-settings-note">Turn off a server you do not want. Its files then open without completions, hover or diagnostics.</p>
      <ul class="lsp-server-list">
        <For each={servers}>{item => <li class="lsp-server-row">
          <div><strong>{serverLabels[item.id]}</strong><small>{item.files}<Show when={props.states?.[item.id]}>{` · ${stateLabels[props.states![item.id]!]}`}</Show></small></div>
          <button class="sp-switch" role="switch" aria-label={`Enable ${serverLabels[item.id]}`} aria-checked={enabled(item.id)} disabled={locked()} onClick={() => void commit(`enabled.${item.id}`, !enabled(item.id), "current")}><span /></button>
        </li>}</For>
      </ul>
    </div></Show>
    <div class="lsp-settings-group">
      <h2>Runtimes</h2>
      <p class="lsp-settings-note">Leave empty to search this device. Changes apply to servers started afterwards; use Restart in the language intelligence panel for a running one.</p>
      <div class="lsp-field"><label for="sp-lsp-node">Node.js executable</label> <span class="lsp-scope-note">User setting</span><input id="sp-lsp-node" type="text" spellcheck={false} autocomplete="off" placeholder="Search this device" value={user().nodePath ?? ""} disabled={locked()} aria-describedby="sp-lsp-node-help" onChange={event => void text("nodePath", event.currentTarget.value)} /><p id="sp-lsp-node-help">Used by vtsls, HTML, CSS and JSON servers.</p></div>
      <div class="lsp-field"><label for="sp-lsp-java">JDK home</label> <span class="lsp-scope-note">User setting</span><input id="sp-lsp-java" type="text" spellcheck={false} autocomplete="off" placeholder="Search this device" value={user().javaHome ?? ""} disabled={locked()} aria-describedby="sp-lsp-java-help" onChange={event => void text("javaHome", event.currentTarget.value)} /><p id="sp-lsp-java-help">Used by Java support (Eclipse JDT LS), which needs JDK 25 or newer.</p></div>
    </div>
    <Show when={error()}><p class="error-text" role="alert">{error()}</p></Show>
  </section>;
}

export default LanguageServerSettings;
