import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import type { LanguageServerId } from "../bindings";
import Icon from "./Icon";
import * as copy from "../lib/language-intelligence-copy";
import { allLanguagesOpen, setAllLanguagesOpen } from "../lib/hub-prefs";
import type { CardView, HubActionId, HubView, RowView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface LanguageIntelligencePanelProps {
  view: HubView;
  onAction: (action: HubActionId, server: LanguageServerId) => void;
  onToggleServer: (server: LanguageServerId, enabled: boolean) => void;
  /** Escape and an outside click close the popover. Not used when embedded in Settings. */
  onClose?: (restoreFocus: boolean) => void;
  /** Opens Settings > Language servers. Hidden when the panel is already embedded there. */
  onOpenSettings?: () => void;
  onCopy?: (text: string) => Promise<void> | void;
  /** Rendered inside Settings: a region instead of a popover dialog, with the list always open. */
  embedded?: boolean;
}

/** The panel is built from zones of fixed height, so no state changes its size. Only the "All languages" list may. */
function Row(props: { row: RowView; onAction: LanguageIntelligencePanelProps["onAction"]; onToggle: LanguageIntelligencePanelProps["onToggleServer"] }) {
  const tip = () => [props.row.version, props.row.size].filter(Boolean).join(", ");
  return <li class="hub-row" data-server={props.row.server} data-tone={props.row.tone} classList={{ current: props.row.current }}>
    <i class="lsp-dot" aria-hidden="true" />
    <span class="hub-row-name" data-tip={tip() || undefined}>{props.row.name}</span>
    <span class="hub-row-word">{props.row.stateText}</span>
    <Show when={props.row.action}>{action => <button type="button" class="hub-text-button hub-row-action" onClick={() => props.onAction(action().id, props.row.server)} aria-label={`${action().label} ${props.row.name}`}>{action().label}</button>}</Show>
    <button type="button" class="sp-switch" role="switch" aria-label={`${props.row.name} on or off`} aria-checked={props.row.enabled} onClick={() => props.onToggle(props.row.server, !props.row.enabled)}><span /></button>
  </li>;
}

function Zones(props: { card?: CardView; view: HubView; onAction: LanguageIntelligencePanelProps["onAction"]; onCopy: (text: string) => Promise<void> | void }) {
  const [copied, setCopied] = createSignal(false);
  const percent = () => props.card?.progress?.percent;
  const run = async (card: CardView, id: HubActionId) => {
    if (id !== "copyDetails") return props.onAction(id, card.server);
    try { await props.onCopy(card.failure?.details ?? card.failure?.reason ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  const label = (id: HubActionId, text: string) => id === "copyDetails" && copied() ? copy.hubText.copiedDetails : text;
  return <>
    <div class="hub-head">
      <div class="hub-name">
        <strong>{props.card?.language ?? props.view.title}</strong>
        <small>{props.card ? `${props.card.technical}${props.view.preview ? ` · ${copy.hubText.previewTag}` : ""}` : ""}</small>
      </div>
      <Show when={props.card}>{card => <span class="hub-state" data-tone={card().tone} data-tip={card().stateLabel}>
        <i class="lsp-dot" role="img" aria-label={card().stateLabel} />
        <span class="hub-state-word">{card().stateWord}</span>
      </span>}</Show>
    </div>
    <div class="hub-status" data-tip={props.card?.statusTip} aria-description={props.card?.statusTip}>
      <p class="hub-status-text" role="status">{props.card ? props.card.status : props.view.noCardText}</p>
      <span class="hub-percent" data-testid="hub-percent">{copy.percentText(percent())}</span>
    </div>
    <div class="hub-progress" classList={{ idle: !props.card?.progress }} role={props.card?.progress ? "progressbar" : undefined} aria-label={props.card?.progress?.ariaLabel} aria-hidden={props.card?.progress ? undefined : "true"}
      aria-valuemin={props.card?.progress ? 0 : undefined} aria-valuemax={props.card?.progress ? 100 : undefined} aria-valuenow={props.card?.progress ? percent() : undefined}
      aria-valuetext={props.card?.progress ? (percent() === undefined ? "In progress" : `${percent()} percent`) : undefined}>
      <i style={{ width: percent() === undefined ? undefined : `${percent()}%` }} classList={{ indeterminate: Boolean(props.card?.progress?.indeterminate) }} />
    </div>
    <div class="hub-actions">
      <For each={props.card?.actions ?? []}>{action => <button type="button" class="button hub-button-action" classList={{ primary: action.primary }} data-action={action.id} onClick={() => void run(props.card!, action.id)}>{label(action.id, action.label)}</button>}</For>
    </div>
  </>;
}

/** The language intelligence hub. One component for the top bar popover and the Settings page. */
export function LanguageIntelligencePanel(props: LanguageIntelligencePanelProps): JSX.Element {
  const listId = createUniqueId();
  let root!: HTMLDivElement;
  const onCopy = (text: string) => props.onCopy ? props.onCopy(text) : navigator.clipboard.writeText(text);
  const listOpen = () => props.embedded || allLanguagesOpen();
  createEffect(() => {
    if (props.embedded || !props.onClose) return;
    const close = props.onClose;
    const outside = (event: PointerEvent) => { const target = event.target as Element | null; if (target && !root.contains(target) && !target.closest("[data-hub-trigger]")) close(false); };
    // Escape closes the popover even when focus was lost, for example because the button it was on went away.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); });
    queueMicrotask(() => (root.querySelector<HTMLElement>(".hub-actions button") ?? root).focus());
  });
  return <div ref={root} class="hub-panel" classList={{ embedded: props.embedded, popover: !props.embedded }} id={props.embedded ? undefined : "language-intelligence-panel"}
    role={props.embedded ? "region" : "dialog"} aria-label={props.view.title} data-kind={props.view.card?.kind ?? "none"} tabindex="-1">
    <Zones card={props.view.card} view={props.view} onAction={props.onAction} onCopy={onCopy} />
    <div class="hub-foot">
      <div class="hub-trust-row">
        <Show when={props.view.card?.trust}>{trust => <>
          <span class="hub-trust" tabindex="0" data-needs-trust={trust().needsTrust} data-tip={trust().tip} aria-description={trust().tip}>{trust().label}<Show when={trust().needsTrust}><span class="hub-why">{copy.hubText.why}</span></Show></span>
          <Show when={trust().trusted && !trust().restarting}><button type="button" class="hub-text-button" onClick={() => props.onAction("stopTrusting", props.view.card!.server)}>{copy.hubText.stopTrusting}</button></Show>
        </>}</Show>
      </div>
      <div class="hub-all-row">
        <Show when={!props.embedded} fallback={<span class="hub-all-label">{copy.hubText.allLanguages}</span>}>
          <button type="button" class="hub-text-button hub-all" aria-expanded={listOpen()} aria-controls={listId} onClick={() => setAllLanguagesOpen(!allLanguagesOpen())}>{copy.hubText.allLanguages}<Icon name={listOpen() ? "arrow-down4" : "arrow-right4"} size={12} /></button>
        </Show>
        <Show when={!props.embedded && props.onOpenSettings}><button type="button" class="hub-text-button hub-settings-link" onClick={() => { props.onOpenSettings!(); props.onClose?.(false); }}>{copy.hubText.settingsLink}</button></Show>
      </div>
    </div>
    <ul id={listId} class="hub-rows" hidden={!listOpen()}><For each={props.view.rows}>{row => <Row row={row} onAction={props.onAction} onToggle={props.onToggleServer} />}</For></ul>
  </div>;
}

export default LanguageIntelligencePanel;
