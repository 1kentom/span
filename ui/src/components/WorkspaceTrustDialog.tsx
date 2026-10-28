import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Modal } from "./Modal";
import { parentFolderName, type WorkspaceTrust } from "../lib/workspace-trust";
import "../styles/workspace-trust.css";

/** True while any other dialog is on screen, so the trust question can wait its turn. */
function createOtherModalOpen() {
  const [open, setOpen] = createSignal(false);
  const scan = () => setOpen(document.querySelector(".modal-backdrop > .modal:not(.trust-modal)") !== null);
  onMount(() => {
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    onCleanup(() => observer.disconnect());
  });
  return open;
}

/** "Do you trust this folder?", asked once when a folder is opened. A centred modal: it never moves the layout. */
export function WorkspaceTrustDialog(props: { trust: WorkspaceTrust; root: () => string | undefined }) {
  const otherModal = createOtherModalOpen();
  const [parent, setParent] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const parentName = () => { const root = props.root(); return root ? parentFolderName(root) : null; };
  async function decide(decision: "trusted" | "restricted") {
    if (busy()) return;
    setBusy(true);
    try { await props.trust.decide(decision, parent() && parentName() ? "parent" : "folder"); setParent(false); }
    catch { /* the error is shown in the dialog */ }
    finally { setBusy(false); }
  }
  return <Show when={props.trust.pending() && !otherModal()}>{_ => {
    const state = () => props.trust.pending()!;
    return <Modal label="Do you trust this folder?" class="confirm-modal trust-modal" busy={busy()} initialFocus="[data-modal-default]" onClose={() => { setParent(false); props.trust.dismiss(); }}>
      <h2>Do you trust this folder?</h2>
      <p>Language support can run this project's build tool (Maven, Gradle or Cargo) to load its libraries. Trust it only if you trust where it came from.</p>
      <Show when={state().buildFiles.length}><p class="trust-files" data-testid="trust-build-files"><For each={state().buildFiles}>{(file, index) => <>{index() ? ", " : ""}<code>{file}</code></>}</For></p></Show>
      <Show when={parentName()}>{name => <label class="trust-parent"><input type="checkbox" checked={parent()} disabled={busy()} onChange={event => setParent(event.currentTarget.checked)} /><span>Trust all folders in {name()}</span></label>}</Show>
      <Show when={props.trust.error()}><p class="error-text" role="alert">{props.trust.error()}</p></Show>
      <div class="dialog-actions"><span /><button class="button" disabled={busy()} onClick={() => void decide("restricted")}>Don't trust</button><button class="button primary" data-modal-default disabled={busy()} onClick={() => void decide("trusted")}>Trust folder</button></div>
    </Modal>;
  }}</Show>;
}
