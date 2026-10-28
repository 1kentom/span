import { Show } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { STATUS_TEXT, type DelegationStatusKind } from "../../lib/agent-delegation";

type DelegationCardProps = {
  agent: string;
  status: DelegationStatusKind;
  /** The reason text for a failed or cancelled task, from the backend's reported reason. */
  note?: string;
  /** The delegated agent has a permission request open in the dock. */
  waiting?: boolean;
};

const GLYPH: Partial<Record<DelegationStatusKind, { name: string; tone: string }>> = {
  completed: { name: "TickCircle", tone: "sb-ok" },
  failed: { name: "CloseCircle", tone: "sb-bad" },
  cancelled: { name: "Stop", tone: "dim" },
  unknown: { name: "InfoCircle", tone: "dim" },
};

/** A task the lead delegated to another agent. It shows only what the backend reports: agent, status, failure reason. */
export function DelegationCard(props: DelegationCardProps) {
  const glyph = () => GLYPH[props.status];
  return (
    <section class="sb-delegation" classList={{ failed: props.status === "failed" }} aria-label={`Delegated to ${props.agent}: ${STATUS_TEXT[props.status]}`}>
      <div class="sb-delegation-head">
        <BrandIcon name={props.agent} size={14} />
        <span class="sb-delegation-name sb-ellipsis">{props.agent}</span>
        <span class="sb-chip">Delegated</span>
        <span class="sb-flex" />
        <span class="sb-delegation-status" role="status">
          <Show when={glyph()} fallback={<span class="sb-spinner" aria-hidden="true" />}>
            {(item) => <Icon name={item().name} size={12} class={item().tone} />}
          </Show>
          <span class="sb-sub nowrap">{STATUS_TEXT[props.status]}</span>
        </span>
      </div>
      <Show when={props.note}><div class="sb-body sb-delegation-note">{props.note}</div></Show>
      <Show when={props.waiting}>
        <div class="sb-delegation-wait"><span class="sb-dot warn" aria-hidden="true" />Needs your approval below</div>
      </Show>
    </section>
  );
}
