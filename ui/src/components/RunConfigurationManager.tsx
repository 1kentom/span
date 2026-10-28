import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { RunCatalog_Serialize as RunCatalog, RunConfiguration_Serialize as RunConfiguration } from "../bindings";
import { Modal } from "./Modal";
import Icon, { FileIcon, MenuIcon } from "./Icon";
import "../styles/run-configurations.css";

type Form = { name: string; executable: string; args: string; cwd: string; env: string };
const toForm = (value: RunConfiguration): Form => ({ name: value.name, executable: value.executable, args: JSON.stringify(value.args ?? [], null, 2), cwd: value.cwd || ".", env: JSON.stringify(value.env ?? {}, null, 2) });
export function configurationFromForm(id: string, form: Form): RunConfiguration {
  if (!form.name.trim()) throw new Error("Enter a configuration name.");
  if (!form.executable.trim()) throw new Error("Enter an executable.");
  let args: unknown; let env: unknown;
  try { args = JSON.parse(form.args); } catch { throw new Error("Arguments must be a JSON array of strings."); }
  if (!Array.isArray(args) || args.some(value => typeof value !== "string")) throw new Error("Arguments must be a JSON array of strings.");
  try { env = JSON.parse(form.env); } catch { throw new Error("Environment must be a JSON object with string values."); }
  if (!env || Array.isArray(env) || typeof env !== "object" || Object.values(env).some(value => typeof value !== "string")) throw new Error("Environment must be a JSON object with string values.");
  return { id, name: form.name.trim(), executable: form.executable.trim(), args, cwd: form.cwd.trim() || ".", env: env as Record<string, string> };
}
export function RunConfigurationManager(props: {
  catalog: RunCatalog; selectedId?: string; available: boolean;
  onSave: (value: RunConfiguration) => Promise<RunConfiguration>;
  onDuplicate: (id: string) => Promise<RunConfiguration>;
  onDelete: (id: string) => Promise<void>;
  onSelect: (id: string) => void; onClose: () => void;
  agentTools?: JSX.Element;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveReady?: (save: (() => Promise<boolean>) | undefined) => void;
}) {
  const [selected, setSelected] = createSignal<RunConfiguration>();
  const [detected, setDetected] = createSignal(false);
  const [source, setSource] = createSignal("");
  const [form, setForm] = createSignal<Form>({ name: "", executable: "", args: "[]", cwd: ".", env: "{}" });
  const [baseline, setBaseline] = createSignal(JSON.stringify(form()));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [pending, setPending] = createSignal<() => void>();
  const [deleting, setDeleting] = createSignal<RunConfiguration>();
  let disposed = false; let saveIntent = 0;
  const dirty = createMemo(() => !detected() && JSON.stringify(form()) !== baseline());
  const writable = () => props.available && !detected() && !busy();
  const failure = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
  function load(value: RunConfiguration, readonly = false, origin = "") { setSelected(value); setDetected(readonly); setSource(origin); const next = toForm(value); setForm(next); setBaseline(JSON.stringify(next)); setError(""); setNotice(""); }
  function request(action: () => void) { saveIntent++; if (dirty()) setPending(() => action); else action(); }
  function create() { request(() => { const value = { id: "", name: "New configuration", executable: "", args: [], cwd: ".", env: {} }; load(value); setBaseline(""); }); }
  async function save(close = false): Promise<boolean> {
    if (busy() || !props.available || detected() || !selected()) return false;
    setError(""); setNotice("");
    let value: RunConfiguration;
    try { value = configurationFromForm(selected()!.id, form()); } catch (cause) { failure(cause); return false; }
    setBusy(true); const intent = ++saveIntent;
    try { const saved = await props.onSave(value); if (disposed) return false; load(saved); props.onSelect(saved.id); setNotice("Configuration saved."); if (close && intent === saveIntent) props.onClose(); return true; }
    catch (cause) { failure(cause); return false; }
    finally { if (!disposed) setBusy(false); }
  }
  async function duplicate() {
    const value = selected(); if (!value?.id || busy() || !props.available) return;
    request(() => { void (async () => { setBusy(true); setError(""); try { const copy = await props.onDuplicate(value.id); if (!disposed) { load(copy); props.onSelect(copy.id); setNotice("Editable copy saved."); } } catch (cause) { failure(cause); } finally { if (!disposed) setBusy(false); } })(); });
  }
  async function remove() {
    const value = deleting(); if (!value || busy()) return;
    setBusy(true); setError("");
    try { await props.onDelete(value.id); if (disposed) return; setDeleting(undefined); setSelected(undefined); setForm({ name: "", executable: "", args: "[]", cwd: ".", env: "{}" }); setBaseline(JSON.stringify(form())); setNotice("Configuration removed. Project files were kept."); }
    catch (cause) { failure(cause); }
    finally { if (!disposed) setBusy(false); }
  }
  createEffect(() => { if (selected()) return; const preferredTask = props.catalog.detected.find(value => value.configuration.id === props.selectedId); const value = props.catalog.configurations.find(value => value.id === props.selectedId) || (!preferredTask ? props.catalog.configurations[0] : undefined); if (value) load(value); else { const task = preferredTask || props.catalog.detected[0]; if (task) load(task.configuration, true, task.source); } });
  createEffect(() => props.onDirtyChange?.(dirty()));
  props.onSaveReady?.(() => save(false));
  onCleanup(() => { disposed = true; props.onDirtyChange?.(false); props.onSaveReady?.(undefined); });
  const edit = (key: keyof Form, value: string) => { setForm(previous => ({ ...previous, [key]: value })); setError(""); setNotice(""); };
  return <Modal label="Run configurations" class="run-manager" initialFocus={() => document.querySelector<HTMLInputElement>('#run-configuration-name')} onClose={() => request(props.onClose)} busy={busy()} onSubmit={() => save(true)}>
    <header class="run-manager-heading"><span><Icon name="u-play" size={16} /><h2>Run configurations</h2></span><button aria-label="Close run configurations" onClick={() => request(props.onClose)}><MenuIcon name="cancel" size={16} /></button></header>
    <div class="run-manager-body"><aside class="run-manager-sidebar" aria-label="Configuration list"><div class="run-manager-list-actions"><button aria-label="New configuration" title="New configuration" disabled={!props.available || busy()} onClick={create}><Icon name="Add" size={16} /></button><button aria-label="Duplicate configuration" title={detected() ? "Save an editable copy" : "Duplicate configuration"} disabled={!props.available || busy() || !selected()?.id} onClick={() => void duplicate()}><MenuIcon name="copy" size={15} /></button><button aria-label="Delete configuration" title="Delete configuration" disabled={!props.available || busy() || detected() || !selected()?.id} onClick={() => setDeleting(selected())}><MenuIcon name="trash" size={15} /></button></div>
      <div class="run-manager-list" role="listbox" aria-label="Configurations" onKeyDown={event => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return; event.preventDefault(); const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')]; const index = rows.indexOf(document.activeElement as HTMLButtonElement); rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus(); }}><Show when={props.catalog.configurations.length}><div class="run-select-heading">Saved configurations</div><For each={props.catalog.configurations}>{value => <button role="option" aria-selected={!detected() && selected()?.id === value.id} disabled={busy()} onClick={() => request(() => load(value))}><Icon name="u-gear" size={14} /><span>{value.name}</span></button>}</For></Show><Show when={props.catalog.detected.length}><div class="run-select-heading">Detected tasks</div><For each={props.catalog.detected}>{task => <button role="option" aria-selected={detected() && selected()?.id === task.configuration.id} disabled={busy()} onClick={() => request(() => load(task.configuration, true, task.source))}><FileIcon path={task.source} /><span>{task.configuration.name}<small>{task.source}</small></span></button>}</For></Show></div>
    </aside><main class="run-manager-form"><Show when={!props.available}><p class="run-notice">Run configurations require the desktop app. Browser preview does not save or execute commands.</p></Show><Show when={selected()} fallback={<div class="run-manager-empty"><Icon name="u-play" size={28} /><h3>Create a run configuration</h3><p>Choose an executable and arguments for this workspace.</p><button class="button" disabled={!props.available} onClick={create}>New configuration</button></div>}>
      <Show when={detected()}><div class="run-notice">Detected from {source()}. This task is read-only.<button disabled={!props.available || busy()} onClick={() => void duplicate()}>Save an editable copy</button></div></Show>
      <label class="run-field"><span>Name</span><input id="run-configuration-name" aria-label="Configuration name" value={form().name} disabled={!writable()} onInput={event => edit("name", event.currentTarget.value)} /></label>
      <div class="run-field"><span>Type</span><span class="run-type">Executable · non-interactive process</span></div>
      <label class="run-field"><span>Executable</span><input aria-label="Executable" placeholder="npm, python, or an executable path" spellcheck={false} value={form().executable} disabled={!writable()} onInput={event => edit("executable", event.currentTarget.value)} /></label>
      <label class="run-field"><span>Arguments</span><textarea aria-label="Arguments JSON" spellcheck={false} rows={3} value={form().args} disabled={!writable()} onInput={event => edit("args", event.currentTarget.value)} /></label>
      <p class="run-field-help">A JSON array of strings, for example ["run", "dev"]. No shell is added.</p>
      <label class="run-field"><span>Working directory</span><input aria-label="Working directory" spellcheck={false} value={form().cwd} disabled={!writable()} onInput={event => edit("cwd", event.currentTarget.value)} /></label>
      <p class="run-field-help">Relative to the workspace. Supports {'${workspaceFolder}'}.</p>
      <label class="run-field"><span>Environment</span><textarea aria-label="Environment JSON" spellcheck={false} rows={4} value={form().env} disabled={!writable()} onInput={event => edit("env", event.currentTarget.value)} /></label>
      <p class="run-field-help">.span/run.json is a project file stored as plaintext. Use {'${env:NAME}'} for credentials; values are resolved only when a run starts.</p>
      <div class="run-manager-policy">Processes use files on disk. Unsaved editor changes are not saved automatically. Interactive input and debugger sessions are not available.</div>
    </Show>{props.agentTools}<Show when={error()}><p class="run-error" role="alert">{error()}</p></Show><Show when={notice()}><p class="run-feedback" role="status">{notice()}</p></Show></main></div>
    <footer class="run-manager-footer"><span>{dirty() ? "Unapplied changes" : detected() ? "Detected task" : "Workspace configurations"}</span><div class="dialog-actions"><button class="button" data-modal-cancel onClick={() => request(props.onClose)}>Cancel</button><button class="button" disabled={!writable() || !selected() || !dirty()} onClick={() => void save(false)}>Apply</button><button class="button primary" data-modal-default disabled={!writable() || !selected()} onClick={() => void save(true)}>OK</button></div></footer>
    <Show when={pending()}><Modal label="Unapplied configuration changes" onClose={() => setPending(undefined)}><div class="run-review"><h3>Discard unapplied changes?</h3><p>Your saved configurations will be kept.</p><div class="dialog-actions"><button class="button" onClick={() => setPending(undefined)}>Keep editing</button><button class="button danger" onClick={() => { const action = pending(); setPending(undefined); action?.(); }}>Discard changes</button></div></div></Modal></Show>
    <Show when={deleting()}>{value => <Modal label="Delete run configuration" onClose={() => setDeleting(undefined)} busy={busy()} onSubmit={remove}><div class="run-review"><h3>Delete {value().name}?</h3><p>This removes the saved configuration. Project files and running processes are kept.</p><div class="dialog-actions"><button class="button" data-modal-cancel>Cancel</button><button class="button danger" data-modal-default disabled={busy()}>Delete configuration</button></div><Show when={error()}><p class="run-error" role="alert">{error()}</p></Show></div></Modal>}</Show>
  </Modal>;
}
