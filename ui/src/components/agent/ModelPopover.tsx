import { For, Show, createEffect } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { AgentChoice, ConfigOptionView } from "./types";
import { arrowFocus, useEscape } from "./util";

type ModelPopoverProps = {
  agentName: string;
  options: ConfigOptionView[];
  agents?: AgentChoice[];
  busy?: boolean;
  onSelect: (configId: string, value: string) => void;
  onSwitchAgent?: (agentId: string) => void;
  onClose: () => void;
};

/** Bar heights rise from a short first bar to a full last bar. Level names come from the data. */
export const barHeight = (index: number, count: number) => `${Math.round(30 + (70 * (index + 1)) / Math.max(1, count))}%`;

function LevelControl(props: { option: ConfigOptionView; disabled?: boolean; onSelect: (value: string) => void }) {
  const selected = () => Math.max(0, props.option.choices.findIndex((choice) => choice.value === props.option.currentValue));
  const current = () => props.option.choices[selected()];
  return (
    <div class="sb-level">
      <div class="sb-level-head">
        <span class="sb-eyebrow tight">{props.option.name}</span>
        <span class="sb-flex" />
        <span class="sb-level-name">{current()?.name}</span>
      </div>
      <div class="sb-level-bars" role="radiogroup" aria-label={props.option.name}>
        <For each={props.option.choices}>
          {(choice, index) => (
            <button
              class="sb-level-bar"
              role="radio"
              aria-checked={choice.value === props.option.currentValue}
              aria-label={choice.name}
              title={choice.name}
              disabled={props.disabled}
              onClick={() => props.onSelect(choice.value)}
            >
              <span class="sb-level-fill" classList={{ on: index() <= selected() }} style={{ height: barHeight(index(), props.option.choices.length) }} />
            </button>
          )}
        </For>
      </div>
      <Show when={props.option.choices.length > 1}>
        <div class="sb-level-ends">
          <span>{props.option.choices[0].name}</span>
          <span>{props.option.choices[props.option.choices.length - 1].name}</span>
        </div>
      </Show>
      <Show when={current()?.description}><div class="sb-sub wrap">{current()?.description}</div></Show>
    </div>
  );
}

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
              <LevelControl option={option} disabled={props.busy} onSelect={(value) => props.onSelect(option.id, value)} />
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
