import { For, Show } from "solid-js";

export type ComposerHintMode = "idle" | "running" | "question" | "permission";
export interface ComposerHint { keys: string[]; label: string }

export interface ComposerHintsProps {
  mode: ComposerHintMode;
  /**
   * Hints per mode. The caller lists only shortcuts that are really bound, so this component never
   * invents one. A mode with no hints renders nothing.
   */
  hints: Partial<Record<ComposerHintMode, readonly ComposerHint[]>>;
}

/** One line of keyboard hints under the composer toolbar. */
export function ComposerHints(props: ComposerHintsProps) {
  const rows = () => props.hints[props.mode] ?? [];
  return (
    <Show when={rows().length}>
      <ul class="sb-hints" data-mode={props.mode} aria-label="Keyboard shortcuts">
        <For each={rows()}>{(hint) => (
          <li class="sb-hint">
            <Show when={hint.keys.length}><span class="sb-hint-keys"><For each={hint.keys}>{(k) => <kbd class="sb-hint-key">{k}</kbd>}</For></span>{" "}</Show>
            <span>{hint.label}</span>
          </li>
        )}</For>
      </ul>
    </Show>
  );
}
