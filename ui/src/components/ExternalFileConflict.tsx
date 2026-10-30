import { Show, createSignal } from "solid-js";
import type { ExternalFileState } from "../bindings";
import { MenuIcon } from "./Icon";
import { Modal } from "./Modal";
import "../styles/external-file-conflict.css";

const PREVIEW_LIMIT = 64 * 1024;
type Resolution = "reload" | "overwrite";

function preview(value: string) {
  if (value.length <= PREVIEW_LIMIT) return { text: value, truncated: false };
  let end = PREVIEW_LIMIT;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

function message(state: ExternalFileState) {
  if (state.kind === "deleted" || state.disk?.exists === false) return "This file was deleted on disk. Your editor draft is still here.";
  if (state.kind === "unavailable") return "The current disk version could not be read. Your editor draft is still here.";
  return "This file changed on disk. Your editor draft is still here.";
}

export function ExternalFileConflict(props: {
  state?: ExternalFileState;
  currentText: string;
  open: boolean;
  busy?: boolean;
  onReview: () => void;
  onClose: () => void;
  onResolve: (action: Resolution) => Promise<void>;
  onCopy?: (text: string) => Promise<void>;
}) {
  const [resolving, setResolving] = createSignal(false);
  const [error, setError] = createSignal("");
  const busy = () => Boolean(props.busy || resolving());
  const diskExists = () => props.state?.disk?.exists === true;
  const deleted = () => props.state?.kind === "deleted" || props.state?.disk?.exists === false;
  const canOverwrite = () => Boolean(props.state?.disk?.token) || deleted();
  const currentPreview = () => preview(props.currentText);
  const diskPreview = () => preview(props.state?.disk?.text ?? "");

  async function resolve(action: Resolution) {
    if (busy()) return;
    setResolving(true); setError("");
    try { await props.onResolve(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setResolving(false); }
  }

  async function copyDraft() {
    if (busy() || !props.onCopy) return;
    setResolving(true); setError("");
    try { await props.onCopy(props.currentText); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setResolving(false); }
  }

  return <Show when={props.state} keyed>{state => <>
    <section class="external-conflict-banner" role="status" aria-live="polite">
      <span class="external-conflict-copy"><strong>{message(state)}</strong><span class="external-conflict-path">{state.path}</span></span>
      <button class="button external-conflict-review" type="button" onClick={props.onReview}>Compare</button>
    </section>
    <Show when={props.open}>
      <Modal label="Compare external file changes" class="external-conflict-modal" initialFocus="#external-file-keep-editing" onClose={props.onClose} busy={busy()}>
        <header class="external-conflict-heading">
          <h2>Compare disk and editor</h2>
          <p>{state.path}. Review both versions before choosing an action.</p>
        </header>
        <Show when={state.error}><p class="external-conflict-error" role="note">{state.error}</p></Show>
        <div class="external-conflict-columns">
          <section class="external-conflict-column" aria-labelledby="external-conflict-editor-title">
            <h3 id="external-conflict-editor-title">Editor draft</h3>
            <pre aria-labelledby="external-conflict-editor-title"><code>{currentPreview().text}</code></pre>
            <Show when={currentPreview().truncated}><p class="external-conflict-truncated">Preview limited to 64 KiB. The draft itself is unchanged.</p></Show>
          </section>
          <section class="external-conflict-column" aria-labelledby="external-conflict-disk-title">
            <h3 id="external-conflict-disk-title">Disk version</h3>
            <Show when={state.disk?.exists} fallback={<pre class="external-conflict-missing" aria-labelledby="external-conflict-disk-title"><code>{deleted() ? "This file is missing on disk." : state.error || "Disk contents are unavailable."}</code></pre>}>
              <pre aria-labelledby="external-conflict-disk-title"><code>{diskPreview().text}</code></pre>
              <Show when={state.disk?.truncated || diskPreview().truncated}><p class="external-conflict-truncated">Disk preview is truncated. Reload uses the saved disk file.</p></Show>
            </Show>
          </section>
        </div>
        <Show when={error()}><div class="external-conflict-error" role="alert"><span>{error()}</span><button class="button" type="button" disabled={busy()} onClick={props.onReview}>Refresh comparison</button></div></Show>
        <div class="dialog-actions external-conflict-actions">
          <button class="button" id="external-file-keep-editing" type="button" data-modal-cancel disabled={busy()}><MenuIcon name="cancel" size={15} />Keep Editing</button>
          <span />
          <Show when={state.kind === "unavailable" && !state.disk && props.onCopy}><button class="button" type="button" disabled={busy()} onClick={() => void copyDraft()}><MenuIcon name="copy" size={15} />Copy editor draft</button></Show>
          <button class="button" type="button" disabled={busy() || !diskExists() || !!state.error} onClick={() => void resolve("reload")}><MenuIcon name="save" size={15} />Reload from Disk</button>
          <button class="button primary external-conflict-destructive" type="button" disabled={busy() || !canOverwrite()} onClick={() => void resolve("overwrite")}>{deleted() ? "Recreate File" : "Overwrite Disk"}</button>
        </div>
      </Modal>
    </Show>
  </>}</Show>;
}
