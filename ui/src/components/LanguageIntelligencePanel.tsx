import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import type { LanguageServerId } from "../bindings";
import Icon from "./Icon";
import LanguageIcon from "./LanguageIcon";
import * as copy from "../lib/language-intelligence-copy";
import { languageDisplayName } from "../editor/language-names";
import { serverLanguage } from "../lib/language-icons";
import { filterRows, filterUseful, searchUseful, type RowFilter } from "../lib/language-status";
import type { CardView, HubAction, HubActionId, HubView, RowView } from "../stores/language-intelligence";
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
  /** Rendered inside Settings: a region instead of a popover dialog. */
  embedded?: boolean;
  /** Editor language id of the active file. It names and draws the header, also for files without a server. */
  fileLanguage?: string;
  /** "top" hangs under the top bar button, "bottom" stands above the status bar item. */
  placement?: "top" | "bottom";
}

type Run = (card: CardView, id: HubActionId) => void;

/** Restart, Stop and Copy details: the actions a working server rarely needs, behind one button. */
function menuItems(card: CardView, enabled: boolean): HubAction[] {
  const items: HubAction[] = [];
  if (["ready", "working", "failed", "crashed", "install-failed", "runtime-missing"].includes(card.kind) && !card.trust?.restarting) items.push({ id: "restart", label: copy.hubText.restart });
  if (enabled && card.kind !== "disabled" && card.kind !== "needs-install" && card.kind !== "unavailable") items.push({ id: "stop", label: copy.hubText.stop });
  if (card.failure?.details) items.push({ id: "copyDetails", label: copy.hubText.copyDetails });
  return items;
}

function OverflowMenu(props: { card: CardView; items: HubAction[]; run: Run }) {
  const [open, setOpen] = createSignal(false);
  const menuId = createUniqueId();
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const entries = () => [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
  const show = () => { setOpen(true); queueMicrotask(() => entries()[0]?.focus()); };
  const hide = (refocus = true) => { setOpen(false); if (refocus) trigger.focus(); };
  createEffect(() => {
    if (!open()) return;
    const outside = (event: PointerEvent) => { if (!menu?.contains(event.target as Node) && !trigger.contains(event.target as Node)) hide(false); };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });
  const onKey = (event: KeyboardEvent) => {
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => { event.preventDefault(); list[(index + list.length) % list.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); event.stopPropagation(); hide(event.key === "Escape"); }
  };
  return <span class="hub-menu-anchor">
    <button ref={trigger} type="button" class="hub-icon-button" aria-label={copy.hubText.more} aria-haspopup="menu" aria-expanded={open()} aria-controls={open() ? menuId : undefined}
      onClick={() => open() ? hide() : show()} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); show(); } }}>
      <Icon name="3DotsMore" size={16} />
    </button>
    <Show when={open()}>
      <div ref={menu} id={menuId} class="hub-menu" role="menu" aria-label={copy.hubText.more} onKeyDown={onKey}>
        <For each={props.items}>{item => <button type="button" role="menuitem" tabindex="-1" data-action={item.id} onClick={() => { hide(); props.run(props.card, item.id); }}>{item.label}</button>}</For>
      </div>
    </Show>
  </span>;
}

function Row(props: { row: RowView; onAction: LanguageIntelligencePanelProps["onAction"]; onToggle: LanguageIntelligencePanelProps["onToggleServer"] }) {
  const tip = () => [props.row.version, props.row.size].filter(Boolean).join(", ");
  const stateName = () => copy.stateName(props.row.kind);
  return <li class="hub-row" data-server={props.row.server} data-state={props.row.state} data-tone={props.row.tone} classList={{ current: props.row.current }}>
    <LanguageIcon language={serverLanguage(props.row.server)} size={16} />
    <span class="hub-row-text" data-tip={tip() || undefined}>
      <span class="hub-row-name">{props.row.name}</span>
      <span class="hub-row-server">{props.row.technical}</span>
    </span>
    <span class="hub-row-word">{props.row.stateText}</span>
    <Show when={props.row.action}>{action => <button type="button" class="hub-row-action" onClick={() => props.onAction(action().id, props.row.server)} aria-label={`${action().label} ${props.row.name}`}>{action().label}</button>}</Show>
    <Show when={props.row.state === "starting"} fallback={<i class="lsp-dot" role="img" aria-label={stateName()} />}>
      <i class="hub-spinner" role="img" aria-label={stateName()} />
    </Show>
    <button type="button" class="sp-switch" role="switch" aria-label={`${props.row.name} language support`} aria-checked={props.row.enabled} onClick={() => props.onToggle(props.row.server, !props.row.enabled)}><span /></button>
  </li>;
}

/** The language server popover, and the same panel embedded in Settings. */
export function LanguageIntelligencePanel(props: LanguageIntelligencePanelProps): JSX.Element {
  const listLabel = createUniqueId();
  let root!: HTMLDivElement;
  const [copied, setCopied] = createSignal(false);
  const [filter, setFilter] = createSignal<RowFilter>("all");
  const [query, setQuery] = createSignal("");
  const card = () => props.view.card;
  const onCopy = (text: string) => props.onCopy ? props.onCopy(text) : navigator.clipboard.writeText(text);
  const run: Run = async (target, id) => {
    if (id !== "copyDetails") return props.onAction(id, target.server);
    try { await onCopy(target.failure?.details ?? target.failure?.reason ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  const headerLanguage = () => props.fileLanguage || (card() ? serverLanguage(card()!.server) : undefined);
  const headerName = () => props.fileLanguage ? languageDisplayName(props.fileLanguage) : card()?.language ?? props.view.title;
  const enabled = () => props.view.rows.find(row => row.server === card()?.server)?.enabled ?? true;
  const items = createMemo(() => card() ? menuItems(card()!, enabled()) : []);
  /** Running servers keep Restart in the menu; trust has its own line. */
  const actions = () => (card()?.actions ?? []).filter(action => action.id !== "trust" && !(action.id === "restart" && (card()!.kind === "ready" || card()!.kind === "working")));
  const statusText = () => {
    const current = card();
    if (!current) return props.view.hasFile && props.fileLanguage && props.fileLanguage !== "text" ? copy.hubText.noServerFor(headerName()) : props.view.noCardText;
    return current.kind === "ready" && !current.trust?.restarting ? "" : current.status;
  };
  const showFilter = () => filterUseful(props.view.rows);
  const rows = () => filterRows(props.view.rows, showFilter() ? filter() : "all", searchUseful(props.view.rows) ? query() : "");
  const percent = () => card()?.progress?.percent;
  // Rows are keyed by server id, so a refreshed view updates them in place and keyboard focus stays on the switch.
  const rowById = (id: LanguageServerId) => props.view.rows.find(row => row.server === id)!;

  const onListKey = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const switches = [...root.querySelectorAll<HTMLElement>(".hub-row [role=switch]")];
    const row = (document.activeElement as HTMLElement | null)?.closest(".hub-row");
    const at = switches.findIndex(item => item.closest(".hub-row") === row);
    const next = event.key === "Home" ? 0 : event.key === "End" ? switches.length - 1 : event.key === "ArrowDown" ? Math.min(switches.length - 1, at + 1) : Math.max(0, at - 1);
    event.preventDefault();
    switches[next]?.focus();
  };

  createEffect(() => {
    if (props.embedded || !props.onClose) return;
    const close = props.onClose;
    const outside = (event: PointerEvent) => { const target = event.target as Element | null; if (target && !root.contains(target) && !target.closest("[data-hub-trigger]")) close(false); };
    // Escape closes the popover even when focus was lost, for example because the button it was on went away.
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    onCleanup(() => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); });
    queueMicrotask(() => (root.querySelector<HTMLElement>(".hub-actions button, .hub-row.current [role=switch]") ?? root).focus());
  });

  return <div ref={root} class="hub-panel" classList={{ embedded: props.embedded, popover: !props.embedded }} id={props.embedded ? undefined : "language-intelligence-panel"}
    role={props.embedded ? "region" : "dialog"} aria-label={props.view.title} data-kind={card()?.kind ?? "none"} data-placement={props.placement ?? "top"} tabindex="-1">
    <div class="hub-head">
      <LanguageIcon language={headerLanguage()} size={24} class="hub-head-icon" />
      <div class="hub-name">
        <strong>{headerName()}</strong>
        <small>{card() ? `${card()!.technical}${props.view.preview ? ` · ${copy.hubText.previewTag}` : ""}` : copy.hubText.noServerName}</small>
      </div>
      <Show when={card()}>{current => <>
        <span class="hub-pill" data-state={current().state} data-tone={current().tone}>
          <i class="lsp-dot" aria-hidden="true" />
          <span class="hub-state-word">{current().pill}</span>
        </span>
        <Show when={items().length}><OverflowMenu card={current()} items={items()} run={run} /></Show>
      </>}</Show>
    </div>

    <Show when={statusText()}>
      <div class="hub-status" data-tip={card()?.statusTip} aria-description={card()?.statusTip}>
        <p class="hub-status-text" role="status">{statusText()}</p>
        <Show when={percent() !== undefined}><span class="hub-percent" data-testid="hub-percent">{copy.percentText(percent())}</span></Show>
      </div>
    </Show>
    <Show when={card()?.progress}>{progress => <div class="hub-progress" role="progressbar" aria-label={progress().ariaLabel} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={progress().percent} aria-valuetext={progress().percent === undefined ? "In progress" : `${progress().percent} percent`}>
      <i style={{ width: progress().percent === undefined ? undefined : `${progress().percent}%` }} classList={{ indeterminate: progress().indeterminate }} />
    </div>}</Show>
    <Show when={card()?.failure}>{failure => <div class="hub-error" role="alert">
      <p class="hub-error-reason">{failure().reason}</p>
      <Show when={failure().details}><code class="hub-error-details">{failure().details}</code></Show>
    </div>}</Show>
    <Show when={actions().length}>
      <div class="hub-actions">
        <For each={actions()}>{action => <button type="button" class="button hub-button-action" classList={{ primary: action.primary }} data-action={action.id} onClick={() => void run(card()!, action.id)}>
          {action.id === "copyDetails" && copied() ? copy.hubText.copiedDetails : action.label}
        </button>}</For>
      </div>
    </Show>

    <Show when={card()}>{current => <ul class="hub-chips" aria-label={copy.hubText.capabilities}>
      <For each={current().chips}>{chip => <li class="hub-chip" data-on={chip.on}>{chip.label}<Show when={!chip.on}><span class="sr-only">, {copy.hubText.unsupported}</span></Show></li>}</For>
    </ul>}</Show>

    <Show when={card()?.trust}>{trust => <div class="hub-trust-block" data-needs-trust={trust().needsTrust}>
      <div class="hub-trust-row">
        <i class="lsp-dot" aria-hidden="true" />
        <span class="hub-trust" tabindex="0" data-tip={trust().tip} aria-description={trust().tip}>{trust().label}</span>
        <Show when={!trust().restarting}>
          <button type="button" class="button hub-trust-action" classList={{ primary: trust().needsTrust }} data-action={trust().needsTrust ? "trust" : "stopTrusting"} onClick={() => props.onAction(trust().needsTrust ? "trust" : "stopTrusting", card()!.server)}>
            {trust().needsTrust ? copy.hubText.trust : copy.hubText.stopTrusting}
          </button>
        </Show>
      </div>
      <Show when={trust().needsTrust}><p class="hub-trust-why">{copy.hubText.trustShort}</p></Show>
    </div>}</Show>

    <section class="hub-list" aria-labelledby={listLabel}>
      <div class="hub-list-head">
        <span id={listLabel} class="hub-list-title">{copy.hubText.languages}</span>
        <Show when={showFilter()}>
          <div class="hub-segmented" role="radiogroup" aria-label={copy.hubText.filterLabel}>
            <For each={[["all", copy.hubText.filterAll], ["active", copy.hubText.filterActive]] as const}>{([value, label]) =>
              <button type="button" role="radio" aria-checked={filter() === value} tabindex={filter() === value ? 0 : -1} onClick={() => setFilter(value)}
                onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const next = filter() === "all" ? "active" : "all"; setFilter(next); (event.currentTarget.parentElement!.querySelector<HTMLElement>(`[aria-checked=true]`) ?? event.currentTarget).focus(); } }}>{label}</button>}</For>
          </div>
        </Show>
      </div>
      <Show when={searchUseful(props.view.rows)}>
        <input class="hub-search" type="search" placeholder={copy.hubText.search} aria-label={copy.hubText.search} value={query()} onInput={event => setQuery(event.currentTarget.value)} />
      </Show>
      <ul class="hub-rows" aria-labelledby={listLabel} onKeyDown={onListKey}>
        <For each={rows().map(row => row.server)} fallback={<li class="hub-empty">{copy.hubText.noMatches}</li>}>{id => <Row row={rowById(id)} onAction={props.onAction} onToggle={props.onToggleServer} />}</For>
      </ul>
    </section>

    <Show when={!props.embedded && props.onOpenSettings}>
      <div class="hub-foot"><button type="button" class="hub-settings-link" onClick={() => { props.onOpenSettings!(); props.onClose?.(false); }}>{copy.hubText.settingsLink}</button></div>
    </Show>
  </div>;
}

export default LanguageIntelligencePanel;
