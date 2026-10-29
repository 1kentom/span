import { For, Show, createEffect, createSignal, createUniqueId } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";
import type { AgentChoice } from "./types";
import { UpdateBadge } from "./UpdateBadge";
import { HealthDot } from "./HealthDot";
import { findHealth, type AgentHealth } from "../../lib/agent-health";
import { arrowFocus, useEscape } from "./util";

export type PresetChoice = { id: string; name: string; description?: string };

type AgentPopoverProps = {
  /** Installed agents. `current` marks the one this chat runs on. */
  agents: AgentChoice[];
  /** Name of the agent of the open chat. Set only while connected, which is when switching starts a new chat. */
  connectedName?: string;
  /** Known launch commands that are not installed yet. */
  presets?: PresetChoice[];
  updates?: AgentUpdate[];
  checkingUpdates?: boolean;
  updateError?: string;
  busy?: boolean;
  /** False in the browser preview, which cannot start agents. */
  desktop?: boolean;
  /** Health check results (ADR 0010). Unset while `agents.healthCheck` is off: no dots at all. */
  health?: readonly AgentHealth[];
  /** The clock for "4 min ago" in the dot tooltips. */
  healthNow?: number;
  onSelect: (agentId: string) => void;
  onPreset?: (presetId: string) => void;
  onCheckUpdates: () => void;
  /** Opens the full connect screen: registry, presets and a custom command. */
  onAdd: () => void;
  onClose: () => void;
};

/** The agent popover: installed agents with their versions and update badges, presets to connect, and Add agent. */
export function AgentPopover(props: AgentPopoverProps) {
  let root: HTMLDivElement | undefined;
  useEscape(props.onClose);
  const noteId = createUniqueId();
  const switchable = () => [...props.agents.filter((agent) => !agent.current), ...(props.presets ?? [])];
  // The agent the switching line names: the row under focus or pointer, else the first one offered.
  const [target, setTarget] = createSignal<string>();
  const targetName = () => switchable().find((entry) => entry.id === target())?.name ?? switchable()[0]?.name;
  const point = (id: string) => ({ onFocus: () => setTarget(id), onPointerEnter: () => setTarget(id) });
  const describedBy = () => (props.connectedName ? noteId : undefined);
  createEffect(() => {
    queueMicrotask(() => root?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
  });
  return (
    <div class="sb-popover sb-picker" role="dialog" aria-label="Agents" ref={root} onKeyDown={(event) => arrowFocus(event, root, "button:not(:disabled)")}>
      <Show when={props.desktop ?? true} fallback={<p class="sb-fine pad">Open span desktop to connect an ACP agent.</p>}>
        <div class="sb-eyebrow">Installed agents</div>
        <For each={props.agents} fallback={<p class="sb-fine pad">No managed agents installed yet.</p>}>
          {(agent) => (
            <button
              class="sb-option"
              disabled={props.busy || agent.current}
              aria-current={agent.current ? "true" : undefined}
              aria-describedby={agent.current ? undefined : describedBy()}
              onClick={() => props.onSelect(agent.id)}
              {...point(agent.id)}
            >
              <BrandIcon id={agent.id} name={agent.name} size={15} />
              <span class="sb-option-text">
                <span class="sb-option-name">{agent.name}</span>
                <Show when={agent.subtitle}><span class="sb-sub">{agent.subtitle}</span></Show>
                <UpdateBadge update={props.updates?.find((update) => update.id === agent.id)} />
              </span>
              <Show when={props.health}>
                {(list) => <HealthDot health={findHealth(list(), agent.id, agent.name)} now={props.healthNow ?? Date.now()} />}
              </Show>
              <Show when={agent.current}><span class="sb-ok-text">Connected</span></Show>
            </button>
          )}
        </For>
        <Show when={props.presets?.length}>
          <div class="sb-eyebrow">Available</div>
          <For each={props.presets}>
            {(preset) => (
              <button class="sb-option" disabled={props.busy || !props.onPreset} aria-describedby={describedBy()} onClick={() => props.onPreset?.(preset.id)} {...point(preset.id)}>
                <BrandIcon id={preset.id} name={preset.name} size={15} />
                <span class="sb-option-text">
                  <span class="sb-option-name">{preset.name}</span>
                  <Show when={preset.description}><span class="sb-sub">{preset.description}</span></Show>
                </span>
                <span class="sb-sub">Connect</span>
              </button>
            )}
          </For>
        </Show>
        <Show when={props.connectedName && targetName()}>
          <p class="sb-fine pad sb-switch-note" id={noteId}>{`Switching starts a new chat with ${targetName()}.`}</p>
        </Show>
        <div class="sb-rule-h" />
        <button class="sb-option" disabled={props.checkingUpdates} onClick={() => props.onCheckUpdates()}>
          <Icon name="Refresh2" size={15} />
          <span class="sb-option-text">
            <span class="sb-option-name">{props.checkingUpdates ? "Checking for updates…" : "Check for updates"}</span>
            <Show when={props.updateError}><span class="sb-sub" role="alert">{props.updateError}</span></Show>
          </span>
        </button>
        <button class="sb-option" onClick={() => props.onAdd()}>
          <Icon name="Add" size={15} />
          <span class="sb-option-text">
            <span class="sb-option-name">Add agent</span>
            <span class="sb-sub">Registry, presets and custom command</span>
          </span>
          <Icon name="arrow-right4" size={11} />
        </button>
      </Show>
    </div>
  );
}
