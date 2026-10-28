import { For, Show } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import type { Brand, Capability, Phase } from "./types";

/** Connection phases: a spinner while active, a check when done. */
export function ConnectingSteps(props: { phases: Phase[] }) {
  return (
    <ol class="sb-phases" aria-label="Connection progress" aria-live="polite">
      <For each={props.phases}>
        {(phase) => (
          <li class={`sb-phase ${phase.state}`} aria-current={phase.state === "active" ? "step" : undefined}>
            <span class="sb-phase-glyph" aria-hidden="true">
              <Show when={phase.state === "active"}><span class="sb-spinner" /></Show>
              <Show when={phase.state === "done"}><Icon name="TickCircle" size={11} class="sb-ok" /></Show>
              <Show when={phase.state === "failed"}><Icon name="CloseCircle" size={11} class="sb-bad" /></Show>
              <Show when={phase.state === "pending"}><span class="sb-dot" /></Show>
            </span>
            <span class="sb-phase-label">{phase.label}</span>
            <Show when={phase.meta}><span class="sb-phase-meta">{phase.meta}</span></Show>
            <span class="sb-visually-hidden">{phase.state}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** Shown once the agent is initialised. Chips come from the capabilities the agent reported. */
export function ReadyCard(props: Brand & { title: string; version?: string; capabilities: Capability[] }) {
  return (
    <section class="sb-card ready" aria-label={`${props.title} is ready`}>
      <div class="sb-card-head">
        <BrandIcon id={props.id} name={props.name ?? props.title} size={14} />
        <span class="sb-card-title">{props.title}</span>
        <span class="sb-flex" />
        <Show when={props.version}><span class="sb-mono dim">{props.version}</span></Show>
      </div>
      <ul class="sb-chips">
        <For each={props.capabilities}>
          {(cap) => (
            <li class="sb-chip" classList={{ off: !cap.supported }}>
              <Show when={cap.supported}><Icon name="TickCircle" size={10} class="sb-ok" /></Show>
              {cap.label}
              <Show when={!cap.supported}><span class="sb-visually-hidden"> (not supported)</span></Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
