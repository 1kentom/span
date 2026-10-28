import { Show, createEffect, onCleanup } from "solid-js";
import { Icon } from "../Icon";

export interface EditorToastProps {
  /** File name that was opened. The toast is hidden while this is empty. */
  name?: string;
  /** Called when the toast should go away (timeout). The caller clears `name`. */
  onDismiss: () => void;
  /** Milliseconds before auto dismiss. Default 3000. */
  duration?: number;
}

/** Transient confirmation that an attachment or file opened in the editor. */
export function EditorToast(props: EditorToastProps) {
  createEffect(() => {
    if (!props.name) return;
    const timer = setTimeout(() => props.onDismiss(), props.duration ?? 3000);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <div class="sb-toast-host" role="status" aria-live="polite">
      <Show when={props.name}>
        <div class="sb-toast">
          <Icon name="arrow-right4" size={10} class="sb-toast-icon" />
          <span>Opened</span>{" "}
          <span class="sb-mono sb-toast-name">{props.name}</span>{" "}
          <span>in the editor</span>
        </div>
      </Show>
    </div>
  );
}
