import { For, Show, createEffect, createMemo, createUniqueId } from "solid-js";
import { Icon } from "../Icon";
import { groupOptions, isBooleanOption } from "../../lib/agent-options";
import { modeIconFor } from "../../lib/mode-icons";
import type { ConfigOptionView } from "./types";
import { arrowFocus, useEscape } from "./util";

type ModePopoverProps = {
  agentName: string;
  /** Every session config option. The mode option and every other non-model option are drawn, each under its own heading. */
  options: ConfigOptionView[];
  busy?: boolean;
  onSelect: (configId: string, value: string) => void;
  onClose: () => void;
};

/** The mode popover: the agent's mode first, then each other select or on/off option it reports, so none is lost. */
export function ModePopover(props: ModePopoverProps) {
  let root: HTMLDivElement | undefined;
  useEscape(props.onClose);
  const sections = createMemo(() => groupOptions(props.options).mode.map((option) => option.id), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  createEffect(() => {
    queueMicrotask(() => (root?.querySelector<HTMLElement>("[aria-checked='true']:not(:disabled)") ?? root?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus());
  });
  return (
    <div class="sb-popover sb-picker" role="dialog" aria-label={`${props.agentName} mode`} ref={root} onKeyDown={(event) => arrowFocus(event, root, "button:not(:disabled)")}>
      {/* Keyed by option id and choice value so a config update keeps focus on the row the user is on. */}
      <For each={sections()}>
        {(optionId, index) => {
          let last = props.options.find((candidate) => candidate.id === optionId)!;
          const option = () => (last = props.options.find((candidate) => candidate.id === optionId) ?? last);
          return (
            <>
              <Show when={index() > 0}><div class="sb-rule-h" /></Show>
              <Show
                when={isBooleanOption(option())}
                fallback={
                  <div role="radiogroup" aria-label={option().name}>
                    <div class="sb-eyebrow">{option().name}</div>
                    <For each={option().choices.map((choice) => choice.value)}>
                      {(choiceValue) => {
                        let lastChoice = option().choices.find((candidate) => candidate.value === choiceValue)!;
                        const choice = () => (lastChoice = option().choices.find((candidate) => candidate.value === choiceValue) ?? lastChoice);
                        const current = () => choiceValue === option().currentValue;
                        const lead = () => modeIconFor(choiceValue);
                        return (
                          <button class="sb-option" role="radio" aria-checked={current()} disabled={props.busy} onClick={() => props.onSelect(option().id, choiceValue)}>
                            <span class={`sb-option-lead${lead().danger ? " warn" : ""}`}><Icon name={lead().icon} size={16} /></span>
                            <span class="sb-option-text">
                              <span class="sb-option-name">{choice().name}</span>
                              <Show when={choice().description}><span class="sb-sub wrap">{choice().description}</span></Show>
                            </span>
                            <Show when={current()}><Icon name="TickCircle" size={14} class="sb-accent" /></Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                }
              >
                <SwitchRow option={option()} busy={props.busy} onSelect={props.onSelect} />
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}

const ON_VALUES = ["true", "on", "enabled", "yes"];

/** A two-choice on/off option as one row: title, the current choice's own description, and the switch. Applies at once. */
function SwitchRow(props: { option: ConfigOptionView; busy?: boolean; onSelect: (configId: string, value: string) => void }) {
  const id = createUniqueId();
  const onChoice = () => props.option.choices.find((choice) => ON_VALUES.includes(choice.value.toLowerCase()))!;
  const offChoice = () => props.option.choices.find((choice) => choice !== onChoice())!;
  const on = () => props.option.currentValue === onChoice().value;
  const description = () => props.option.choices.find((choice) => choice.value === props.option.currentValue)?.description;
  const toggle = () => {
    if (!props.busy) props.onSelect(props.option.id, (on() ? offChoice() : onChoice()).value);
  };
  return (
    <div class="sb-switch-row">
      <span class="sb-option-text">
        <span class="sb-switch-title" id={`${id}-title`}>{props.option.name}</span>
        <Show when={description()}><span class="sb-sub wrap sb-switch-sub" id={`${id}-sub`}>{description()}</span></Show>
      </span>
      <button
        class="sb-switch"
        role="switch"
        aria-checked={on()}
        aria-labelledby={`${id}-title`}
        aria-describedby={description() ? `${id}-sub` : undefined}
        disabled={props.busy}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle();
        }}
        onKeyUp={(event) => {
          if (event.key === " ") event.preventDefault();
        }}
      >
        <span class="sb-switch-knob" />
      </button>
    </div>
  );
}
