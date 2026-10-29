import { Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../Icon";
import { CLAMP_LINES, CLAMP_TEXT, clampState } from "../../lib/agent-approval";

type DockClampProps = {
  /** The full text: the tooltip, the copied text and, without children, what is drawn. */
  text: string;
  /** Classes for the clamped body, for example "sb-code sb-dock-command". */
  class?: string;
  /** Monospace block: breaks anywhere, never between a word and its punctuation in prose. */
  mono?: boolean;
  /** Drawn instead of `text`, for a "$ " prompt or a diff. */
  children?: JSX.Element;
  /** Lines shown before "Show more"; a diff counts its rows. */
  lines?: number;
  /** Characters per line for the estimate used before layout exists. */
  charsPerLine?: number;
  /** Offers Copy beside the toggle. A rejection shows "Could not copy". */
  onCopy?: (text: string) => void | Promise<void>;
  /** Accessible name of the Copy button, for example "Copy command". */
  copyLabel?: string;
};

/**
 * A block clamped to three lines inside a dock, with a quiet Show more / Show less toggle that expands it in place
 * (to about twelve lines, then it scrolls) and an optional Copy button. The full text is always in the tooltip.
 * Overflow is measured from layout once it exists, and only while collapsed, so the toggle never vanishes on expand.
 */
export function DockClamp(props: DockClampProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [measured, setMeasured] = createSignal<boolean>();
  const [copied, setCopied] = createSignal("");
  const id = createUniqueId();
  let body!: HTMLDivElement;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copyTimer));
  const state = () => clampState({ text: props.text, expanded: expanded(), measured: measured(), maxLines: props.lines ?? CLAMP_LINES, charsPerLine: props.charsPerLine });
  const measure = () => {
    if (expanded() || !body || body.clientHeight === 0) return;
    const scroller = body.querySelector<HTMLElement>(".sb-diff-body") ?? body;
    setMeasured(scroller.scrollHeight > scroller.clientHeight + 1);
  };
  onMount(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(body);
    onCleanup(() => observer.disconnect());
  });
  async function copy() {
    clearTimeout(copyTimer);
    try {
      await props.onCopy?.(props.text);
      setCopied(CLAMP_TEXT.copied);
    } catch {
      setCopied(CLAMP_TEXT.copyFailed);
    }
    copyTimer = setTimeout(() => setCopied(""), 1500);
  }
  return (
    <div class="sb-clamp" classList={{ mono: props.mono }}>
      <div
        ref={body}
        id={id}
        class={`sb-clamp-body ${props.class ?? ""}`}
        classList={{ "sb-clamped": state().clamped, "sb-expanded": !state().clamped }}
        style={{ "--sb-clamp-lines": String(props.lines ?? CLAMP_LINES) }}
        title={props.text}
      >
        {props.children ?? props.text}
      </div>
      <Show when={state().toggle || props.onCopy}>
        <div class="sb-clamp-bar">
          <Show when={state().toggle}>
            {(toggle) => (
              <button type="button" class="sb-clamp-toggle" aria-expanded={toggle().expanded} aria-controls={id} onClick={() => setExpanded(!expanded())}>
                <Icon name={toggle().icon} size={10} />
                <span>{toggle().label}</span>
              </button>
            )}
          </Show>
          <span class="sb-flex" />
          <Show when={props.onCopy}>
            <span class="sb-sub sb-copy-status" role="status" aria-live="polite">{copied() === CLAMP_TEXT.copied ? "" : copied()}</span>
            <button type="button" class="sb-copy-btn" classList={{ copied: copied() === CLAMP_TEXT.copied }} aria-label={props.copyLabel ?? CLAMP_TEXT.copy} title={props.copyLabel ?? CLAMP_TEXT.copy} onClick={() => void copy()}>
              <Icon name={copied() === CLAMP_TEXT.copied ? "TickCircle" : "Copy"} size={11} />
              <span>{copied() === CLAMP_TEXT.copied ? CLAMP_TEXT.copied : CLAMP_TEXT.copy}</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
