import { For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon";
import { alternativesLabel } from "../../lib/agent-delegation";

type DecisionCardProps = {
  /** The agent that recorded the decision. */
  by: string;
  chosen: string;
  why: string;
  alternatives: string[];
};

/** A decision the lead recorded with `record_decision`: what it chose and why, with the alternatives behind a toggle. */
export function DecisionCard(props: DecisionCardProps) {
  const [open, setOpen] = createSignal(false);
  return (
    <section class="sb-decision" aria-label={`Decision by ${props.by}`}>
      <div class="sb-decision-eyebrow">
        <Icon name="TickCircle" size={11} class="sb-ok" />
        <span class="sb-ellipsis">Decision · {props.by}</span>
      </div>
      <div class="sb-decision-chosen">{props.chosen}</div>
      <Show when={props.why}><div class="sb-body">{props.why}</div></Show>
      <Show when={props.alternatives.length}>
        <button type="button" class="sb-decision-toggle" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Icon name={open() ? "arrow-down4" : "arrow-right4"} size={10} />
          <span>{alternativesLabel(props.alternatives.length)}</span>
        </button>
        <Show when={open()}>
          <ul class="sb-decision-alts" aria-label="Alternatives considered">
            <For each={props.alternatives}>{(alternative) => <li>{alternative}</li>}</For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
