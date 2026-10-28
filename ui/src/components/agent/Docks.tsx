import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { DiffView } from "./WorkGroup";
import { KeyGlyph } from "./KeyGlyph";
import type { Brand, PermissionChoice, PermissionDetails, QuestionAnswer, QuestionOption } from "./types";
import { dockKey } from "./util";
import { DOCK_TAB_HINT } from "../../lib/agent-dock-focus";
import { permissionScope, sortPermissionOptions } from "../../lib/agent-feed";

/**
 * Registers a key handler for one dock while `active` is true. It only sees keys pressed with focus inside the dock
 * (see `dockKey`), never keys typed elsewhere. Capture phase, so the dock answers before the panel's Escape handler,
 * which then sees the event as handled.
 */
function useDockKeys(dock: () => HTMLElement | undefined, active: () => boolean, handler: (event: KeyboardEvent) => void) {
  createEffect(() => {
    if (!active()) return;
    const listener = (event: KeyboardEvent) => {
      if (dockKey(event, dock())) handler(event);
    };
    window.addEventListener("keydown", listener, true);
    onCleanup(() => window.removeEventListener("keydown", listener, true));
  });
}

const PRIMARY = [".sb-btn.primary:not(:disabled)", ".sb-q-option:not(:disabled)", ".sb-input:not(:disabled)", ".sb-btn:not(:disabled)"];

/** Moves focus to the dock's primary control: the primary button, else the first option, field or button. Never activates it. */
export function focusDock(dock: HTMLElement | undefined) {
  if (!dock) return;
  const target = PRIMARY.map((selector) => dock.querySelector<HTMLElement>(selector)).find(Boolean);
  (target ?? dock).focus();
}

/**
 * Tracks whether focus is inside the dock and, when `autoFocus` is true at the moment the dock appears, moves focus to
 * its primary control. The caller decides `autoFocus` (never while the user is typing); it never answers anything.
 */
function useDockFocus(dock: () => HTMLElement | undefined, props: { autoFocus?: boolean; onFocusChange?: (focused: boolean) => void }) {
  const [focused, setFocused] = createSignal(false);
  const set = (value: boolean) => {
    if (value === focused()) return;
    setFocused(value);
    props.onFocusChange?.(value);
  };
  onMount(() => {
    const element = dock();
    if (!props.autoFocus || !element) return;
    queueMicrotask(() => {
      if (element.isConnected) focusDock(element);
    });
  });
  onCleanup(() => props.onFocusChange?.(false));
  return {
    focused,
    focusin: () => set(true),
    focusout: (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !dock()?.contains(event.relatedTarget)) set(false);
    },
  };
}

type DockFocusProps = {
  /** Take focus when the dock appears. Read once, on mount. */
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
};

const TabHint = (props: { show: boolean }) => (
  <Show when={props.show}><div class="sb-dock-tabhint">{DOCK_TAB_HINT}</div></Show>
);

type QuestionDockProps = DockFocusProps & {
  asker?: Brand & { label?: string };
  /** For example "2 of 3". */
  step?: string;
  prompt: string;
  options: QuestionOption[];
  allowText?: boolean;
  /** Only the oldest open request answers number keys. */
  active?: boolean;
  onAnswer: (answer: QuestionAnswer) => void;
  onCancel?: () => void;
};

/** Form-mode elicitation: numbered options and optional free text. */
export function QuestionDock(props: QuestionDockProps) {
  const [text, setText] = createSignal("");
  let dock: HTMLElement | undefined;
  const focus = useDockFocus(() => dock, props);
  useDockKeys(
    () => dock,
    () => props.active !== false,
    (event) => {
      const option = /^[1-9]$/.test(event.key) ? props.options[Number(event.key) - 1] : undefined;
      if (option) {
        event.preventDefault();
        props.onAnswer({ optionId: option.id });
      } else if (event.key === "Escape" && props.onCancel) {
        event.preventDefault();
        props.onCancel();
      }
    },
  );
  const submit = (event: Event) => {
    event.preventDefault();
    const value = text().trim();
    if (value) props.onAnswer({ text: value });
  };
  return (
    <section ref={dock} class="sb-dock" role="group" aria-label="Question from the agent" tabIndex={-1} on:focusin={focus.focusin} on:focusout={focus.focusout}>
      <div class="sb-dock-meta">
        <BrandIcon id={props.asker?.id} name={props.asker?.name} size={13} />
        <span>{props.asker?.label ?? props.asker?.name ?? "Agent"} is asking</span>
        <span class="sb-flex" />
        <Show when={props.step}><span class="sb-mono dim">{props.step}</span></Show>
      </div>
      <div class="sb-dock-prompt">{props.prompt}</div>
      <TabHint show={!focus.focused()} />
      <For each={props.options}>
        {(option, index) => (
          <button class="sb-q-option" onClick={() => props.onAnswer({ optionId: option.id })}>
            <span class="sb-num" aria-hidden="true">{index() + 1}</span>
            <span class="sb-option-text">
              <span class="sb-option-name">{option.label}</span>
              <Show when={option.description}><span class="sb-sub wrap">{option.description}</span></Show>
            </span>
          </button>
        )}
      </For>
      <Show when={props.allowText}>
        <form class="sb-q-text" onSubmit={submit}>
          <input class="sb-input" aria-label="Your own answer" placeholder="Type your own answer" value={text()} onInput={(event) => setText(event.currentTarget.value)} />
          <button class="sb-btn primary" type="submit" disabled={!text().trim()}>Send</button>
        </form>
      </Show>
      <Show when={props.onCancel}>
        <button class="sb-btn ghost" onClick={() => props.onCancel?.()}>Skip question</button>
      </Show>
    </section>
  );
}

type PermissionDockProps = DockFocusProps & {
  title: string;
  /** Names the delegated agent the request comes from, when it is not the lead. */
  from?: string;
  brand?: Brand;
  /** The command or target the tool call will touch. `details.command` wins when both are given. */
  command?: string;
  reason?: string;
  /** What is being approved: diffs, locations, tool kind and input. */
  details?: PermissionDetails;
  options: PermissionChoice[];
  active?: boolean;
  busy?: boolean;
  onChoose: (optionId: string) => void;
};

const DOUBLE_APPROVAL = "This agent asks for permission here, then sends the write itself, so you may be asked a second time for the same edit.";

/**
 * Permission request using the ACP option kinds. Y picks the first allow option, A the standing allow, N the first
 * reject. Keys count only while focus is inside the dock.
 * `reject_always` is never drawn: the backend only forwards offered kinds and Span does not offer a standing reject.
 * An internal request (agent bookkeeping) starts collapsed to one row; the buttons stay so it can still be answered.
 */
export function PermissionDock(props: PermissionDockProps) {
  const sorted = () => sortPermissionOptions(props.options.filter((option) => option.kind !== "reject_always"));
  const allow = () => sorted().find((option) => option.kind.startsWith("allow"));
  const reject = () => sorted().find((option) => option.kind.startsWith("reject"));
  const always = () => sorted().find((option) => option.kind === "allow_always");
  const keyFor = (option: PermissionChoice) => (option === allow() ? "Y" : option === reject() ? "N" : option === always() ? "A" : "");
  const internal = () => Boolean(props.details?.internal);
  const [open, setOpen] = createSignal(!props.details?.internal);
  const command = () => props.details?.command ?? props.command;
  const hasDetails = () => Boolean(command() || props.details?.locations.length || props.details?.diffs.length || props.details?.input || props.reason);
  let dock: HTMLElement | undefined;
  const focus = useDockFocus(() => dock, props);
  useDockKeys(
    () => dock,
    () => props.active !== false && !props.busy,
    (event) => {
      const key = event.key.toLowerCase();
      const option = key === "y" ? allow() : key === "n" ? reject() : key === "a" ? always() : undefined;
      if (option) {
        event.preventDefault();
        props.onChoose(option.optionId);
      }
    },
  );
  return (
    <section ref={dock} tabIndex={-1} on:focusin={focus.focusin} on:focusout={focus.focusout} class="sb-dock" classList={{ internal: internal() }} role="group" aria-label={`${props.from ? `${props.from} asks permission` : "Permission requested"}: ${props.title}`}>
      <div class="sb-dock-head">
        <span class="sb-dot warn" aria-hidden="true" />
        <span class="sb-dock-title" classList={{ muted: internal() }}>{props.title}</span>
        <Show when={props.details?.kind}><span class="sb-kind sb-mono">{props.details?.kind}</span></Show>
        <span class="sb-flex" />
        <Show when={internal() && hasDetails()}>
          <button class="sb-icon-btn" aria-expanded={open()} aria-label={open() ? "Hide details" : "Show details"} onClick={() => setOpen(!open())}>
            <Icon name={open() ? "arrow-down4" : "arrow-right4"} size={10} />
          </button>
        </Show>
        <Show when={props.brand}><BrandIcon id={props.brand?.id} name={props.brand?.name} size={13} /></Show>
      </div>
      <Show when={props.from}><div class="sb-dock-from">{props.from} (delegated agent) asks to run this</div></Show>
      <Show when={internal()}><div class="sb-sub">Agent housekeeping, not a change to your files</div></Show>
      <Show when={open()}>
        <div class="sb-dock-details">
          <Show when={command()}>
            <div class="sb-code sb-dock-command"><span class="sb-prompt">$ </span>{command()}</div>
          </Show>
          <Show when={props.details?.locations.length}>
            <ul class="sb-dock-locs" aria-label="Files this touches">
              <For each={props.details!.locations}>
                {(location) => (
                  <li class="sb-mono">
                    <Show when={location.onOpen} fallback={<span class="dim sb-ellipsis" title={location.label}>{location.label}{location.line ? `:${location.line}` : ""}</span>}>
                      <button type="button" class="sb-link sb-ellipsis" title={`Open ${location.label}`} onClick={() => location.onOpen?.()}>{location.label}{location.line ? `:${location.line}` : ""}</button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <For each={props.details?.diffs}>
            {(diff) => <div class="sb-dock-diff"><DiffView path={diff.path} lines={diff.lines} onOpen={diff.onOpen} /></div>}
          </For>
          <Show when={props.details?.moreDiffs}><div class="sb-sub">+{props.details!.moreDiffs} more changed files not shown</div></Show>
          <Show when={props.details?.input}>
            <details class="sb-dock-input">
              <summary>Input</summary>
              <pre class="sb-mono">{props.details!.input}</pre>
            </details>
          </Show>
          <Show when={props.reason}><div class="sb-body">{props.reason}</div></Show>
        </div>
      </Show>
      <Show when={props.details?.doubleApproval}>
        <div class="sb-sub sb-double" title={DOUBLE_APPROVAL}>
          <Icon name="InfoCircle" size={11} />
          <span>May ask again for the write</span>
        </div>
      </Show>
      <TabHint show={!focus.focused()} />
      <div class="sb-actions">
        <For each={sorted()}>
          {(option) => (
            <button
              class="sb-btn"
              classList={{ primary: option.kind === "allow_once", danger: option.kind.startsWith("reject") }}
              disabled={props.busy}
              title={permissionScope(option.kind) ? `${option.name} (${permissionScope(option.kind)})` : option.name}
              onClick={() => props.onChoose(option.optionId)}
            >
              {option.name}
              <Show when={keyFor(option)}><kbd class="sb-hotkey" aria-hidden="true">{keyFor(option)}</kbd></Show>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

type UrlDockProps = DockFocusProps & {
  title: string;
  text?: string;
  brand?: Brand;
  href: string;
  /** A one-time code the user enters on the page, when the agent supplies one. */
  code?: string;
  active?: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onCopyCode?: (code: string) => void;
};

/** Url-mode elicitation: send the user to the browser, never open it without a click or Enter. */
export function UrlDock(props: UrlDockProps) {
  let dock: HTMLElement | undefined;
  const focus = useDockFocus(() => dock, props);
  useDockKeys(
    () => dock,
    () => props.active !== false,
    (event) => {
      const target = event.target;
      if (event.key === "Enter" && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        props.onOpen();
      } else if (event.key === "Escape") {
        event.preventDefault();
        props.onCancel();
      }
    },
  );
  return (
    <section ref={dock} tabIndex={-1} class="sb-dock" role="group" aria-label={props.title} on:focusin={focus.focusin} on:focusout={focus.focusout}>
      <div class="sb-dock-head">
        <Icon name="Link2" size={13} class="sb-accent" />
        <span class="sb-dock-title">{props.title}</span>
        <span class="sb-flex" />
        <Show when={props.brand}><BrandIcon id={props.brand?.id} name={props.brand?.name} size={13} /></Show>
      </div>
      <Show when={props.text}><div class="sb-body">{props.text}</div></Show>
      <div class="sb-urlbox">
        <span class="sb-option-text">
          <span class="sb-mono accent sb-ellipsis" title={props.href}>{props.href}</span>
          <Show when={props.code}><span class="sb-sub">Enter this code</span></Show>
        </span>
        <Show when={props.code}>
          <span class="sb-code-value" aria-label="One-time code">{props.code}</span>
          <Show when={props.onCopyCode}>
            <button class="sb-icon-btn" aria-label="Copy code" onClick={() => props.onCopyCode?.(props.code!)}><Icon name="Copy" size={12} /></button>
          </Show>
        </Show>
      </div>
      <TabHint show={!focus.focused()} />
      <div class="sb-actions">
        <button class="sb-btn primary" onClick={props.onOpen}>Open browser<kbd class="sb-hotkey" aria-hidden="true"><KeyGlyph value="\u21b5" size={11} /></kbd></button>
        <button class="sb-btn" onClick={props.onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/**
 * One line above the composer while the agent works: a shimmering label, the elapsed time and a hint.
 * Deliberately not a live region: the timer changes every second. The composer announces start and stop once.
 */
export function ActivityBar(props: { label: string; elapsed?: string; hint?: string }) {
  return (
    <div class="sb-activity">
      <span class="sb-spinner" aria-hidden="true" />
      <span class="sb-shimmer sb-ellipsis sb-flex">
        {props.label}
        <Show when={props.elapsed}> · {props.elapsed}</Show>
      </span>
      <Show when={props.hint}><span class="sb-sub nowrap">{props.hint}</span></Show>
    </div>
  );
}
