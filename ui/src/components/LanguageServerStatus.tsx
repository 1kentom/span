import { Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import LanguageIcon from "./LanguageIcon";
import { languageDisplayName } from "../editor/language-names";
import { settleState, SETTLE_MS, statusTooltip, type LanguageState } from "../lib/language-status";
import type { HubView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface LanguageServerStatusProps {
  view: HubView;
  /** Editor language id of the active file. Without one the item is hidden. */
  language?: string;
  open: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
}

/** Holds a short busy burst back so the dot does not flicker; see settleState. */
function createSettled(source: () => LanguageState) {
  const [shown, setShown] = createSignal(source());
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const next = source();
    clearTimeout(timer);
    since = Date.now();
    const value = settleState(untrack(shown), next, 0);
    setShown(value);
    if (value !== next) timer = setTimeout(() => setShown(settleState(untrack(shown), untrack(source), Date.now() - since)), SETTLE_MS);
  });
  onCleanup(() => clearTimeout(timer));
  return shown;
}

/**
 * The one status bar item for the active file's language: its logo, with the server state as a small dot.
 * The name and the state are in the tooltip and the label. It opens the same panel as the top bar button.
 */
export function LanguageServerStatus(props: LanguageServerStatusProps) {
  const [hover, setHover] = createSignal(false);
  const [focus, setFocus] = createSignal(false);
  const hasServer = () => props.view.statusBar.visible;
  const state = createSettled(() => hasServer() ? props.view.statusBar.state : "off");
  const name = () => languageDisplayName(props.language ?? "text");
  const tooltip = () => hasServer() ? statusTooltip(name(), props.view.card?.technical, props.view.statusBar.pill) : statusTooltip(name(), undefined, undefined);
  return <Show when={props.language}>
    <span class="lsp-status" data-state={state()} data-server={hasServer() ? "yes" : "no"}>
      <button type="button" class="lsp-status-button" data-hub-trigger aria-haspopup="dialog" aria-expanded={props.open} aria-controls={props.open ? "language-intelligence-panel" : undefined}
        aria-label={`${tooltip()}. Show language support`} onClick={event => props.onToggle(event.currentTarget)}
        onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
        <LanguageIcon language={props.language} size={14} />
        <Show when={hasServer()}><i class="lsp-status-dot" aria-hidden="true" /></Show>
      </button>
      <Show when={(hover() || focus()) && !props.open}><span class="lsp-status-tooltip" role="tooltip" aria-hidden="true">{tooltip()}</span></Show>
    </span>
  </Show>;
}

export default LanguageServerStatus;
