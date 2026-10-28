import { For, Show } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import type { AuthMethod, Brand } from "./types";

type SignInProps = Brand & {
  title: string;
  text?: string;
  methods: AuthMethod[];
  busy?: boolean;
  onPick: (methodId: string) => void;
};

/** Authentication methods the agent advertised. The first one is the primary action. */
export function SignIn(props: SignInProps) {
  return (
    <section class="sb-signin" aria-labelledby="sb-signin-title">
      <BrandIcon id={props.id} name={props.name} size={26} />
      <header>
        <h2 id="sb-signin-title" class="sb-title">{props.title}</h2>
        <Show when={props.text}><p class="sb-lede">{props.text}</p></Show>
      </header>
      <div class="sb-methods">
        <For each={props.methods}>
          {(method, index) => (
            <button class="sb-method" classList={{ primary: index() === 0 }} disabled={props.busy} onClick={() => props.onPick(method.id)}>
              <span class="sb-method-name">{method.name}</span>
              <Show when={method.description}><span class="sb-method-desc">{method.description}</span></Show>
            </button>
          )}
        </For>
      </div>
      <p class="sb-fine">Credentials stay with the agent. Span never sees them.</p>
    </section>
  );
}
