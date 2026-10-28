import { Show, createSignal } from "solid-js";
import Icon from "./Icon";
import type { HubView } from "../stores/language-intelligence";
import "../styles/language-servers.css";

export interface LanguageIntelligenceButtonProps {
  view: HubView;
  open: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
}

const RADIUS = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The top bar button for language intelligence. Its label, tooltip, ring and badge all come from the hub view,
 * so it can never disagree with the panel. There is no title attribute: the tooltip is drawn from the same view.
 */
export function LanguageIntelligenceButton(props: LanguageIntelligenceButtonProps) {
  const [hover, setHover] = createSignal(false);
  const [focus, setFocus] = createSignal(false);
  const button = () => props.view.button;
  const ring = () => button().ring;
  return <span class="hub-anchor">
    <button type="button" class="icon-button hub-button blue" data-hub-trigger data-tone={button().tone} data-ring={ring().kind} data-badge={button().badge ?? ""}
      data-percent={ring().percent ?? ""} aria-haspopup="dialog" aria-expanded={props.open} aria-controls={props.open ? "language-intelligence-panel" : undefined} aria-label={button().label}
      onClick={event => props.onToggle(event.currentTarget)} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
      <svg class="hub-ring" viewBox="0 0 28 28" aria-hidden="true">
        <circle class="hub-ring-track" cx="14" cy="14" r={RADIUS} />
        <Show when={ring().kind !== "none"}><circle class="hub-ring-bar" classList={{ spin: ring().kind === "indeterminate" }} cx="14" cy="14" r={RADIUS} transform="rotate(-90 14 14)"
          stroke-dasharray={ring().kind === "determinate" ? `${(CIRCUMFERENCE * (ring().percent ?? 0)) / 100} ${CIRCUMFERENCE}` : `${CIRCUMFERENCE * 0.25} ${CIRCUMFERENCE}`} /></Show>
      </svg>
      <Icon name="flash" size={16} />
      <Show when={button().badge}><i class="hub-badge dot" data-kind={button().badge} /></Show>
    </button>
    <Show when={(hover() || focus()) && !props.open}><span class="hub-tooltip" role="tooltip" aria-hidden="true">{button().tooltip}</span></Show>
  </span>;
}

export default LanguageIntelligenceButton;
