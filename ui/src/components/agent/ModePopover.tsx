import { For, Show, createEffect, createMemo } from "solid-js";
import { Icon } from "../Icon";
import { groupOptions } from "../../lib/agent-options";
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
              <div role="radiogroup" aria-label={option().name}>
                <div class="sb-eyebrow">{option().name}</div>
                <For each={option().choices.map((choice) => choice.value)}>
                  {(choiceValue) => {
                    let lastChoice = option().choices.find((candidate) => candidate.value === choiceValue)!;
                    const choice = () => (lastChoice = option().choices.find((candidate) => candidate.value === choiceValue) ?? lastChoice);
                    const current = () => choiceValue === option().currentValue;
                    return (
                      <button class="sb-option" role="radio" aria-checked={current()} disabled={props.busy} onClick={() => props.onSelect(option().id, choiceValue)}>
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
            </>
          );
        }}
      </For>
    </div>
  );
}
