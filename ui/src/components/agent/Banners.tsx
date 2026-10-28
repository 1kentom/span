import { For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon";
import type { ActionView, Level } from "./types";
import { percent } from "./util";
import { warningParts } from "../../lib/agent-view";

function Actions(props: { actions: ActionView[] }) {
  return (
    <div class="sb-actions">
      <For each={props.actions}>
        {(action) => (
          <button class="sb-btn" classList={{ primary: action.primary }} onClick={action.onAct}>{action.label}</button>
        )}
      </For>
    </div>
  );
}

type ErrorCardProps = {
  level: Level;
  title: string;
  text?: string;
  code?: string;
  /** Recent transport or stderr lines. */
  log?: string[];
  /** Auto retry countdown. */
  countdown?: { remaining: number; total: number; label?: string };
  actions: ActionView[];
};

/** Error or warning card with optional log box and auto-retry countdown. */
export function ErrorCard(props: ErrorCardProps) {
  const fraction = () => (props.countdown && props.countdown.total > 0 ? Math.max(0, Math.min(1, props.countdown.remaining / props.countdown.total)) : 0);
  return (
    <section class={`sb-card alert ${props.level}`} role={props.level === "error" ? "alert" : "status"}>
      <div class="sb-alert-head">
        <Icon name={props.level === "error" ? "Danger" : "Warning2"} size={14} class={`sb-glyph ${props.level}`} />
        <span class="sb-alert-text">
          <span class="sb-card-title">{props.title}</span>
          <Show when={props.text}><span class="sb-body">{props.text}</span></Show>
        </span>
        <Show when={props.code}><span class="sb-mono dim">{props.code}</span></Show>
      </div>
      <Show when={props.log?.length}>
        <div class="sb-logbox" tabIndex={0} role="log" aria-label="Error log">
          <For each={props.log}>{(line) => <div>{line}</div>}</For>
        </div>
      </Show>
      <Show when={props.countdown}>
        <div class="sb-countdown">
          <span class="sb-bar" role="progressbar" aria-label="Time until retry" aria-valuemin={0} aria-valuemax={props.countdown!.total} aria-valuenow={props.countdown!.remaining}>
            <span class="sb-bar-fill drain" style={{ transform: `scaleX(${fraction()})` }} />
          </span>
          <span class="nowrap">{props.countdown!.label ?? `Retrying in ${props.countdown!.remaining}s`}</span>
        </div>
      </Show>
      <Actions actions={props.actions} />
    </section>
  );
}

/** Thin bar shown while the network is down. */
export function OfflineBar(props: { text?: string; onRetry: () => void }) {
  return (
    <div class="sb-offline" role="status">
      <span class="sb-pulse" aria-hidden="true" />
      <span class="nowrap strong">You're offline</span>
      <span class="sb-ellipsis dim sb-flex">{props.text}</span>
      <button class="sb-btn ghost" onClick={props.onRetry}>Retry now</button>
    </div>
  );
}

type StopCardProps = {
  title: string;
  /** Raw ACP stop reason, for example max_tokens. */
  code?: string;
  text?: string;
  onContinue: () => void;
  secondary?: { label: string; onAct: () => void };
};

/** Why the agent stopped (token limit, refusal, turn cap) with a Continue action. */
export function StopCard(props: StopCardProps) {
  return (
    <section class="sb-card alert warn" role="status">
      <div class="sb-alert-head">
        <Icon name="Warning2" size={14} class="sb-glyph warn" />
        <span class="sb-card-title sb-flex">{props.title}</span>
        <Show when={props.code}><span class="sb-mono dim">{props.code}</span></Show>
      </div>
      <Show when={props.text}><div class="sb-body pad">{props.text}</div></Show>
      <Actions actions={[{ label: "Continue", primary: true, onAct: props.onContinue }, ...(props.secondary ? [{ label: props.secondary.label, onAct: props.secondary.onAct }] : [])]} />
    </section>
  );
}

/** A centred divider line with a label, for events such as "Session resumed". */
export function Notice(props: { text: string }) {
  return (
    <div class="sb-notice" role="separator" aria-label={props.text}>
      <span class="sb-rule" />
      <span class="nowrap">{props.text}</span>
      <span class="sb-rule" />
    </div>
  );
}

/** Backtick spans in a notice read as inline code. */
function withCode(text: string) {
  return text.split(/(`[^`]+`)/).map((part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code>{part.slice(1, -1)}</code> : part));
}

/** A warning from the agent in the feed: one quiet line, with the rest behind a chevron instead of a wall of text. */
export function WarningNote(props: { title: string; description?: string }) {
  const [open, setOpen] = createSignal(false);
  const parts = () => warningParts(props.title, props.description);
  return (
    <div class="sb-warning-note" role="status">
      <Icon name="Warning2" size={12} class="sb-glyph warn" />
      <div class="sb-warning-body">
        <p class="sb-warning-line">{withCode(parts().summary)}</p>
        <Show when={parts().detail}>
          {(detail) => (
            <>
              <Show when={open()}>
                <p class="sb-warning-detail">{withCode(detail())}</p>
              </Show>
              <button type="button" class="sb-warning-more" aria-expanded={open()} onClick={() => setOpen(!open())}>
                {open() ? "Less" : "Details"}
                <Icon name={open() ? "arrow-up3" : "arrow-down4"} size={9} />
              </button>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

type ContextBannerProps = {
  used: number;
  size: number;
  /** True only when the agent advertised a compact command. */
  canCompact?: boolean;
  onCompact?: () => void;
  onDismiss?: () => void;
};

/** Warns that the context window is nearly full. Compact appears only when the agent can compact. */
export function ContextBanner(props: ContextBannerProps) {
  const pct = () => percent(props.used, props.size);
  return (
    <section class="sb-banner" role="status" aria-label="Context nearly full">
      <div class="sb-banner-head">
        <Icon name="Warning2" size={13} class="sb-glyph warn" />
        <span>Context {pct()}% full</span>
        <span class="sb-flex" />
        <span class="sb-mono dim">{props.used.toLocaleString()} / {props.size.toLocaleString()}</span>
      </div>
      <div class="sb-meter" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
        <div class="sb-meter-fill" style={{ width: `${pct()}%` }} />
      </div>
      <Show when={(props.canCompact && props.onCompact) || props.onDismiss}>
        <div class="sb-actions">
          <Show when={props.canCompact && props.onCompact}>
            <button class="sb-btn primary" onClick={() => props.onCompact?.()}>Compact now</button>
          </Show>
          <Show when={props.onDismiss}>
            <button class="sb-btn" onClick={() => props.onDismiss?.()}>Dismiss</button>
          </Show>
        </div>
      </Show>
    </section>
  );
}

/**
 * Said once beside an agent's edits when it writes files itself and ignores Span's file system. There is no
 * approve or reject here on purpose: the files are already on disk, so a button would be a lie.
 */
export function EditsBypassNote(props: { agent: string }) {
  return (
    <p class="sb-fine sb-bypass-note" role="note">
      <Icon name="InfoCircle" size={11} />
      <span>{props.agent} writes files directly; Span can't review edits before they land</span>
    </p>
  );
}
