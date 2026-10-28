import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import type { LanguageServerId } from "../bindings";
import Icon from "./Icon";
import { serverLabels } from "../lib/lsp-client";
import { describeBufferState, sizeHintLabel, stateLabels, type BufferLspState } from "../stores/language-servers";
import "../styles/language-servers.css";

export interface LanguageServerStatusProps {
  state: BufferLspState;
  autoInstall: boolean;
  onInstall: (server: LanguageServerId) => void;
  onRestart: (server: LanguageServerId) => void;
  onRetry: (server: LanguageServerId) => void;
  onOpenSettings: () => void;
  /** Last background failure for this server (events, install, restart). Shown in the popover. */
  error?: string;
  /** Set when reading the server status itself failed. */
  statusError?: string;
  /** Reads the server status again. */
  onRefresh?: () => void;
}

type Tone = "ok" | "busy" | "warn" | "bad" | "off";
const tones: Record<BufferLspState["kind"], Tone> = {
  unsupported: "off", unknown: "busy", disabled: "off", idle: "off", starting: "busy", installing: "busy", ready: "ok",
  "needs-install": "warn", "install-failed": "bad", "start-failed": "bad", "runtime-missing": "warn", crashed: "bad",
};

/** Compact status bar item for the language server behind the active file. Renders nothing for unsupported files. */
export function LanguageServerStatus(props: LanguageServerStatusProps) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const server = () => props.state.kind === "unsupported" ? undefined : props.state.server;
  const name = () => { const value = server(); return value ? serverLabels[value] : ""; };
  /** A failed status read must not leave the item on "Checking" forever. */
  const statusFailed = () => props.state.kind === "unknown" && Boolean(props.statusError);
  const stateLabel = () => statusFailed() ? "Status unavailable" : stateLabels[props.state.kind];
  const tone = () => statusFailed() ? "bad" : tones[props.state.kind];
  const message = () => statusFailed() ? props.statusError! : describeBufferState(props.state);
  const summary = () => `${name()}: ${stateLabel()}`;
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) trigger?.focus(); };

  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
    queueMicrotask(() => root.querySelector<HTMLButtonElement>(".lsp-popover button")?.focus());
  });
  createEffect(() => { if (props.state.kind === "unsupported") setOpen(false); });

  const act = (run: () => void) => () => { run(); close(); };
  const percent = () => { const state = props.state; return state.kind === "installing" && state.total ? Math.min(100, Math.round(((state.received ?? 0) / state.total) * 100)) : undefined; };

  return <Show when={server()}>{current => <div class="lsp-status" ref={root} data-tone={tone()} onKeyDown={event => { if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" class="lsp-status-button" aria-haspopup="dialog" aria-expanded={open()} aria-controls={open() ? id : undefined} aria-label={`Language server. ${summary()}`} title={message()} onClick={() => setOpen(!open())}>
      <i class="lsp-dot" aria-hidden="true" />
      <span class="lsp-status-text">{name()}<Show when={props.state.kind !== "ready"}><span class="lsp-status-state"> {stateLabel()}<Show when={percent() !== undefined}> {percent()}%</Show></span></Show></span>
    </button>
    <Show when={open()}>
      <div class="lsp-popover" id={id} role="dialog" aria-label={`${name()} language server`}>
        <div class="lsp-popover-heading"><strong>{name()}</strong><span>{stateLabel()}</span></div>
        <p class="lsp-message" role="status">{message()}</p>
        <Show when={props.error && props.error !== message() && !(statusFailed() && props.error === props.statusError)}><p class="lsp-message error-text" role="alert">{props.error}</p></Show>
        <Show when={props.state.kind === "installing"}>
          <div class="lsp-progress" role="progressbar" aria-label={`Installing ${name()}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent()}><i style={{ width: `${percent() ?? 35}%` }} classList={{ indeterminate: percent() === undefined }} /></div>
        </Show>
        {(() => {
          const state = props.state;
          return <div class="lsp-actions">
            <Show when={state.kind === "needs-install" ? state : undefined}>{needs => <>
              <button type="button" class="button primary" onClick={act(() => props.onInstall(current()))}>Install {name()}{sizeHintLabel(needs().sizeHint) ? ` (${sizeHintLabel(needs().sizeHint)})` : ""}</button>
              <Show when={!props.autoInstall}><p class="lsp-note">Automatic install is off, so nothing downloads until you choose Install.</p></Show>
            </>}</Show>
            <Show when={state.kind === "install-failed" && state.retryable}><button type="button" class="button primary" onClick={act(() => props.onRetry(current()))}>Retry install</button></Show>
            <Show when={state.kind === "install-failed" && !state.retryable}>
              <p class="lsp-note">This failure cannot be fixed by retrying. Check the settings, then restart.</p>
              <button type="button" class="button primary" onClick={act(() => props.onRestart(current()))}>Restart {name()}</button>
              <button type="button" class="lsp-link" onClick={act(props.onOpenSettings)}>Open language server settings<Icon name="arrow-right4" size={12} /></button>
            </Show>
            <Show when={Boolean(props.statusError) && props.onRefresh}><button type="button" class="button primary" onClick={act(() => props.onRefresh!())}>Retry</button></Show>
            <Show when={state.kind === "start-failed" || state.kind === "crashed"}><button type="button" class="button primary" onClick={act(() => props.onRestart(current()))}>Restart {name()}</button></Show>
            <Show when={state.kind === "runtime-missing"}>
              <button type="button" class="lsp-link" onClick={act(props.onOpenSettings)}>Open language server settings<Icon name="arrow-right4" size={12} /></button>
              <button type="button" class="button" onClick={act(() => props.onRestart(current()))}>Check again</button>
            </Show>
            <Show when={state.kind === "disabled"}><button type="button" class="lsp-link" onClick={act(props.onOpenSettings)}>Open language server settings<Icon name="arrow-right4" size={12} /></button></Show>
          </div>;
        })()}
      </div>
    </Show>
  </div>}</Show>;
}

export default LanguageServerStatus;
