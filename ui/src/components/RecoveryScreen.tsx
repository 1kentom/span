import { Show, createSignal } from "solid-js";
import { diagnosticsText, errorSummary } from "../lib/boot-guard";
import { collectStartupTimings, readBootTheme } from "../lib/startup";
import { clearSpanStorage, spanStorageKeyNames } from "../lib/stored";
import "../styles/recovery.css";

export type RecoveryReason = "error" | "slow";

export type RecoveryActions = {
  reload: () => void;
  /** Clears Span's own interface keys in localStorage. Settings files and chats are not touched. */
  resetInterface: () => number;
  copy: (text: string) => Promise<void>;
};

const defaultActions: RecoveryActions = {
  reload: () => window.location.reload(),
  resetInterface: () => clearSpanStorage(),
  copy: async (text) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(text);
    else throw new Error("Clipboard access is unavailable");
  },
};

/**
 * Shown instead of the workbench when it fails to render, and over it when startup does not finish in time. It uses
 * the workbench tokens (the `ide` class) so it is readable in every theme, and depends on nothing that can fail at
 * startup: no stores, no icons, no native calls.
 */
export function RecoveryScreen(props: { reason: RecoveryReason; error?: unknown; overlay?: boolean; actions?: Partial<RecoveryActions> }) {
  const actions = () => ({ ...defaultActions, ...props.actions });
  const [status, setStatus] = createSignal("");
  const theme = readBootTheme() ?? "dark";
  const diagnostics = () =>
    diagnosticsText({
      reason: props.reason,
      error: props.error,
      userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      marks: (() => {
        const timings = collectStartupTimings();
        return { entry: timings.entryEvaluatedMs, shell: timings.shellRenderedMs, session: timings.sessionReadyMs, paint: timings.firstPaintMs };
      })(),
      storageKeys: spanStorageKeyNames(),
    });
  const reset = () => {
    let removed = 0;
    try {
      removed = actions().resetInterface();
    } catch {
      removed = 0;
    }
    setStatus(removed === 1 ? "Cleared 1 saved interface item. Reloading." : `Cleared ${removed} saved interface items. Reloading.`);
    actions().reload();
  };
  const copy = async () => {
    try {
      await actions().copy(diagnostics());
      setStatus("Diagnostics copied.");
    } catch {
      setStatus("Could not copy. Select the text under Details instead.");
    }
  };
  return (
    <div class={`ide theme-${theme} recovery-screen`} classList={{ "recovery-overlay": !!props.overlay }} data-recovery={props.reason}>
      <section class="recovery-card" role="alertdialog" aria-modal={props.overlay ? "true" : undefined} aria-labelledby="recovery-title" aria-describedby="recovery-message">
        <h1 id="recovery-title" class="recovery-title">{props.reason === "error" ? "span could not show its window" : "span is taking too long to start"}</h1>
        <p id="recovery-message" class="recovery-message">
          {props.reason === "error"
            ? "Something in the interface failed while it was loading. Your files, settings and chats are safe."
            : "Startup is slow or has failed. If nothing changes, reload. Your files, settings and chats are safe."}
        </p>
        <p class="recovery-hint">If reloading does not help, reset the interface state. That clears remembered layout and recent picks only, not settings files or chats.</p>
        <div class="recovery-actions">
          <button type="button" class="button primary" onClick={() => actions().reload()}>Reload</button>
          <button type="button" class="button" onClick={reset}>Reset interface state</button>
          <button type="button" class="button" onClick={() => void copy()}>Copy diagnostics</button>
        </div>
        <p class="recovery-status" role="status" aria-live="polite">{status()}</p>
        <details class="recovery-details">
          <summary>Details</summary>
          <Show when={props.error !== undefined}>
            <p class="recovery-error">{errorSummary(props.error)}</p>
          </Show>
          <pre class="recovery-diagnostics">{diagnostics()}</pre>
        </details>
      </section>
    </div>
  );
}
