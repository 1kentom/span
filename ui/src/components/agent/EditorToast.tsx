import { Show, createEffect, createSignal, onCleanup } from "solid-js";
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

export interface OpenRefusalProps {
  /** The path that could not be opened, with the reason. Hidden while undefined. */
  refusal?: { path: string; reason: string };
  /** Copies the path. The note confirms it, or shows the failure. */
  onCopy: (path: string) => Promise<void>;
  onDismiss: () => void;
  /** Milliseconds before auto dismiss. Default 8000. */
  duration?: number;
}

/** Clear refusal for a click whose path is outside the workspace: says why nothing opened and offers the path. */
export function OpenRefusal(props: OpenRefusalProps) {
  const [copied, setCopied] = createSignal<"" | "done" | "failed">("");
  createEffect(() => {
    if (!props.refusal) return;
    setCopied("");
    const timer = setTimeout(() => props.onDismiss(), props.duration ?? 8000);
    onCleanup(() => clearTimeout(timer));
  });
  const copy = (path: string) => props.onCopy(path).then(() => setCopied("done"), () => setCopied("failed"));
  return (
    <div class="sb-toast-host sb-refusal-host" role="status" aria-live="polite">
      <Show when={props.refusal}>
        {(refusal) => (
          <div class="sb-toast sb-refusal">
            <Icon name="Warning2" size={12} class="sb-refusal-icon" />
            <span class="sb-refusal-text">
              <span>{refusal().reason}</span>
              <span class="sb-mono sb-refusal-path" title={refusal().path}>{refusal().path}</span>
            </span>
            <button type="button" class="sb-btn sb-refusal-copy" onClick={() => void copy(refusal().path)}>
              <Icon name={copied() === "done" ? "Check" : "Copy"} size={11} />
              {copied() === "done" ? "Copied" : copied() === "failed" ? "Copy failed" : "Copy path"}
            </button>
            <button type="button" class="sb-icon-btn" aria-label="Dismiss" onClick={() => props.onDismiss()}><Icon name="Close" size={9} /></button>
          </div>
        )}
      </Show>
    </div>
  );
}
