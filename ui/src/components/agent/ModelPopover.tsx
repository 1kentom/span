import { For, Show, createEffect } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { AgentChoice, ConfigOptionView } from "./types";
import { arrowFocus, useEscape } from "./util";
import { EffortSlider, defaultLevel, focusModelRow, modelNameOf } from "./EffortSlider";

type ModelPopoverProps = {
  agentName: string;
  options: ConfigOptionView[];
  agents?: AgentChoice[];
  busy?: boolean;
  onSelect: (configId: string, value: string) => void;
  onSwitchAgent?: (agentId: string) => void;
  onClose: () => void;
};

/** Popover over the composer. Sections are built from the agent's session config options. */
export function ModelPopover(props: ModelPopoverProps) {
  let root: HTMLDivElement | undefined;
  useEscape(props.onClose);
  createEffect(() => {
    queueMicrotask(() => root?.querySelector<HTMLElement>("[aria-checked='true'], button:not(:disabled)")?.focus());
  });
  return (
    <div class="sb-popover" role="dialog" aria-label={`${props.agentName} options`} ref={root} onKeyDown={(event) => arrowFocus(event, root, "button:not(:disabled)")}>
      <For each={props.options}>
        {(option, index) => (
          <>
            <Show when={index() > 0}><div class="sb-rule-h" /></Show>
            <Show
              when={option.category === "thought_level"}
              fallback={
                <div role="radiogroup" aria-label={option.name}>
                  <div class="sb-eyebrow">{option.category === "model" ? `${option.name} · ${props.agentName}` : option.name}</div>
                  <For each={option.choices}>
                    {(choice) => (
                      <button
                        class="sb-option"
                        role="radio"
                        aria-checked={choice.value === option.currentValue}
                        disabled={props.busy}
                        onClick={() => props.onSelect(option.id, choice.value)}
                      >
                        <span class="sb-option-text">
                          <span class="sb-option-name">{choice.name}</span>
                          <Show when={choice.description}><span class="sb-sub wrap">{choice.description}</span></Show>
                        </span>
                        <Show when={choice.value === option.currentValue}><Icon name="TickCircle" size={14} class="sb-accent" /></Show>
                      </button>
                    )}
                  </For>
                </div>
              }
            >
              <EffortSlider
                label={option.name}
                options={option.choices}
                value={option.currentValue}
                defaultValue={defaultLevel(option.choices)}
                disabled={props.busy}
                modelName={modelNameOf(props.options)}
                onModelClick={() => focusModelRow(root, props.options)}
                onChange={(value) => props.onSelect(option.id, value)}
              />
            </Show>
          </>
        )}
      </For>
      <Show when={props.agents?.length}>
        <div class="sb-rule-h" />
        <div role="group" aria-label="Agent">
          <div class="sb-eyebrow">Agent</div>
          <For each={props.agents}>
            {(agent) => (
              <button class="sb-option" disabled={props.busy || agent.current || !props.onSwitchAgent} aria-current={agent.current ? "true" : undefined} onClick={() => props.onSwitchAgent?.(agent.id)}>
                <BrandIcon id={agent.id} name={agent.name} size={15} />
                <span class="sb-option-text">
                  <span class="sb-option-name">{agent.name}</span>
                  <Show when={agent.subtitle}><span class="sb-sub">{agent.subtitle}</span></Show>
                </span>
                <Show when={agent.current}><span class="sb-ok-text">Connected</span></Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <p class="sb-fine pad">Options come from the agent's session config.</p>
    </div>
  );
}
