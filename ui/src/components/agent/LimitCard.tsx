import { For, Show, createSignal, createUniqueId, onCleanup } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { limitSentence, limitTitle, waitText, type AgentErrorInfo } from "../../lib/agent-errors";
import type { AgentAlternative } from "../../lib/agent-alternatives";
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

/**
 * The card for a usage limit, rate limit or overloaded provider: what happened in one line, then the ways to keep
 * going (another agent, another model, retry when the wait is over, the provider's plan page). The raw error stays
 * under Details. Nothing here retries on its own.
 */
export function LimitCard(props: LimitCardProps) {
  const clock = () => props.now?.() ?? Date.now();
  const [now, setNow] = createSignal(clock());
  const timer = setInterval(() => setNow(clock()), 1000);
  onCleanup(() => clearInterval(timer));
  const [open, setOpen] = createSignal(false);
  const titleId = createUniqueId();
  const waiting = () => (props.info.resetAt !== undefined && props.info.resetAt > now() ? props.info.resetAt - now() : 0);
  const canRetry = () => props.canResend && (props.info.kind === "rate_limit" || props.info.kind === "overloaded");
  const freeLine = () => {
    const names = props.freeModels.map((model) => model.name);
    if (!props.info.freeTier || !names.length) return undefined;
    return `Free models still listed: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}.`;
  };
  return (
    <section class="sb-card alert warn sb-limit" role="alert" aria-labelledby={titleId} data-kind={props.info.kind}>
      <div class="sb-alert-head">
        <Icon name={props.info.kind === "rate_limit" ? "Clock" : "Warning2"} size={14} class="sb-glyph warn" />
        <span class="sb-alert-text">
          <span class="sb-card-title" id={titleId}>{limitTitle(props.info, now())}</span>
          <span class="sb-body">{limitSentence(props.info, now())}</span>
          <Show when={freeLine()}><span class="sb-body sb-limit-free">{freeLine()}</span></Show>
        </span>
      </div>
      <div class="sb-actions sb-limit-actions">
        <For each={props.alternatives}>
          {(agent, index) => (
            <button
              type="button"
              class="sb-btn sb-limit-agent"
              classList={{ primary: index() === 0 && !agent.note }}
              title={agent.note ? `${agent.name}: ${agent.note}` : undefined}
              onClick={() => props.onSwitchAgent(agent.id)}
            >
              <BrandIcon id={agent.id} name={agent.name} size={13} />
              <span>Continue with {agent.name}</span>
              <Show when={agent.note}><span class="sb-limit-note">{agent.note}</span></Show>
            </button>
          )}
        </For>
        <For each={props.canResend ? props.freeModels.slice(0, 2) : []}>
          {(model) => (
            <button type="button" class="sb-btn" onClick={() => props.onUseModel(model.value)}>Use {model.name}</button>
          )}
        </For>
        <Show when={props.hasModels}>
          <button type="button" class="sb-btn" aria-haspopup="dialog" onClick={() => props.onTryModel()}>Try another model</button>
        </Show>
        <button type="button" class="sb-btn" aria-haspopup="dialog" onClick={() => props.onMoreAgents()}>{props.alternatives.length ? "More agents" : "Switch agent"}</button>
        <Show when={canRetry()}>
          <button type="button" class="sb-btn" disabled={waiting() > 0} aria-label={waiting() > 0 ? `Retry available in ${waitText(waiting())}` : "Retry"} onClick={() => props.onRetry()}>
            <Icon name="Refresh2" size={12} />
            {waiting() > 0 ? `Retry in ${waitText(waiting())}` : "Retry"}
          </button>
        </Show>
        <Show when={props.info.link}>
          {(link) => (
            <button type="button" class="sb-btn" title={link().url} onClick={() => props.onOpenLink(link().url)}>
              <span>{link().label}</span>
              <Show when={!link().label.endsWith(link().host)}><span class="sb-limit-host">{link().host}</span></Show>
              <Icon name="ExportSquare" size={11} />
            </button>
          )}
        </Show>
      </div>
      <div class="sb-limit-quiet">
        <button type="button" class="sb-btn ghost" aria-expanded={open()} onClick={() => setOpen(!open())}>
          Details
          <Icon name={open() ? "arrow-up3" : "arrow-down4"} size={9} />
        </button>
        <span class="sb-flex" />
        <Show when={props.onShowLog}><button type="button" class="sb-btn ghost" onClick={() => props.onShowLog?.()}>Show ACP log</button></Show>
        <button type="button" class="sb-btn ghost" onClick={() => props.onDismiss()}>Dismiss</button>
      </div>
      <Show when={open()}>
        <p class="sb-limit-raw sb-mono">{props.raw}</p>
      </Show>
    </section>
  );
}
