import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "../Icon";
import type { AuthInputKind, AuthSecret } from "./types";

type Header = { id: number; name: string; value: string };

type AuthFormProps = {
  kind: AuthInputKind;
  methodName: string;
  busy?: boolean;
  /** Receives the typed secret once. The form clears its own fields before this runs. */
  onSubmit: (secret: AuthSecret) => void;
  onCancel?: () => void;
};

/** The base URL must be http or https. Anything else is rejected before it reaches the agent. */
export function parseGatewayUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects an API key, or a gateway base URL and headers, for a sign-in method.
 * The values live only in this component's signals. They are cleared on submit and on unmount, never written
 * to feed or session state, never rendered back, and every header value is a password field.
 */
export function AuthForm(props: AuthFormProps) {
  const [key, setKey] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [headers, setHeaders] = createSignal<Header[]>([]);
  const [error, setError] = createSignal("");
  let counter = 0;
  let form: HTMLFormElement | undefined;
  const clear = () => {
    setKey("");
    setBaseUrl("");
    setHeaders([]);
    // Also wipe the fields themselves, in case a pending render has not reached them.
    form?.querySelectorAll("input").forEach((field) => (field.value = ""));
  };
  onCleanup(clear);
  const patchHeader = (id: number, change: Partial<Header>) => setHeaders((list) => list.map((header) => (header.id === id ? { ...header, ...change } : header)));
  const ready = () => (props.kind === "apiKey" ? key().trim().length > 0 : baseUrl().trim().length > 0);
  const submit = (event: Event) => {
    event.preventDefault();
    if (props.busy || !ready()) return;
    let secret: AuthSecret;
    if (props.kind === "apiKey") secret = { kind: "apiKey", key: key().trim() };
    else {
      const url = parseGatewayUrl(baseUrl());
      if (!url) return setError("Enter a base URL that starts with https:// or http://");
      const entries = headers().flatMap((header) => (header.name.trim() ? [[header.name.trim(), header.value] as const] : []));
      secret = { kind: "gateway", baseUrl: url, headers: Object.fromEntries(entries) };
    }
    setError("");
    clear();
    props.onSubmit(secret);
  };
  return (
    <form ref={form} class="sb-auth-form" onSubmit={submit} aria-label={`${props.methodName} credentials`} autocomplete="off">
      <Show
        when={props.kind === "gateway"}
        fallback={
          <label class="sb-field-label">
            <span>API key</span>
            <input class="sb-input mono" type="password" name="span-agent-api-key" autocomplete="off" spellcheck={false} autocapitalize="off" value={key()} disabled={props.busy} onInput={(event) => setKey(event.currentTarget.value)} />
          </label>
        }
      >
        <label class="sb-field-label">
          <span>Base URL</span>
          <input class="sb-input mono" type="url" name="span-agent-gateway-url" autocomplete="off" spellcheck={false} placeholder="https://gateway.example.com" value={baseUrl()} disabled={props.busy} onInput={(event) => setBaseUrl(event.currentTarget.value)} />
        </label>
        <div class="sb-field-label">
          <span>Headers (optional)</span>
          <For each={headers()}>
            {(header) => (
              <div class="sb-header-row">
                <input class="sb-input mono" aria-label="Header name" autocomplete="off" spellcheck={false} placeholder="Name" value={header.name} disabled={props.busy} onInput={(event) => patchHeader(header.id, { name: event.currentTarget.value })} />
                <input class="sb-input mono" type="password" aria-label="Header value" autocomplete="off" spellcheck={false} placeholder="Value" value={header.value} disabled={props.busy} onInput={(event) => patchHeader(header.id, { value: event.currentTarget.value })} />
                <button type="button" class="sb-icon-btn" aria-label="Remove header" onClick={() => setHeaders((list) => list.filter((entry) => entry.id !== header.id))}>
                  <Icon name="CloseCircle" size={11} />
                </button>
              </div>
            )}
          </For>
          <button type="button" class="sb-btn ghost" onClick={() => setHeaders((list) => [...list, { id: ++counter, name: "", value: "" }])}>Add header</button>
        </div>
      </Show>
      <Show when={error()}><p class="sb-fine sb-bad-text" role="alert">{error()}</p></Show>
      <div class="sb-actions">
        <button class="sb-btn primary" type="submit" disabled={props.busy || !ready()}>Sign in</button>
        <Show when={props.onCancel}><button class="sb-btn" type="button" onClick={() => props.onCancel?.()}>Cancel</button></Show>
      </div>
      <p class="sb-fine">Sent to the agent once. Span does not store it or show it again.</p>
    </form>
  );
}
