import { For, Show, createSignal } from "solid-js";
import { Icon } from "../Icon";
import type { PlanItem } from "./types";

const STATUS_LABEL = { pending: "pending", in_progress: "in progress", completed: "done" } as const;

/** Collapsible plan above the composer. Entries come from the agent's plan updates. */
export function PlanDrawer(props: { items: PlanItem[]; defaultOpen?: boolean }) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  const done = () => props.items.filter((item) => item.status === "completed").length;
  const current = () => props.items.find((item) => item.status === "in_progress") ?? props.items.find((item) => item.status !== "completed");
  return (
    <section class="sb-drawer" aria-label="Plan">
      <button class="sb-drawer-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Icon name="TaskSquare" size={13} />
        <span class="sb-ellipsis sb-flex strong">{current()?.text ?? "Plan complete"}</span>
        <span class="sb-mono dim">{done()}/{props.items.length}</span>
        <Icon name={open() ? "arrow-down4" : "arrow-up3"} size={10} />
      </button>
      <Show when={open()}>
        <ul class="sb-plan">
          <For each={props.items}>
            {(item) => (
              <li class={`sb-plan-item ${item.status}`}>
                <span class="sb-plan-glyph" aria-hidden="true">
                  <Show when={item.status === "completed"}><Icon name="TickCircle" size={11} class="sb-ok" /></Show>
                  <Show when={item.status === "in_progress"}><span class="sb-spinner" /></Show>
                  <Show when={item.status === "pending"}><span class="sb-dot" /></Show>
                </span>
                <span class="sb-plan-text">{item.text}</span>
                <span class="sb-visually-hidden">{STATUS_LABEL[item.status]}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
