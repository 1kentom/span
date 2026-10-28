import { For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon";
import type { QueueItem } from "./types";

type QueuePanelProps = {
  items: QueueItem[];
  /** Short note beside the count, for example "sent when the agent is idle". */
  note?: string;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onClear: () => void;
  /**
   * The queue is not drained on its own: the last turn ended with an error, or the agent reconnected or a new chat
   * started since the messages were queued. Shows a notice and, with `onSendAll`, a one-click Send queued.
   */
  held?: boolean;
  /** Whether Send queued can run now (connected, idle, online). The button shows disabled otherwise. */
  canSendAll?: boolean;
  onSendAll?: () => void;
};

/** Follow-ups queued on the client while the agent works. */
export function QueuePanel(props: QueuePanelProps) {
  const [editing, setEditing] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const start = (item: QueueItem) => {
    setDraft(item.text);
    setEditing(item.id);
  };
  const save = (id: string) => {
    const text = draft().trim();
    setEditing(undefined);
    if (text) props.onEdit(id, text);
  };
  return (
    <section class="sb-drawer queue" aria-label="Queued messages">
      <div class="sb-queue-head">
        <span class="strong">{props.items.length} queued</span>
        <span class="sb-sub sb-ellipsis sb-flex">{props.note}</span>
        <Show when={props.held && props.onSendAll}>
          <button
            class="sb-btn ghost accent"
            aria-label={`Send ${props.items.length} queued message${props.items.length === 1 ? "" : "s"}`}
            disabled={props.canSendAll === false}
            onClick={() => props.onSendAll?.()}
          >
            Send queued
          </button>
        </Show>
        <button class="sb-btn ghost" onClick={props.onClear}>Clear</button>
      </div>
      <Show when={props.held}>
        <p class="sb-sub sb-queue-held" role="status">Not sent: the last turn ended with an error or the agent reconnected.</p>
      </Show>
      <ol class="sb-queue">
        <For each={props.items}>
          {(item, index) => (
            <li class="sb-queue-row">
              <span class="sb-mono dim">{index() + 1}</span>
              <Show
                when={editing() === item.id}
                fallback={
                  <>
                    <span class="sb-ellipsis sb-flex" title={item.text}>{item.text}</span>
                    <button class="sb-icon-btn" aria-label={`Edit queued message ${index() + 1}`} onClick={() => start(item)}><Icon name="Edit2" size={11} /></button>
                    <button class="sb-icon-btn" aria-label={`Remove queued message ${index() + 1}`} onClick={() => props.onRemove(item.id)}><Icon name="CloseCircle" size={11} /></button>
                    <button class="sb-btn ghost accent" title="Stops the current step" aria-label={`Send queued message ${index() + 1} now`} onClick={() => props.onSendNow(item.id)}>Send now</button>
                  </>
                }
              >
                <input
                  class="sb-input sb-flex"
                  aria-label={`Edit queued message ${index() + 1}`}
                  value={draft()}
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      save(item.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(undefined);
                    }
                  }}
                />
                <button class="sb-icon-btn" aria-label="Save edit" onClick={() => save(item.id)}><Icon name="TickCircle" size={12} /></button>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}
