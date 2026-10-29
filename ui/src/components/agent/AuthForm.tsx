import { For, Show, createSignal, onCleanup } from "solid-js";
import { Icon } from "../Icon";
import { gatewayPresets, presetHeaders } from "../../lib/sign-in-copy";
import type { AuthInputKind, AuthSecret } from "./types";

type Header = { id: number; name: string; value: string };

type AuthFormProps = {
  kind: AuthInputKind;
  methodName: string;
  /** For a gateway, the protocol the agent expects. Known providers for it are offered as presets. */
  protocol?: string;
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

/** The custom gateway row of the provider chooser. */
const CUSTOM = "custom";

/** The index a key moves to in a radio group of `count` rows, wrapping at both ends, or undefined for other keys. */
function stepFor(key: string, index: number, count: number): number | undefined {
  if (key === "ArrowDown" || key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/**
 * Collects an API key, or a gateway base URL and headers, for a sign-in method.
 * The values live only in this component's signals. They are cleared on submit and on unmount, never written
 * to feed or session state, never rendered back, and every header value is a password field.
 * A gateway whose protocol has a known provider opens on that provider: a custom chooser (a radio group, not a
 * native select) between the provider and a custom gateway, and for the provider only its key is typed.
 */
export function AuthForm(props: AuthFormProps) {
  const [key, setKey] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [headers, setHeaders] = createSignal<Header[]>([]);
  const [error, setError] = createSignal("");
  const presets = gatewayPresets(props.kind === "gateway" ? props.protocol : undefined);
  const choices = [...presets.map((preset) => ({ id: preset.id, name: preset.name, detail: preset.baseUrl })), { id: CUSTOM, name: "Custom gateway", detail: "Any base URL and headers" }];
  const [choice, setChoice] = createSignal(presets[0]?.id ?? CUSTOM);
  const preset = () => presets.find((entry) => entry.id === choice());
  let chooser: HTMLDivElement | undefined;
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
  const ready = () => (props.kind === "apiKey" || preset() ? key().trim().length > 0 : baseUrl().trim().length > 0);
  const pick = (id: string) => {
    if (id === choice()) return;
    clear();
    setError("");
    setChoice(id);
  };
  const onChooserKey = (event: KeyboardEvent, index: number) => {
    const to = stepFor(event.key, index, choices.length);
    if (to === undefined) return;
    event.preventDefault();
    pick(choices[to].id);
    chooser?.querySelectorAll<HTMLElement>("[role='radio']")[to]?.focus();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (props.busy || !ready()) return;
    let secret: AuthSecret;
    const chosen = preset();
    if (props.kind === "apiKey") secret = { kind: "apiKey", key: key().trim() };
    else if (chosen) secret = { kind: "gateway", baseUrl: chosen.baseUrl, headers: presetHeaders(key()) };
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
      <Show when={presets.length}>
        <div class="sb-gateway-chooser" role="radiogroup" aria-label="Gateway provider" ref={chooser}>
          <For each={choices}>
            {(entry, index) => (
              <button
                type="button"
                class="sb-option sb-fallback-row sb-gateway-choice"
                role="radio"
                aria-checked={choice() === entry.id}
                tabIndex={choice() === entry.id ? 0 : -1}
                disabled={props.busy}
                onClick={() => pick(entry.id)}
                onKeyDown={(event) => onChooserKey(event, index())}
              >
                <span class="sb-option-text">
                  <span class="sb-option-name">{entry.name}</span>
                  <span class="sb-gateway-detail sb-mono sb-ellipsis" title={entry.detail}>{entry.detail}</span>
                </span>
                <span class="sb-radio-mark" aria-hidden="true" />
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={props.kind === "gateway" && !preset()}
        fallback={
          <>
            <label class="sb-field-label">
              <span>{preset()?.keyLabel ?? "API key"}</span>
              <input class="sb-input mono" type="password" name="span-agent-api-key" autocomplete="off" spellcheck={false} autocapitalize="off" value={key()} disabled={props.busy} onInput={(event) => setKey(event.currentTarget.value)} />
            </label>
            <Show when={preset()}>{(chosen) => <p class="sb-fine sb-gateway-note" role="note">{chosen().note}</p>}</Show>
          </>
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
