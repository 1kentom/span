import { For, Show } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import type { Brand, KeyHint, RecentSession } from "./types";

type EmptySessionProps = Brand & {
  title: string;
  text?: string;
  keys: KeyHint[];
  recents: RecentSession[];
  recentsLabel?: string;
  onOpenRecent?: (id: string) => void;
};

/** A new session with nothing sent yet: logo, heading, key hints and recent sessions. */
export function EmptySession(props: EmptySessionProps) {
  return (
    <section class="sb-empty" aria-label={props.title}>
      <BrandIcon id={props.id} name={props.name} size={26} />
      <header>
        <h2 class="sb-title">{props.title}</h2>
        <Show when={props.text}><p class="sb-lede">{props.text}</p></Show>
      </header>
      <ul class="sb-keys" aria-label="Shortcuts">
        <For each={props.keys}>
          {(hint) => (
            <li class="sb-key-row">
              <span class="sb-keycaps">
                <For each={hint.keys}>{(key) => <kbd class="sb-kbd">{key}</kbd>}</For>
              </span>
              <span>
                {hint.label} <Show when={hint.where}><span class="sb-where">{hint.where}</span></Show>
              </span>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.recents.length}>
        <div class="sb-group" role="group" aria-label={props.recentsLabel ?? "Recent in this workspace"}>
          <div class="sb-eyebrow">{props.recentsLabel ?? "Recent in this workspace"}</div>
          <For each={props.recents}>
            {(recent) => (
              <button class="sb-recent" onClick={() => props.onOpenRecent?.(recent.id)}>
                <BrandIcon id={recent.brand?.id ?? props.id} name={recent.brand?.name ?? props.name} size={13} />
                <span class="sb-ellipsis">{recent.title}</span>
                <span class="sb-sub">{recent.time}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
