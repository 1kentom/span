import { For, Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { limitSentence, limitTitle, waitText, type AgentErrorInfo } from "../../lib/agent-errors";
import { shortAgentName, shortModelName, type AgentAlternative } from "../../lib/agent-alternatives";
import "../../styles/agent-limit.css";

export type LimitCardProps = {
  info: AgentErrorInfo;
  /** The raw error text, kept under Details. */
  raw: string;
  /** The refused turn can be sent again from this card. */
  canResend: boolean;
  /** Up to two agents to continue with, best first (agent-alternatives.ts). */
  alternatives: AgentAlternative[];
  /** Other free models still listed, for a free-tier limit. */
  freeModels: { value: string; name: string }[];
  /** The agent has a model picker. */
  hasModels: boolean;
  onTryModel: () => void;
  onUseModel: (value: string) => void;
  onSwitchAgent: (id: string) => void;
  onMoreAgents: () => void;
  onRetry: () => void;
  onOpenLink: (url: string) => void;
  onShowLog?: () => void;
  onDismiss: () => void;
  /** Test clock. */
  now?: () => number;
};

type MenuName = "models" | "more";

/** Room a menu needs above its trigger before it opens downward instead. */
const MENU_ROOM = 220;

/**
 * The card for a usage limit, rate limit or overloaded provider: one line saying what happened, one short sentence,
 * then a single row of at most three controls. The lead action is Retry when a wait applies, else the best ranked
 * other agent. "Try another model" opens the free models still listed. Everything else (other agents, the provider's
 * plan page, the ACP log, Details, Dismiss) sits in the overflow menu. Nothing here retries on its own.
 */
export function LimitCard(props: LimitCardProps) {
  const clock = () => props.now?.() ?? Date.now();
  const [now, setNow] = createSignal(clock());
  const timer = setInterval(() => setNow(clock()), 1000);
  onCleanup(() => clearInterval(timer));
  const [details, setDetails] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuName>();
  const [below, setBelow] = createSignal(false);
  const titleId = createUniqueId();
  let host!: HTMLElement;
  let actions!: HTMLDivElement;
  /** The row is too narrow for lead, secondary and overflow: the secondary moves into the overflow menu. */
  const [narrow, setNarrow] = createSignal(false);
  /** Width the full row needed when it last overflowed, so it comes back once there is room again. */
  let needed = 0;
  const fit = () => {
    if (!narrow()) {
      if (actions.scrollWidth > actions.clientWidth + 1 && lead()) {
        needed = actions.scrollWidth;
        setNarrow(true);
      }
    } else if (actions.clientWidth >= needed || !lead()) setNarrow(false);
  };
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(actions);
    onCleanup(() => observer.disconnect());
  });

  const waiting = () => (props.info.resetAt !== undefined && props.info.resetAt > now() ? props.info.resetAt - now() : 0);
  const canRetry = () => props.canResend && (props.info.kind === "rate_limit" || props.info.kind === "overloaded");
  /** The Retry button carries the countdown, so the title does not repeat it. */
  const title = () => limitTitle(canRetry() ? { ...props.info, resetAt: undefined } : props.info, now());
  const lead = (): AgentAlternative | true | undefined => (canRetry() ? true : props.alternatives.find((agent) => !agent.note));
  const leadAgent = () => (canRetry() ? undefined : props.alternatives.find((agent) => !agent.note));
  const menuAgents = () => props.alternatives.filter((agent) => agent !== leadAgent());
  const models = () => (props.canResend ? props.freeModels : []);

  const menuItems = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[role=menuitem]")];
  const closeMenu = (focusTrigger = false) => {
    const open = menu();
    setMenu(undefined);
    if (focusTrigger && open) host.querySelector<HTMLElement>(`[data-menu-trigger="${open}"]`)?.focus();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!host.querySelector("[data-menu-wrap].open")?.contains(event.target as Node)) closeMenu();
  };
  document.addEventListener("pointerdown", onPointerDown);
  onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));

  const openMenu = (name: MenuName, trigger: HTMLElement) => {
    if (menu() === name) return closeMenu();
    // Opens upward over the feed, unless the scroll area has no room above the card.
    let scroller: HTMLElement | null = trigger.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const top = scroller ? scroller.getBoundingClientRect().top : 0;
    setBelow(trigger.getBoundingClientRect().top - top < MENU_ROOM);
    setMenu(name);
    queueMicrotask(() => {
      const root = host.querySelector(`[data-menu="${name}"]`);
      if (root) menuItems(root)[0]?.focus();
    });
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const items = menuItems(event.currentTarget as HTMLElement);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };
  /** Runs a menu choice and closes the menu. */
  const choose = (act: () => void) => () => {
    closeMenu();
    act();
  };

  const Item = (item: { label: string; onAct: () => void; class?: string; title?: string; expanded?: boolean; lead?: JSX.Element; trail?: JSX.Element }) => (
    <button type="button" role="menuitem" class={`sb-menu-item sb-limit-item ${item.class ?? ""}`} title={item.title} aria-expanded={item.expanded} tabIndex={-1} onClick={choose(item.onAct)}>
      {item.lead}
      <span class="sb-menu-label">{item.label}</span>
      {item.trail}
    </button>
  );

  return (
    <section ref={host} class="sb-card sb-limit" role="alert" aria-labelledby={titleId} data-kind={props.info.kind} data-narrow={narrow() ? "" : undefined}>
      <div class="sb-limit-head">
        <Icon name={props.info.kind === "rate_limit" ? "Clock" : "Warning2"} size={14} class="sb-glyph warn" />
        <div class="sb-limit-text">
          <span class="sb-limit-title" id={titleId} title={title()}>{title()}</span>
          <span class="sb-limit-body">{limitSentence(props.info, now())}</span>
        </div>
      </div>
      <div class="sb-limit-actions" ref={actions}>
        <Show when={canRetry()}>
          <button type="button" class="sb-btn sb-limit-lead" disabled={waiting() > 0} aria-label={waiting() > 0 ? `Retry available in ${waitText(waiting())}` : "Retry"} onClick={() => props.onRetry()}>
            <Icon name="Refresh2" size={12} />
            <span class="sb-limit-label">{waiting() > 0 ? `Retry in ${waitText(waiting())}` : "Retry"}</span>
          </button>
        </Show>
        <Show when={leadAgent()}>
          {(agent) => (
            <button type="button" class="sb-btn sb-limit-lead" onClick={() => props.onSwitchAgent(agent().id)}>
              <BrandIcon id={agent().id} name={agent().name} size={13} />
              <span class="sb-limit-label">Continue with {shortAgentName(agent().name)}</span>
            </button>
          )}
        </Show>
        <Show when={props.hasModels && !narrow()}>
          <div class="sb-limit-menu-wrap sb-limit-secondary" classList={{ open: menu() === "models" }} data-menu-wrap>
            <button
              type="button"
              class="sb-btn sb-limit-quiet"
              data-menu-trigger="models"
              aria-haspopup={models().length ? "menu" : "dialog"}
              aria-expanded={models().length ? menu() === "models" : undefined}
              onClick={(event) => (models().length ? openMenu("models", event.currentTarget) : props.onTryModel())}
            >
              <span class="sb-limit-label">Try another model</span>
            </button>
            <Show when={menu() === "models"}>
              <div class="sb-limit-menu" classList={{ below: below() }} role="menu" aria-label="Free models" data-menu="models" onKeyDown={onMenuKey}>
                <For each={models()}>
                  {(model) => (
                    <Item label={shortModelName(model.name)} title={model.value} onAct={() => props.onUseModel(model.value)} trail={<span class="sb-limit-cost">Free</span>} />
                  )}
                </For>
                <div class="sb-menu-sep" role="separator" />
                <Item label="All models" onAct={() => props.onTryModel()} trail={<Icon name="arrow-right4" size={9} class="sb-limit-trail" />} />
              </div>
            </Show>
          </div>
        </Show>
        <span class="sb-flex" />
        <div class="sb-limit-menu-wrap" classList={{ open: menu() === "more" }} data-menu-wrap>
          <button
            type="button"
            class="sb-icon-btn sb-limit-more"
            data-menu-trigger="more"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menu() === "more"}
            onClick={(event) => openMenu("more", event.currentTarget)}
          >
            <Icon name="3DotsMore" size={14} />
          </button>
          <Show when={menu() === "more"}>
            <div class="sb-limit-menu end" classList={{ below: below() }} role="menu" aria-label="More actions" data-menu="more" onKeyDown={onMenuKey}>
              <Show when={props.hasModels && narrow()}>
                <Item label="Try another model" onAct={() => props.onTryModel()} />
              </Show>
              <For each={menuAgents()}>
                {(agent) => (
                  <Item label={`Continue with ${shortAgentName(agent.name)}`} title={agent.note ? `${shortAgentName(agent.name)}: ${agent.note}` : undefined} onAct={() => props.onSwitchAgent(agent.id)}
                    lead={<BrandIcon id={agent.id} name={agent.name} size={12} />}
                    trail={agent.note ? <span class="sb-limit-note">{agent.note}</span> : undefined}
                  />
                )}
              </For>
              <Item label={props.alternatives.length ? "More agents" : "Switch agent"} onAct={() => props.onMoreAgents()} />
              <Show when={props.info.link}>
                {(link) => (
                  <Item label={link().label} title={link().url} onAct={() => props.onOpenLink(link().url)} trail={<Icon name="ExportSquare" size={11} class="sb-limit-trail" />} />
                )}
              </Show>
              <div class="sb-menu-sep" role="separator" />
              <Show when={props.onShowLog}>
                <Item label="Show ACP log" onAct={() => props.onShowLog?.()} />
              </Show>
              <Item label={details() ? "Hide details" : "Details"} expanded={details()} onAct={() => setDetails(!details())} />
              <Item label="Dismiss" onAct={() => props.onDismiss()} />
            </div>
          </Show>
        </div>
      </div>
      <Show when={details()}>
        <p class="sb-limit-raw sb-mono">{props.raw}</p>
      </Show>
    </section>
  );
}
