import { For, Show, createSignal } from "solid-js";
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
  busy?: boolean;
  onPick: (methodId: string) => void;
  /** Called with a typed secret for methods that ask for an API key or a gateway. */
  onSubmit?: (methodId: string, secret: AuthSecret) => void;
};

/** Text with `code` spans for the parts the hint table put in backticks. */
export function HintLine(props: { text: string }) {
  return <For each={splitCode(props.text)}>{(part) => (part.code ? <code class="sb-mono">{part.text}</code> : <>{part.text}</>)}</For>;
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
      <div class="sb-methods">
        <For each={props.methods}>
          {(method, index) => (
            <>
              <button
                class="sb-method"
                classList={{ primary: index() === 0 && !method.input }}
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
