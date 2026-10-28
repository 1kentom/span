import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { SlashGroup, SlashItem } from "./types";

type SlashPopoverProps = {
  groups: SlashGroup[];
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
};

/**
 * Command list for the composer. The composer keeps focus, so this listens on the window for
 * ArrowUp, ArrowDown, Enter, Tab and Escape while it is open.
 */
export function SlashPopover(props: SlashPopoverProps) {
  const flat = createMemo(() => props.groups.flatMap((group) => group.items));
  const [active, setActive] = createSignal(0);
  createEffect(on(flat, () => setActive(0)));
  createEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const count = flat().length;
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      } else if (!count) {
        return;
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((active() + 1) % count);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((active() - 1 + count) % count);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        props.onSelect(flat()[active()]);
      }
    };
    window.addEventListener("keydown", keyboard, true);
    onCleanup(() => window.removeEventListener("keydown", keyboard, true));
  });
  createEffect(() => {
    active();
    queueMicrotask(() => document.querySelector(".sb-slash [aria-selected='true']")?.scrollIntoView?.({ block: "nearest" }));
  });
  const starts = createMemo(() => {
    let total = 0;
    return props.groups.map((group) => {
      const start = total;
      total += group.items.length;
      return start;
    });
  });
  return (
    <div class="sb-popover sb-slash" role="listbox" aria-label="Commands">
      <Show when={flat().length} fallback={<div class="sb-sub pad">No matching commands</div>}>
        <For each={props.groups}>
          {(group, groupIndex) => {
            const start = () => starts()[groupIndex()] ?? 0;
            return (
              <Show when={group.items.length}>
                <div role="group" aria-label={group.label}>
                  <div class="sb-eyebrow">{group.label}</div>
                  <For each={group.items}>
                    {(item, index) => (
                      <div
                        class="sb-slash-item"
                        role="option"
                        id={`sb-slash-${group.label}-${item.name}`}
                        aria-selected={active() === start() + index()}
                        onMouseEnter={() => setActive(start() + index())}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => props.onSelect(item)}
                      >
                        <span class="sb-mono name">{item.name}</span>
                        <Show when={item.hint}><span class="sb-mono dim">{item.hint}</span></Show>
                        <span class="sb-slash-desc">{item.description}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
