import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { dropIndex, dropLine, moveAnnouncement, needsClearConfirm } from "../../lib/agent-queue";
import { Icon, MenuIcon } from "../Icon";
import type { QueueItem } from "./types";

type QueuePanelProps = {
  items: QueueItem[];
  /** Short line beside the count, for example "Sends when the agent finishes". */
  note?: string;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
  onClear: () => void;
  /** Moves the row at `from` to index `to`. Without it the rows cannot be reordered. */
  onReorder?: (from: number, to: number) => void;
  /** The row Send now was pressed on and that has not gone out yet. It shows a spinner and the order is locked. */
  pendingId?: string;
  /** Each change of this value starts editing the last message (ArrowUp in an empty composer). */
  editLastToken?: number;
  /** The queue became empty through Remove or Clear here, so focus has nowhere in the panel to go. */
  onEmptied?: () => void;
  /**
   * The queue is not drained on its own: the last turn ended with an error, or the agent reconnected or a new chat
   * started since the messages were queued. Shows a notice and, with `onSendAll`, a one-click Send queued.
   */
  held?: boolean;
  /** Whether Send queued can run now (connected, idle, online). The button shows disabled otherwise. */
  canSendAll?: boolean;
  onSendAll?: () => void;
};

type Drag = { id: string; from: number; startY: number; dy: number; to: number; rects: { top: number; height: number }[] };

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Follow-ups queued on the client while the agent works. */
export function QueuePanel(props: QueuePanelProps) {
  const [editing, setEditing] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [drag, setDrag] = createSignal<Drag>();
  const [announcement, setAnnouncement] = createSignal("");
  let list: HTMLOListElement | undefined;
  let clearButton: HTMLButtonElement | undefined;

  // Rows are keyed by id, so a reorder moves the same elements and focus, hover and the edit input survive it.
  const ids = createMemo(() => props.items.map((item) => item.id), [], { equals: sameIds });
  const count = () => props.items.length;
  const locked = () => Boolean(props.pendingId);
  const row = (id: string) => list?.querySelector<HTMLElement>(`li[data-queue-id="${id}"]`) ?? undefined;
  const focusIn = (id: string, selector: string) => queueMicrotask(() => row(id)?.querySelector<HTMLElement>(selector)?.focus());

  createEffect(() => {
    if (!needsClearConfirm(count())) setConfirming(false);
  });
  createEffect(
    on(
      () => props.editLastToken,
      () => {
        const last = props.items[props.items.length - 1];
        if (last) start(last);
      },
      { defer: true },
    ),
  );

  const start = (item: QueueItem) => {
    setDraft(item.text);
    setEditing(item.id);
  };
  const finishEdit = (id: string) => {
    setEditing(undefined);
    focusIn(id, ".sb-queue-edit");
  };
  const save = (id: string) => {
    const text = draft().trim();
    if (text) props.onEdit(id, text);
    finishEdit(id);
  };

  /** Runs a change and slides every row that moved from its old position to its new one. */
  function flip(change: () => void) {
    const tops = new Map<string, number>();
    list?.querySelectorAll<HTMLElement>("li[data-queue-id]").forEach((el) => tops.set(el.dataset.queueId!, el.getBoundingClientRect().top));
    change();
    if (reducedMotion()) return;
    queueMicrotask(() => {
      list?.querySelectorAll<HTMLElement>("li[data-queue-id]").forEach((el) => {
        const delta = (tops.get(el.dataset.queueId!) ?? 0) - el.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) return;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        el.getBoundingClientRect();
        el.style.transition = "transform 140ms ease";
        el.style.transform = "";
        el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
      });
    });
  }
  const reorder = (from: number, to: number) => {
    flip(() => props.onReorder?.(from, to));
  };

  function beginDrag(event: PointerEvent, id: string) {
    if (event.button !== 0 || locked() || editing() || !props.onReorder || count() < 2 || !list) return;
    const rects = [...list.querySelectorAll<HTMLElement>("li[data-queue-id]")].map((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, height: box.height };
    });
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a nicety: the move and up handlers still run while the pointer stays over the grip.
    }
    event.preventDefault();
    const from = ids().indexOf(id);
    setDrag({ id, from, startY: event.clientY, dy: 0, to: from, rects });
  }
  function moveDrag(event: PointerEvent) {
    const current = drag();
    if (current) setDrag({ ...current, dy: event.clientY - current.startY, to: dropIndex(current.rects, event.clientY, current.from) });
  }
  function endDrag(commit: boolean) {
    const current = drag();
    if (!current) return;
    if (!commit || current.to === current.from) return setDrag(undefined);
    flip(() => {
      setDrag(undefined);
      props.onReorder?.(current.from, current.to);
    });
    setAnnouncement(moveAnnouncement(current.to + 1, count()));
  }
  function gripKey(event: KeyboardEvent, id: string) {
    if (event.key === "Escape" && drag()) {
      event.preventDefault();
      event.stopPropagation();
      setDrag(undefined);
      return;
    }
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    event.stopPropagation();
    const from = ids().indexOf(id);
    const to = from + (event.key === "ArrowUp" ? -1 : 1);
    if (locked() || !props.onReorder || to < 0 || to >= count()) return;
    reorder(from, to);
    setAnnouncement(moveAnnouncement(to + 1, count()));
    focusIn(id, ".sb-queue-grip");
  }
  const line = () => {
    const current = drag();
    return current ? dropLine(current.from, current.to) : undefined;
  };
  const dropMark = (index: number) => {
    const at = line();
    if (at === undefined) return undefined;
    if (at === index) return "before";
    return at === count() && index === count() - 1 ? "after" : undefined;
  };

  function remove(id: string) {
    const at = ids().indexOf(id);
    props.onRemove(id);
    queueMicrotask(() => {
      const left = ids();
      if (left.includes(id)) return;
      if (!left.length) props.onEmptied?.();
      else row(left[Math.min(at, left.length - 1)])?.querySelector<HTMLElement>(".sb-queue-remove")?.focus();
    });
  }
  function clear() {
    if (needsClearConfirm(count())) return setConfirming(true);
    props.onClear();
    props.onEmptied?.();
  }
  const cancelConfirm = () => {
    setConfirming(false);
    queueMicrotask(() => clearButton?.focus());
  };

  return (
    <Show when={count() > 0}>
      <section class="sb-drawer queue" classList={{ held: props.held }} aria-label="Queued messages">
        <div class="sb-queue-head">
          <span class="sb-queue-title">Queued · {count()}</span>
          <span class="sb-sub sb-ellipsis sb-flex">{props.note}</span>
          <Show when={props.held && props.onSendAll}>
            <button
              class="sb-btn ghost accent"
              aria-label={`Send ${count()} queued message${count() === 1 ? "" : "s"}`}
              disabled={props.canSendAll === false}
              onClick={() => props.onSendAll?.()}
            >
              Send queued
            </button>
          </Show>
          <button ref={clearButton} class="sb-btn ghost sb-queue-clear" aria-label="Clear queued messages" onClick={clear}>Clear</button>
        </div>
        <Show when={confirming()}>
          <div
            class="sb-queue-confirm"
            role="group"
            aria-label="Confirm clearing the queue"
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              cancelConfirm();
            }}
          >
            <span class="sb-flex">Clear all {count()}?</span>
            <button class="sb-btn ghost danger" data-confirm="yes" onClick={() => { setConfirming(false); props.onClear(); props.onEmptied?.(); }}>Yes</button>
            <button class="sb-btn ghost" data-confirm="no" ref={(el) => queueMicrotask(() => el.focus())} onClick={cancelConfirm}>No</button>
          </div>
        </Show>
        <Show when={props.held}>
          <p class="sb-sub sb-queue-held" role="status">Not sent: the last turn ended with an error or the agent reconnected.</p>
        </Show>
        <ol class="sb-queue" role="list" ref={list} classList={{ dragging: Boolean(drag()) }}>
          <For each={ids()}>
            {(id) => {
              const item = () => props.items.find((candidate) => candidate.id === id);
              const index = () => ids().indexOf(id);
              const pending = () => props.pendingId === id;
              const lifted = () => (drag()?.id === id ? drag() : undefined);
              return (
                <li
                  class="sb-queue-row"
                  classList={{ dragging: Boolean(lifted()), pending: pending() }}
                  role="listitem"
                  data-queue-id={id}
                  data-drop={dropMark(index())}
                  aria-busy={pending() ? "true" : undefined}
                  style={{ transform: lifted() ? `translateY(${lifted()!.dy}px)` : undefined }}
                >
                  <button
                    class="sb-queue-grip"
                    title="Drag to reorder"
                    aria-label={`Reorder queued message ${index() + 1}: drag, or press Alt with the up or down arrow`}
                    disabled={locked()}
                    onPointerDown={(event) => beginDrag(event, id)}
                    onPointerMove={moveDrag}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                    onKeyDown={(event) => gripKey(event, id)}
                  >
                    <span class="sb-grip-dots" aria-hidden="true" />
                  </button>
                  <span class="sb-queue-num sb-mono">{index() + 1}</span>
                  <Show
                    when={editing() === id}
                    fallback={
                      <>
                        <span class="sb-queue-text sb-ellipsis sb-flex" title={item()?.text}>{item()?.text}</span>
                        <button class="sb-icon-btn sb-queue-edit" title="Edit (up arrow)" aria-label={`Edit queued message ${index() + 1}`} disabled={pending()} onClick={() => item() && start(item()!)}><Icon name="Pencil" size={11} /></button>
                        <button class="sb-icon-btn sb-queue-remove" title="Remove" aria-label={`Remove queued message ${index() + 1}`} onClick={() => remove(id)}><MenuIcon name="cancel" size={11} /></button>
                        <button class="sb-btn ghost accent sb-queue-send" title="Send now: stops the current step" aria-label={`Send queued message ${index() + 1} now`} disabled={pending()} onClick={() => props.onSendNow(id)}>
                          <Show when={pending()}><span class="sb-spinner" aria-hidden="true" /></Show>
                          Send now
                        </button>
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
                          save(id);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          finishEdit(id);
                        }
                      }}
                    />
                    <button class="sb-icon-btn" title="Save" aria-label="Save edit" onClick={() => save(id)}><Icon name="TickCircle" size={12} /></button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
        <div class="sb-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement()}</div>
      </section>
    </Show>
  );
}
