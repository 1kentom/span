import { Show } from "solid-js";
import { percent } from "./util";

type UsageRingProps = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  /** Percentage above which the ring turns to the warning colour. */
  warnAt?: number;
};

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Context window ring with the percentage beside it. Cost goes in the tooltip when reported. */
export function UsageRing(props: UsageRingProps) {
  const pct = () => percent(props.used, props.size);
  const warn = () => pct() > (props.warnAt ?? 85);
  const title = () => {
    const base = `Context ${props.used.toLocaleString()} of ${props.size.toLocaleString()} tokens used`;
    const cost = props.cost;
    if (!cost) return base;
    try {
      return `${base}. Cost ${new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.amount)}`;
    } catch {
      return `${base}. Cost ${cost.amount} ${cost.currency}`;
    }
  };
  return (
    <span class="sb-ring" classList={{ warn: warn() }} role="img" aria-label={title()} title={title()}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="sb-ring-track" cx="8" cy="8" r={RADIUS} fill="none" stroke-width="2" />
        <circle
          class="sb-ring-value"
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={`${(CIRCUMFERENCE * pct()) / 100} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span>{pct()}%</span>
      <Show when={props.cost}><span class="sb-visually-hidden">with cost</span></Show>
    </span>
  );
}
