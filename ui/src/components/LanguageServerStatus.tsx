import { Show } from "solid-js";
import type { HubView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface LanguageServerStatusProps {
  view: HubView;
  open: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
}

/**
 * Short summary of the language support behind the active file, for example "Java: installing 42%".
 * It opens the same panel as the top bar button. Renders nothing for files without a language server.
 * Text and label come from the hub view, and there is no title attribute that could go stale.
 */
export function LanguageServerStatus(props: LanguageServerStatusProps) {
  return <Show when={props.view.statusBar.visible}>
    <div class="lsp-status" data-tone={props.view.statusBar.tone}>
      <button type="button" class="lsp-status-button" data-hub-trigger aria-haspopup="dialog" aria-expanded={props.open} aria-controls={props.open ? "language-intelligence-panel" : undefined} aria-label={props.view.statusBar.label} onClick={event => props.onToggle(event.currentTarget)}>
        <i class="lsp-dot" aria-hidden="true" />
        <span class="lsp-status-text">{props.view.statusBar.text}</span>
      </button>
    </div>
  </Show>;
}

export default LanguageServerStatus;
