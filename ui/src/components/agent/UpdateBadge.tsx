import { For, Show, createSignal, onCleanup } from "solid-js";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";
import { splitCode } from "../../lib/agent-hint-text";
import { Icon } from "../Icon";

/** The text of a badge, or undefined when nothing trustworthy can be said. Only a confirmed newer version qualifies. */
export function updateLabel(update?: AgentUpdate): string | undefined {
  if (update?.status !== "updateAvailable" || !update.installedVersion || !update.latestVersion) return undefined;
  return `Update available: ${update.installedVersion} to ${update.latestVersion}`;
}

/** True when the update carries something the panel can show: the documented way to update or a repository link. */
export function hasUpdateDetails(update?: AgentUpdate): boolean {
  return Boolean(updateLabel(update) && (update?.howToUpdate || update?.repository || update?.note));
}

type UpdateBadgeProps = {
  update?: AgentUpdate;
  /** Whether the panel under the row is open. Only used with `onToggle`. */
  expanded?: boolean;
  /** Draws a trailing chevron that opens the panel. Leave it out where the pill sits inside another button. */
  onToggle?: () => void;
};

/** Shows "Update available: 2.0.32 to 2.2.0" for a confirmed update and nothing for unknown, current or missing agents. */
export function UpdateBadge(props: UpdateBadgeProps) {
  return (
    <Show when={updateLabel(props.update)}>
      {(label) => (
        <span class="sb-update-pill">
          <span class="sb-update-badge" role="status" aria-label={`${props.update!.name}. ${label()}`} title={props.onToggle ? undefined : props.update!.howToUpdate || undefined}>
            <Icon name="arrow-up3" size={11} />
            <span>{label()}</span>
          </span>
          <Show when={props.onToggle && hasUpdateDetails(props.update)}>
            <button type="button" class="sb-update-toggle" aria-label={`How to update ${props.update!.name}`} aria-expanded={Boolean(props.expanded)} onClick={() => props.onToggle?.()}>
              <Icon name={props.expanded ? "arrow-up3" : "arrow-down4"} size={10} />
            </button>
          </Show>
        </span>
      )}
    </Show>
  );
}

/** A copy button for one command. The clipboard can refuse; the button then stays as it was. */
export function CopyCommand(props: { command: string; label?: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" class="sb-copy-btn" classList={{ copied: copied() }} aria-label={props.label ?? "Copy command"} onClick={() => void copy()}>
      <Icon name={copied() ? "TickCircle" : "Copy"} size={12} />
      <span>{copied() ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** The expanded panel: the documented way to update, as sent by the backend, with each backticked command copyable. Nothing is invented. */
export function UpdatePanel(props: { update: AgentUpdate; onOpenExternal?: (url: string) => void }) {
  const parts = () => splitCode(props.update.howToUpdate ?? "");
  const hasCommand = () => parts().some((part) => part.code);
  return (
    <div class="sb-update-panel" role="region" aria-label={`How to update ${props.update.name}`}>
      <Show when={props.update.howToUpdate}>
        <h4 class="sb-update-heading">How to update</h4>
        <For each={parts()}>
          {(part) =>
            part.code ? (
              <div class="sb-command">
                <code class="sb-mono">{part.text}</code>
                <CopyCommand command={part.text} />
              </div>
            ) : (
              <p class="sb-fine">{part.text.trim()}</p>
            )
          }
        </For>
      </Show>
      <Show when={props.update.note}>{(note) => <p class="sb-fine">{note()}</p>}</Show>
      <Show when={hasCommand()}>
        <p class="sb-fine sb-update-never">Span never runs this for you</p>
      </Show>
      <Show when={props.update.repository}>
        {(url) => (
          <button type="button" class="sb-link sb-update-link" onClick={() => props.onOpenExternal?.(url())}>
            Release notes
          </button>
        )}
      </Show>
    </div>
  );
}
