import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "../Icon";
import { BrandIcon } from "../BrandIcon";
import { splitCode } from "../../lib/agent-hint-text";
import { AuthForm } from "./AuthForm";
import { ModelIcon, ambiguous, shownName } from "./ModelPopover";
import { COST_INFO, modelCost } from "../../lib/model-cost";
import { modelTraits } from "../../lib/model-traits";
import type { AuthMethod, AuthSecret, Brand } from "./types";

type SignInProps = Brand & {
  title: string;
  text?: string;
  /** Short UI copy for the backend's auth hint, for example the OpenCode terminal login. */
  hint?: string;
  methods: AuthMethod[];
  /** The agent reported something other than a sign-in request, shown above: no method is the primary action. */
  secondary?: boolean;
  busy?: boolean;
  onPick: (methodId: string) => void;
  /** Reconnects once the user has signed in elsewhere, for agents that sign in from a terminal. */
  onRetry?: () => void;
  /** Other models of the same agent, offered when the provider behind the current one refused the prompt. */
  models?: { value: string; name: string }[];
  onUseModel?: (value: string) => void;
  /** Called with a typed secret for methods that ask for an API key or a gateway. */
  onSubmit?: (methodId: string, secret: AuthSecret) => void;
};

/** Text with `code` spans for the parts the hint table put in backticks. */
export function HintLine(props: { text: string }) {
  return <For each={splitCode(props.text)}>{(part) => (part.code ? <code class="sb-mono">{part.text}</code> : <>{part.text}</>)}</For>;
}

/** The command a terminal sign-in asks for: the first `code` span of the hint, if any. */
export function terminalCommand(hint: string | undefined): string | undefined {
  return hint ? splitCode(hint).find((part) => part.code)?.text : undefined;
}

/**
 * A terminal sign-in the app cannot run for the user: the exact command in one slim chip with a copy button, and a
 * retry for afterwards. The retry is the primary action only when nothing else on the card is.
 */
function TerminalLogin(props: { command: string; onRetry?: () => void; primary?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch { /* the command stays selectable */ }
  };
  return (
    <div class="sb-terminal-login">
      <div class="sb-terminal-command">
        <code class="sb-mono">{props.command}</code>
        <button type="button" class="sb-icon-btn" aria-label={copied() ? "Copied" : "Copy command"} title={copied() ? "Copied" : "Copy command"} onClick={() => void copy()}>
          <Icon name={copied() ? "TickCircle" : "Copy"} size={12} />
        </button>
      </div>
      <div class="sb-actions">
        <Show when={props.onRetry}>
          <button type="button" class="sb-btn" classList={{ primary: props.primary }} onClick={() => props.onRetry?.()}>I have signed in, retry</button>
        </Show>
        <span class="sb-copied" role="status">{copied() ? "Copied" : ""}</span>
      </div>
    </div>
  );
}

type FallbackModel = { value: string; name: string };

/** The eyebrow over the model list: free models lead the list, so it says so when the first one is free. */
export const fallbackHeading = (models: readonly FallbackModel[]) => (models[0] && modelCost(models[0]) === "free" ? "Use a free model instead" : "Use another model");

/** The index a key moves to in a list of `count` rows, wrapping at both ends, or undefined for other keys. */
function stepFor(key: string, index: number, count: number): number | undefined {
  if (key === "ArrowDown" || key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/**
 * Another model for the same chat: pick one and the refused prompt is sent again with it. A radio group with one
 * tab stop, drawn with the model picker's rows: vendor mark with the agent badge, name without its provider prefix,
 * the provider only where two names would read the same, and the cost tier.
 */
function ModelFallback(props: Brand & { models: FallbackModel[]; onUse: (value: string) => void; busy?: boolean }) {
  let list: HTMLDivElement | undefined;
  const firstFree = props.models.find((model) => modelCost(model) === "free")?.value ?? "";
  const [picked, setPicked] = createSignal(firstFree);
  const chosen = () => (props.models.some((model) => model.value === picked()) ? picked() : "");
  const [active, setActive] = createSignal(Math.max(0, props.models.findIndex((model) => model.value === firstFree)));
  const tabStop = () => {
    const index = props.models.findIndex((model) => model.value === chosen());
    return index >= 0 ? index : Math.min(active(), props.models.length - 1);
  };
  const choose = (index: number) => {
    setActive(index);
    setPicked(props.models[index].value);
  };
  const onKey = (event: KeyboardEvent, index: number) => {
    const to = stepFor(event.key, index, props.models.length);
    if (to !== undefined) {
      event.preventDefault();
      choose(to);
      list?.querySelectorAll<HTMLElement>("[role='radio']")[to]?.focus();
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      choose(index);
    }
  };
  const heading = () => fallbackHeading(props.models);
  return (
    <div class="sb-model-fallback">
      <div class="sb-eyebrow">{heading()}</div>
      <div class="sb-fallback-list" role="radiogroup" aria-label={heading()} ref={list}>
        <For each={props.models}>
          {(model, index) => {
            const checked = () => model.value === chosen();
            return (
              <button
                type="button"
                class="sb-option sb-fallback-row"
                role="radio"
                aria-checked={checked()}
                tabIndex={index() === tabStop() ? 0 : -1}
                style={{ "--i": String(index()) }}
                onClick={() => choose(index())}
                onKeyDown={(event) => onKey(event, index())}
              >
                <ModelIcon id={props.id} name={props.name} agentName={props.name} model={model} traits={modelTraits(model)} />
                <span class="sb-option-line sb-flex">
                  <span class="sb-option-name sb-ellipsis" title={model.name}>{shownName(model)}</span>
                  <Show when={ambiguous(props.models, model)}><span class="sb-provider-tag">{model.value.split("/")[0]}</span></Show>
                </span>
                <Show when={modelCost(model)}>{(cost) => <span class="sb-cost-chip" data-cost={cost()} title={COST_INFO[cost()].label}>{COST_INFO[cost()].chip}</span>}</Show>
                <span class="sb-radio-mark" aria-hidden="true" />
              </button>
            );
          }}
        </For>
      </div>
      <div class="sb-actions">
        <button type="button" class="sb-btn primary" disabled={props.busy || !chosen()} onClick={() => props.onUse(chosen())}>Use and retry</button>
      </div>
    </div>
  );
}

/** Authentication methods the agent advertised. The first one is the primary action. */
export function SignIn(props: SignInProps) {
  const [asking, setAsking] = createSignal<string>();
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const hasModels = () => Boolean(props.models?.length && props.onUseModel);
  /** With a model list to lead, the terminal sign-in folds under a disclosure, and the hint line that repeats its command is not drawn. */
  const folded = () => hasModels() && Boolean(terminalCommand(props.hint));
  return (
    <section class="sb-signin" aria-labelledby="sb-signin-title">
      <BrandIcon id={props.id} name={props.name} size={26} />
      <header>
        <h2 id="sb-signin-title" class="sb-title">{props.title}</h2>
        <Show when={props.text}><p class="sb-lede">{props.text}</p></Show>
        <Show when={props.hint && !folded()}><p class="sb-lede sb-auth-hint" role="note"><HintLine text={props.hint!} /></p></Show>
      </header>
      <Show when={hasModels()}>
        <ModelFallback id={props.id} name={props.name} models={props.models!} onUse={props.onUseModel!} busy={props.busy} />
      </Show>
      <Show when={terminalCommand(props.hint)}>
        {(command) => (
          <Show when={folded()} fallback={<TerminalLogin command={command()} onRetry={props.onRetry} primary />}>
            <div class="sb-terminal-section">
              <button type="button" class="sb-disclosure" aria-expanded={terminalOpen()} aria-controls="sb-terminal-panel" onClick={() => setTerminalOpen(!terminalOpen())}>
                <span>Sign in with the terminal</span>
                <Icon name={terminalOpen() ? "arrow-up3" : "arrow-down4"} size={12} />
              </button>
              <Show when={terminalOpen()}>
                <div id="sb-terminal-panel" class="sb-terminal-panel">
                  <TerminalLogin command={command()} onRetry={props.onRetry} />
                </div>
              </Show>
            </div>
          </Show>
        )}
      </Show>
      <Show when={props.methods.length}>
        <div class="sb-methods">
          <For each={props.methods}>
            {(method, index) => (
              <>
                <button
                  class="sb-method"
                  classList={{ primary: !props.secondary && index() === 0 && !method.input }}
                  disabled={props.busy}
                  aria-expanded={method.input ? asking() === method.id : undefined}
                  onClick={() => (method.input ? setAsking(asking() === method.id ? undefined : method.id) : props.onPick(method.id))}
                >
                  <span class="sb-method-name">{method.name}</span>
                  <Show when={method.description}><span class="sb-method-desc">{method.description}</span></Show>
                </button>
                <Show when={method.input && asking() === method.id}>
                  <AuthForm
                    kind={method.input!}
                    methodName={method.name}
                    busy={props.busy}
                    onSubmit={(secret) => props.onSubmit?.(method.id, secret)}
                    onCancel={() => setAsking(undefined)}
                  />
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show when={!props.methods.some((method) => method.input)} fallback={<p class="sb-fine">A key or gateway you type here is passed to the agent once. Span does not store it.</p>}>
        <p class="sb-fine">Credentials stay with the agent. Span never sees them.</p>
      </Show>
    </section>
  );
}
