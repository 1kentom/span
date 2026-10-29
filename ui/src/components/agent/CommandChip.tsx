import { createSignal, onCleanup } from "solid-js";
import { Icon } from "../Icon";

/**
 * A launch command on one line that fills the text column: the command on the left, cut with an ellipsis when it
 * does not fit (the full text is in the title), and an icon-only copy button on the right. It never wraps or stacks.
 */
export function CommandChip(props: { command: string; label?: string; onCopy?: (command: string) => unknown }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const copy = async () => {
    try {
      await (props.onCopy ? props.onCopy(props.command) : navigator.clipboard.writeText(props.command));
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch { /* the command stays selectable */ }
  };
  onCleanup(() => clearTimeout(timer));
  return (
    <span class="sb-command-chip">
      <code class="sb-preset-command sb-mono" aria-label={props.label} title={props.command}>{props.command}</code>
      <button type="button" class="sb-icon-btn sb-command-copy" classList={{ copied: copied() }} aria-label="Copy command" title={copied() ? "Copied" : "Copy command"} onClick={() => void copy()}>
        <Icon name={copied() ? "TickCircle" : "Copy"} size={13} />
      </button>
      <span class="sb-visually-hidden" role="status" aria-live="polite">{copied() ? "Copied" : ""}</span>
    </span>
  );
}
