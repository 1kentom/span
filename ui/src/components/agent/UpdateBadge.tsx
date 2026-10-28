import { Show } from "solid-js";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";

/** The text of a badge, or undefined when nothing trustworthy can be said. Only a confirmed newer version qualifies. */
export function updateLabel(update?: AgentUpdate): string | undefined {
  if (update?.status !== "updateAvailable" || !update.installedVersion || !update.latestVersion) return undefined;
  return `Update available: ${update.installedVersion} to ${update.latestVersion}`;
}

/** Shows "Update available: 2.0.32 to 2.2.0" for a confirmed update and nothing for unknown, current or missing agents. The title carries the documented way to update, as text. */
export function UpdateBadge(props: { update?: AgentUpdate }) {
  return (
    <Show when={updateLabel(props.update)}>
      {(label) => <span class="sb-update-badge" role="status" aria-label={`${props.update!.name}. ${label()}`} title={props.update!.howToUpdate || undefined}>{label()}</span>}
    </Show>
  );
}
