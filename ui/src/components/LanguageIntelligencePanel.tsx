import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import type { LanguageServerId } from "../bindings";
import Icon from "./Icon";
import * as copy from "../lib/language-intelligence-copy";
import type { CardView, HubAction, HubActionId, HubView, RowView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface LanguageIntelligencePanelProps {
  view: HubView;
  onAction: (action: HubActionId, server: LanguageServerId) => void;
  onToggleServer: (server: LanguageServerId, enabled: boolean) => void;
  /** Escape, outside click and the settings link close the popover. Not used when embedded in Settings. */
  onClose?: (restoreFocus: boolean) => void;
  /** Opens Settings > Language servers. Hidden when the panel is already embedded there. */
  onOpenSettings?: () => void;
  onCopy?: (text: string) => Promise<void> | void;
  /** Rendered inside Settings: a region instead of a popover dialog, no settings link. */
  embedded?: boolean;
}

function Progress(props: { card: CardView }) {
  const progress = () => props.card.progress!;
  return <div class="hub-progress-row">
    <div class="hub-progress" role="progressbar" aria-label={progress().ariaLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress().percent} aria-valuetext={progress().percent === undefined ? "In progress" : `${progress().percent} percent`}>
      <i style={progress().percent === undefined ? undefined : { width: `${progress().percent}%` }} classList={{ indeterminate: progress().indeterminate }} />
    </div>
    <span class="hub-percent" data-testid="hub-percent">{progress().percent === undefined ? "" : `${progress().percent}%`}</span>
  </div>;
}

function ActionButtons(props: { actions: HubAction[]; server: LanguageServerId; onAction: LanguageIntelligencePanelProps["onAction"] }) {
  return <div class="hub-actions"><For each={props.actions}>{action => <button type="button" class="button" classList={{ primary: action.primary }} data-action={action.id} onClick={() => props.onAction(action.id, props.server)}>{action.label}</button>}</For></div>;
}

function Failure(props: { failure: NonNullable<CardView["failure"]>; onCopy: (text: string) => Promise<void> | void }) {
  const [copied, setCopied] = createSignal(false);
  return <Show when={props.failure.details}>{details => <details class="hub-details"><summary><Icon name="arrow-right4" size={12} class="hub-chevron" />{copy.hubText.technicalDetails}</summary>
    <pre>{details()}</pre>
    <button type="button" class="button" onClick={async () => { try { await props.onCopy(details()); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); } }}>{copied() ? copy.hubText.copiedDetails : copy.hubText.copyDetails}</button>
  </details>}</Show>;
}

function Card(props: { card: CardView; onAction: LanguageIntelligencePanelProps["onAction"]; onCopy: (text: string) => Promise<void> | void }) {
  return <div class="hub-card" data-tone={props.card.tone} data-kind={props.card.kind} data-server={props.card.server}>
    <div class="hub-card-head">
      <div class="hub-card-name"><strong>{props.card.language}</strong><small>{props.card.technical}</small></div>
      <span class="hub-state"><i class="lsp-dot" aria-hidden="true" />{props.card.stateLabel}</span>
    </div>
    <div class="hub-card-body">
      <p class="hub-headline" role="status">{props.card.headline}</p>
      <Show when={props.card.progress}><Progress card={props.card} /></Show>
      <Show when={props.card.detail}><p class="hub-detail">{props.card.detail}</p></Show>
      <Show when={props.card.note}><p class="hub-note">{props.card.note}</p></Show>
      <Show when={props.card.failure}>{failure => <Failure failure={failure()} onCopy={props.onCopy} />}</Show>
      <Show when={props.card.trust}>{trust => <div class="hub-trust" data-needs-trust={trust().needsTrust}>
        <Show when={trust().restarting} fallback={<p class="hub-note">{trust().needsTrust ? <><strong>{copy.hubText.restricted}.</strong> {trust().text}</> : trust().text}</p>}><p class="hub-note" role="status">{trust().restarting}</p></Show>
      </div>}</Show>
    </div>
    <ActionButtons actions={props.card.actions} server={props.card.server} onAction={props.onAction} />
    <ul class="hub-chips" aria-label="What works for this file">
      <For each={props.card.chips}>{chip => <li class="hub-chip" classList={{ on: chip.on }} data-chip={chip.id} data-on={chip.on} tabindex="0" aria-label={`${chip.label}: ${chip.on ? "on" : "off"}. ${chip.tooltip}`}>
        <Icon name={chip.on ? "TickCircle" : "CloseCircle"} size={12} />{chip.label}
        <span class="hub-chip-tip" role="tooltip" aria-hidden="true">{chip.tooltip}</span>
      </li>}</For>
    </ul>
  </div>;
}

function Row(props: { row: RowView; onAction: LanguageIntelligencePanelProps["onAction"]; onToggle: LanguageIntelligencePanelProps["onToggleServer"] }) {
  return <li class="hub-row" data-server={props.row.server} data-tone={props.row.tone} classList={{ current: props.row.current }}>
    <i class="lsp-dot" aria-hidden="true" />
    <div class="hub-row-text"><strong>{props.row.name}</strong><small>{[props.row.stateText, props.row.version, props.row.size].filter(Boolean).join(" · ")}</small></div>
    <Show when={props.row.action}>{action => <button type="button" class="button hub-row-action" onClick={() => props.onAction(action().id, props.row.server)} aria-label={`${action().label} ${props.row.name}`}>{action().label}</button>}</Show>
    <button type="button" class="sp-switch" role="switch" aria-label={`${copy.supportName(props.row.server)} on or off`} aria-checked={props.row.enabled} onClick={() => props.onToggle(props.row.server, !props.row.enabled)}><span /></button>
  </li>;
}

/** The language intelligence hub. One component for the top bar popover and the Settings page. */
export function LanguageIntelligencePanel(props: LanguageIntelligencePanelProps): JSX.Element {
  const headingId = createUniqueId();
  let root!: HTMLDivElement;
  const onCopy = (text: string) => props.onCopy ? props.onCopy(text) : navigator.clipboard.writeText(text);
  createEffect(() => {
    if (props.embedded || !props.onClose) return;
    const close = props.onClose;
    const outside = (event: PointerEvent) => { const target = event.target as Element | null; if (target && !root.contains(target) && !target.closest("[data-hub-trigger]")) close(false); };
    // Escape closes the popover even when focus was lost, for example because the button it was on went away.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); });
    queueMicrotask(() => (root.querySelector<HTMLElement>(".hub-actions button, .hub-row-action") ?? root).focus());
  });
  return <div ref={root} class="hub-panel" classList={{ embedded: props.embedded, popover: !props.embedded }} id={props.embedded ? undefined : "language-intelligence-panel"}
    role={props.embedded ? "region" : "dialog"} aria-labelledby={headingId} tabindex="-1">
    <header class="hub-header">
      <div><h2 id={headingId}>{props.view.title}</h2><p>{props.view.subtitle}</p></div>
      <Show when={!props.embedded && props.onClose}><button type="button" class="close-button" aria-label={copy.hubText.closePanel} onClick={() => props.onClose!(true)}>×</button></Show>
    </header>
    <Show when={props.view.preview}><p class="hub-preview-note">{copy.hubText.previewLabel}</p></Show>
    <section class="hub-section" aria-label={copy.hubText.thisFile}>
      <h3>{copy.hubText.thisFile}</h3>
      <Show when={props.view.card} fallback={<p class="hub-empty">{props.view.noCardText}</p>}>{card => <Card card={card()} onAction={props.onAction} onCopy={onCopy} />}</Show>
    </section>
    <section class="hub-section" aria-label={copy.hubText.allLanguages}>
      <h3>{copy.hubText.allLanguages}</h3>
      <ul class="hub-rows"><For each={props.view.rows}>{row => <Row row={row} onAction={props.onAction} onToggle={props.onToggleServer} />}</For></ul>
    </section>
    <Show when={!props.embedded && props.onOpenSettings}><footer class="hub-footer"><button type="button" class="lsp-link" onClick={() => { props.onOpenSettings!(); props.onClose?.(false); }}>{copy.hubText.settingsLink}<Icon name="arrow-right4" size={12} /></button></footer></Show>
  </div>;
}

export default LanguageIntelligencePanel;
