import { For, Show, createEffect, onCleanup } from "solid-js";
import type { PermissionOption } from "../bindings";
import { permissionScope, sortPermissionOptions } from "../lib/agent-feed";

type AgentPermissionProps = {
  title: string;
  /** What the tool call will touch, for example the shell command. */
  summary: string;
  options: PermissionOption[];
  resolved: boolean;
  /** Only the oldest open request answers number keys. */
  active: boolean;
  busy: boolean;
  onChoose: (optionId: string | null) => void;
};

/** Permission prompt with the request target visible, grouped choices, and 1-9 / arrow key selection. */
export function AgentPermission(props: AgentPermissionProps) {
  let group: HTMLDivElement | undefined;
  const options = () => sortPermissionOptions(props.options);
  const buttons = () => [...(group?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];

  createEffect(() => {
    if (props.resolved || !props.active) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || props.busy) return;
      const target = event.target;
      const typing =
        target instanceof HTMLTextAreaElement
          ? target.value.length > 0
          : target instanceof HTMLInputElement;
      if (typing) return;
      const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const option = options()[index];
      if (option) {
        event.preventDefault();
        props.onChoose(option.optionId);
      }
    };
    window.addEventListener("keydown", keyboard);
    onCleanup(() => window.removeEventListener("keydown", keyboard));
  });
  createEffect(() => {
    if (props.resolved || !props.active) return;
    const focused = document.activeElement;
    const idle =
      !focused ||
      focused === document.body ||
      (focused instanceof HTMLTextAreaElement && !focused.value);
    if (idle) queueMicrotask(() => buttons()[0]?.focus());
  });
  function move(event: KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const list = buttons();
    const current = list.indexOf(event.target as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    list[(current + step + list.length) % list.length].focus();
  }
  return (
    <article class="agent-card agent-permission-card" classList={{ pending: !props.resolved }}>
      <div class="agent-card-header">
        <span class="agent-card-title">{props.title || "Permission requested"}</span>
        <span class="agent-state">{props.resolved ? "resolved" : "needs approval"}</span>
      </div>
      <Show when={!props.resolved}>
        <div class="agent-permission" role="group" aria-label="Permission choices" ref={group} onKeyDown={move}>
          <Show when={props.summary}>
            <code class="agent-permission-summary" title={props.summary}>{props.summary}</code>
          </Show>
          <div class="agent-permission-options">
            <For each={options()}>
              {(option, index) => (
                <button
                  class="agent-permission-option"
                  classList={{
                    primary: option.kind === "allow_once",
                    danger: option.kind.startsWith("reject"),
                  }}
                  disabled={props.busy}
                  onClick={() => props.onChoose(option.optionId)}
                >
                  <kbd aria-hidden="true">{index() + 1}</kbd>
                  <span>
                    {option.name}
                    <Show when={permissionScope(option.kind)}>
                      <small>{permissionScope(option.kind)}</small>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
          <button class="agent-link" disabled={props.busy} onClick={() => props.onChoose(null)}>
            Dismiss without answering
          </button>
        </div>
      </Show>
    </article>
  );
}
