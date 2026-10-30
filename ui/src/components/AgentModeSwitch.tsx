import { For } from "solid-js";
import type { AgentMode } from "../lib/agents-page";
import "../styles/agents-page.css";

const MODES: { mode: AgentMode; label: string }[] = [
  { mode: "editor", label: "Editor" },
  { mode: "agents", label: "Agents" },
];

/**
 * The Editor or Agents layout switch in the toolbar (ADR 0011 b): a two-option radio group. Arrow keys move the
 * choice, and only the chosen option is in the tab order. `shortcut` is the label of the chord that toggles it.
 */
export function AgentModeSwitch(props: { mode: AgentMode; onChange: (mode: AgentMode) => void; shortcut?: string }) {
  let group: HTMLDivElement | undefined;
  const pick = (mode: AgentMode, focus = false) => {
    if (mode !== props.mode) props.onChange(mode);
    if (focus) queueMicrotask(() => group?.querySelector<HTMLElement>(`[data-mode="${mode}"]`)?.focus());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "editor" : event.key === "End" ? "agents" : props.mode === "editor" ? "agents" : "editor";
    pick(next, true);
  };
  return (
    <div ref={group} class="ap-mode-switch" role="radiogroup" aria-label="Layout" onKeyDown={onKeyDown}>
      <For each={MODES}>
        {(entry) => (
          <button
            type="button"
            role="radio"
            data-mode={entry.mode}
            aria-checked={props.mode === entry.mode}
            tabIndex={props.mode === entry.mode ? 0 : -1}
            title={props.shortcut ? `${entry.label} layout (${props.shortcut})` : `${entry.label} layout`}
            onClick={() => pick(entry.mode)}
          >
            {entry.label}
          </button>
        )}
      </For>
    </div>
  );
}

export default AgentModeSwitch;
