import { For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon";
import { BrandIcon } from "../BrandIcon";
import { splitCode } from "../../lib/agent-hint-text";
import { AuthForm } from "./AuthForm";
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

/** A terminal sign-in the app cannot run for the user: the exact command, a copy button, and a retry for afterwards. */
function TerminalLogin(props: { command: string; onRetry?: () => void }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the command stays selectable */ }
  };
  return (
    <div class="sb-terminal-login">
      <div class="sb-terminal-command">
        <code class="sb-mono">{props.command}</code>
        <button type="button" class="sb-icon-btn" aria-label={copied() ? "Copied" : "Copy command"} title={copied() ? "Copied" : "Copy command"} onClick={() => void copy()}>
          <Icon name="Copy" size={12} />
        </button>
      </div>
      <Show when={props.onRetry}>
        <button type="button" class="sb-btn primary" onClick={() => props.onRetry?.()}>I have signed in, retry</button>
      </Show>
    </div>
  );
}

/** Another model for the same chat: pick one and the refused prompt is sent again with it. */
function ModelFallback(props: { models: { value: string; name: string }[]; onUse: (value: string) => void; busy?: boolean }) {
  const [picked, setPicked] = createSignal(props.models[0]?.value ?? "");
  return (
    <div class="sb-model-fallback">
      <label class="sb-fine" for="sb-fallback-model">Use another model</label>
      <div class="sb-model-fallback-row">
        <select id="sb-fallback-model" class="sb-select" value={picked()} onChange={(event) => setPicked(event.currentTarget.value)}>
          <For each={props.models}>{(model) => <option value={model.value}>{model.name}</option>}</For>
        </select>
        <button type="button" class="sb-btn primary" disabled={props.busy || !picked()} onClick={() => props.onUse(picked())}>Use and retry</button>
      </div>
    </div>
  );
}

/** Authentication methods the agent advertised. The first one is the primary action. */
export function SignIn(props: SignInProps) {
  const [asking, setAsking] = createSignal<string>();
  return (
    <section class="sb-signin" aria-labelledby="sb-signin-title">
      <BrandIcon id={props.id} name={props.name} size={26} />
      <header>
        <h2 id="sb-signin-title" class="sb-title">{props.title}</h2>
        <Show when={props.text}><p class="sb-lede">{props.text}</p></Show>
        <Show when={props.hint}><p class="sb-lede sb-auth-hint" role="note"><HintLine text={props.hint!} /></p></Show>
      </header>
      <Show when={props.models?.length && props.onUseModel}>
        <ModelFallback models={props.models!} onUse={props.onUseModel!} busy={props.busy} />
      </Show>
      <Show when={terminalCommand(props.hint)}>{(command) => <TerminalLogin command={command()} onRetry={props.onRetry} />}</Show>
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
      <Show when={!props.methods.some((method) => method.input)} fallback={<p class="sb-fine">A key or gateway you type here is passed to the agent once. Span does not store it.</p>}>
        <p class="sb-fine">Credentials stay with the agent. Span never sees them.</p>
      </Show>
    </section>
  );
}
