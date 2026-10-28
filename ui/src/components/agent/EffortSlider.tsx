import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon, MenuIcon } from "../Icon";
import type { ConfigOptionView } from "./types";

/**
 * Effort slider for the agent's thought_level option. Every level name, description and the level count come from the
 * agent, in the agent's order. Nothing here names a level.
 *
 * Colour ramp (tokens defined in agent-sidebar.css, all derived from theme tokens with color-mix):
 *   lowest level  --fx-calm   success mixed with dim, a quiet sage
 *   middle        --fx-amber  the warning token
 *   high          --fx-high   the accent token
 *   final level   --fx-peak   solid fallback, plus a peach (--fx-peach) to accent gradient fill with sparkles
 * Levels in between interpolate with color-mix in oklab, so any count from 2 upwards gets a smooth ramp.
 */

export type EffortLevel = { value: string; name: string; description?: string };
export type EffortSliderProps = {
  options: EffortLevel[];
  value: string;
  onChange: (value: string) => void;
  /** The agent's option name, for example "Effort" or "Reasoning". */
  label?: string;
  disabled?: boolean;
  defaultValue?: string;
  modelName?: string;
  onModelClick?: () => void;
  /** Only passed when the agent offers a boolean fast mode option that span can set. */
  fast?: { on: boolean; onToggle: () => void };
  onReset?: () => void;
};

/** Press and hold on a stepper repeats one step every REPEAT_MS. */
export const REPEAT_MS = 250;
/** Keyboard steps settle for this long before the change is sent, so a held key sends one change. */
export const SETTLE_MS = 300;
/** Knob inset plus half the knob, in px. Matches --fx-edge in agent-sidebar.css. */
export const TRACK_EDGE = 12;

export const levelIndex = (options: readonly EffortLevel[], value: string) => options.findIndex((option) => option.value === value);
export const clampIndex = (index: number, count: number) => Math.min(count - 1, Math.max(0, index));
/** Next index after a step. From an unknown value (-1) any step lands on the first level. */
export const stepIndex = (index: number, delta: number, count: number) => (count < 1 ? -1 : index < 0 ? 0 : clampIndex(index + delta, count));
/** Fraction 0 to 1 of a level along the track. A single level sits at the end. */
export const levelPosition = (index: number, count: number) => (index < 0 ? 0 : count > 1 ? clampIndex(index, count) / (count - 1) : 1);
export const isPeak = (index: number, count: number) => count >= 2 && index === count - 1;

/** Target index for a slider key, or undefined when the key is not handled. */
export function keyTarget(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case "ArrowRight": case "ArrowUp": return stepIndex(index, 1, count);
    case "ArrowLeft": case "ArrowDown": return stepIndex(index, -1, count);
    case "PageUp": return stepIndex(index, 2, count);
    case "PageDown": return stepIndex(index, -2, count);
    case "Home": return count ? 0 : undefined;
    case "End": return count ? count - 1 : undefined;
    default: return undefined;
  }
}

/** Snaps a pointer x to the nearest level. `edge` is the distance from each track end to the first and last level. */
export function indexFromPointer(x: number, left: number, width: number, count: number, edge = TRACK_EDGE): number {
  if (count <= 1) return 0;
  const span = Math.max(1, width - 2 * edge);
  const fraction = Math.min(1, Math.max(0, (x - left - edge) / span));
  return Math.round(fraction * (count - 1));
}

const mix = (a: string, b: string, weightOfA: number) => `color-mix(in oklab, ${a} ${Math.round(weightOfA * 100)}%, ${b})`;

/** Ramp colour for a level: calm, then amber at the middle, then accent, and the peak colour at the final level. */
export function effortColor(index: number, count: number): string {
  if (index < 0 || count < 1) return "var(--fx-neutral)";
  if (isPeak(index, count)) return "var(--fx-peak)";
  const t = count > 1 ? levelPosition(index, count) : 0.5;
  if (t <= 0) return "var(--fx-calm)";
  if (t === 0.5) return "var(--fx-amber)";
  return t < 0.5 ? mix("var(--fx-amber)", "var(--fx-calm)", t / 0.5) : mix("var(--fx-high)", "var(--fx-amber)", (t - 0.5) / 0.5);
}

/** Screen reader text for a level: the agent's name, then its description when it has one. */
export const levelText = (level: EffortLevel | undefined) => (level ? (level.description ? `${level.name}, ${level.description}` : level.name) : "Unknown level");

/** A default level is knowable only when the agent names one "default" or "recommended". */
export function defaultLevel(options: readonly EffortLevel[]): string | undefined {
  return options.find((option) => /\b(default|recommended)\b/i.test(option.name))?.value;
}

/** Steps taken after holding a stepper for `heldMs`: one at press, then one per REPEAT_MS. */
export const repeatCount = (heldMs: number) => 1 + Math.max(0, Math.floor(heldMs / REPEAT_MS));

/** Name of the current model choice, when the agent reports a model option. */
export function modelNameOf(options: readonly ConfigOptionView[]): string | undefined {
  const model = options.find((option) => option.category === "model");
  return model?.choices.find((choice) => choice.value === model.currentValue)?.name;
}

/** Moves focus to the selected row of the model list inside `root`. */
export function focusModelRow(root: HTMLElement | undefined, options: readonly ConfigOptionView[]) {
  const name = options.find((option) => option.category === "model")?.name;
  const group = [...(root?.querySelectorAll<HTMLElement>("[role=radiogroup]") ?? [])].find((element) => element.getAttribute("aria-label") === name);
  const row = group?.querySelector<HTMLElement>("[aria-checked='true']") ?? group?.querySelector<HTMLElement>("button:not(:disabled)");
  row?.scrollIntoView?.({ block: "nearest" });
  row?.focus();
}

function useReducedMotion() {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  const [reduced, setReduced] = createSignal(Boolean(query?.matches));
  if (query) {
    const changed = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener?.("change", changed);
    onCleanup(() => query.removeEventListener?.("change", changed));
  }
  return reduced;
}

const SPARKLES = [0, 1, 2, 3, 4];

/**
 * The popover rebuilds its sections whenever the agent reports new config, which replaces this component right after a
 * change it sent. The focused control is remembered across that swap so keyboard and screen reader users keep their
 * place. Only a swap within REFOCUS_MS counts.
 */
const REFOCUS_MS = 1500;
let refocus: { label: string; part: string; at: number } | undefined;

export function EffortSlider(props: EffortSliderProps) {
  const count = () => props.options.length;
  const committed = () => levelIndex(props.options, props.value);
  const [preview, setPreview] = createSignal<number | null>(null);
  const shown = () => preview() ?? committed();
  const level = () => props.options[shown()];
  const peak = () => isPeak(shown(), count());
  const unknown = () => shown() < 0;
  const reduced = useReducedMotion();
  const [dragging, setDragging] = createSignal(false);
  const [announce, setAnnounce] = createSignal("");
  const [pulse, setPulse] = createSignal<{ from: number; to: number; n: number } | null>(null);
  const defaultIndex = createMemo(() => (props.defaultValue === undefined ? -1 : levelIndex(props.options, props.defaultValue)));
  let track: HTMLDivElement | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let hold: ReturnType<typeof setTimeout> | undefined;

  const blocked = () => Boolean(props.disabled) || count() < 2;

  function flush() {
    if (settle !== undefined) clearTimeout(settle);
    settle = undefined;
    const target = preview();
    if (target === null) return;
    const choice = props.options[target];
    if (!choice) return setPreview(null);
    setAnnounce(choice.name);
    if (choice.value !== props.value) props.onChange(choice.value);
  }

  /** Shows `index` at once. With `settleAfter` the change is sent after SETTLE_MS unless more steps follow. */
  function schedule(index: number, settleAfter: boolean) {
    const from = shown();
    if (index !== from) {
      setPreview(index);
      setPulse((last) => ({ from, to: index, n: (last?.n ?? 0) + 1 }));
    }
    if (settle !== undefined) clearTimeout(settle);
    settle = settleAfter ? setTimeout(flush, SETTLE_MS) : undefined;
  }

  // The agent's value is the truth: once it changes, or a pending switch finishes, drop the local preview.
  createEffect(on(() => props.value, () => { if (settle === undefined && !dragging()) setPreview(null); }, { defer: true }));
  createEffect(on(() => Boolean(props.disabled), (now, before) => { if (before && !now && settle === undefined && !dragging()) setPreview(null); }, { defer: true }));

  const pulseClass = (index: number) => {
    const current = pulse();
    if (!current || current.from === current.to) return "";
    const [low, high] = current.from < current.to ? [current.from, current.to] : [current.to, current.from];
    const passed = current.from < current.to ? index > low && index <= high : index >= low && index < high;
    return passed ? (current.n % 2 ? "fx-pulse-a" : "fx-pulse-b") : "";
  };
  const pulseDelay = (index: number) => {
    const current = pulse();
    return current ? `${Math.abs(index - current.from) * 35}ms` : "0ms";
  };

  const pointerIndex = (event: PointerEvent) => {
    const rect = track!.getBoundingClientRect();
    return indexFromPointer(event.clientX, rect.left, rect.width, count());
  };
  const onPointerDown = (event: PointerEvent) => {
    if (blocked() || event.button > 0) return;
    event.preventDefault();
    track?.focus();
    try { track?.setPointerCapture?.(event.pointerId); } catch { /* the pointer may already be gone */ }
    setDragging(true);
    schedule(pointerIndex(event), false);
  };
  const onPointerMove = (event: PointerEvent) => { if (dragging()) schedule(pointerIndex(event), false); };
  const onPointerEnd = () => {
    if (!dragging()) return;
    setDragging(false);
    flush();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = keyTarget(event.key, shown(), count());
    if (target === undefined) return;
    // The popover moves focus with the arrow keys; inside the slider they change the level instead.
    event.preventDefault();
    event.stopPropagation();
    if (!blocked()) schedule(target, true);
  };
  const onKeyUp = () => { if (settle !== undefined) flush(); };

  /** One stepper step. Returns false when already at that end. */
  const step = (delta: number) => {
    if (blocked()) return false;
    const next = stepIndex(shown(), delta, count());
    if (next === shown()) return false;
    schedule(next, false);
    return true;
  };
  const atEnd = (delta: number) => blocked() || (shown() >= 0 && (delta < 0 ? shown() === 0 : shown() === count() - 1));
  const stopHold = () => {
    if (hold === undefined) return;
    clearTimeout(hold);
    hold = undefined;
    flush();
  };
  const startHold = (delta: number) => (event: PointerEvent) => {
    if (event.button > 0 || !step(delta)) return;
    try { (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId); } catch { /* ignore */ }
    const repeat = () => { hold = step(delta) ? setTimeout(repeat, REPEAT_MS) : (flush(), undefined); };
    hold = setTimeout(repeat, REPEAT_MS);
  };
  // Keyboard activation of a stepper (Enter or Space) arrives as a click with no pointer press.
  const keyClick = (delta: number) => (event: MouseEvent) => { if (event.detail === 0 && step(delta)) flush(); };

  const reset = () => {
    if (props.disabled || defaultIndex() < 0 || defaultIndex() === shown()) return;
    if (props.onReset) return props.onReset();
    schedule(defaultIndex(), false);
    flush();
  };

  let root: HTMLDivElement | undefined;
  onMount(() => {
    const pending = refocus;
    if (!pending || pending.label !== (props.label ?? "") || Date.now() - pending.at > REFOCUS_MS) return;
    refocus = undefined;
    root?.querySelector<HTMLElement>(`[data-fx-part="${pending.part}"]`)?.focus();
  });
  onCleanup(() => {
    if (hold !== undefined) clearTimeout(hold);
    if (settle !== undefined) flush();
    const part = root?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fxPart : undefined;
    if (part) refocus = { label: props.label ?? "", part, at: Date.now() };
  });

  // Label cross-fade: each change re-keys the label pair, the old text fades out while the new one slides in.
  const [labelKey, setLabelKey] = createSignal(1);
  const [outgoing, setOutgoing] = createSignal("");
  createEffect(on(shown, (index, before) => {
    if (before === undefined || index === before) return;
    setOutgoing(props.options[before]?.name ?? "");
    setLabelKey((key) => key + 1);
  }));
  const labelName = () => level()?.name ?? (props.value ? props.value : "Not set");

  const header = () => (
    <div class="fx-top">
      <Show when={props.fast}>
        {(fast) => (
          <button data-fx-part="fast" class="fx-icon fx-fast" classList={{ on: fast().on }} aria-label="Fast mode" aria-pressed={fast().on} title="Fast mode" disabled={props.disabled} onClick={() => fast().onToggle()}>
            <Icon name="FlashLinear" size={14} />
          </button>
        )}
      </Show>
      <span class="fx-eyebrow">{props.label ?? "Effort"}</span>
      <span class="sb-flex" />
      <Show when={defaultIndex() >= 0 && count() > 1}>
        <button
          data-fx-part="reset"
          class="fx-icon fx-reset"
          aria-label={`Reset to ${props.options[defaultIndex()]?.name}`}
          title={`Reset to ${props.options[defaultIndex()]?.name}`}
          aria-disabled={props.disabled || defaultIndex() === shown() ? "true" : undefined}
          onClick={reset}
        >
          <MenuIcon name="reset" size={14} />
        </button>
      </Show>
    </div>
  );
  const footer = () => (
    <>
      <Show when={level()?.description}><div class="fx-desc" title={level()?.description}>{level()?.description}</div></Show>
      <Show when={props.modelName}>
        <button data-fx-part="model" class="fx-model" disabled={!props.onModelClick} aria-label={`Model: ${props.modelName}. Go to model list`} title={props.modelName} onClick={() => props.onModelClick?.()}>
          <span class="fx-model-name">{props.modelName}</span>
          <Icon name="arrow-right4" size={10} />
        </button>
      </Show>
    </>
  );

  return (
    <Show when={count() > 0}>
      <Show
        when={count() > 1}
        fallback={
          <div ref={root} class="fx fx-single" classList={{ "fx-reduced": reduced() }}>
            {header()}
            <span class="fx-chip" title={props.options[0].name}>{props.options[0].name}</span>
            {footer()}
          </div>
        }
      >
        <div
          ref={root}
          class="fx"
          classList={{ "fx-reduced": reduced(), "fx-disabled": Boolean(props.disabled), "fx-peak": peak(), "fx-unknown": unknown(), "fx-dragging": dragging() }}
          style={{ "--fx-p": String(levelPosition(shown(), count())), "--fx-c": effortColor(shown(), count()) }}
        >
          {header()}
          <div class="fx-label-wrap" title={labelName()}>
            <Show when={labelKey()} keyed>
              {(key) => (
                <>
                  <Show when={key > 1 && outgoing()}><span class="fx-label fx-label-out" aria-hidden="true">{outgoing()}</span></Show>
                  <span class="fx-label" classList={{ "fx-label-in": key > 1 }}>{labelName()}</span>
                </>
              )}
            </Show>
          </div>
          <div class="fx-row">
            <button data-fx-part="lower" class="fx-step" aria-label="Lower effort" aria-disabled={atEnd(-1) ? "true" : undefined} onPointerDown={startHold(-1)} onPointerUp={stopHold} onPointerCancel={stopHold} onLostPointerCapture={stopHold} onClick={keyClick(-1)}>
              <Icon name="Minus" size={14} />
            </button>
            <div
              ref={track}
              data-fx-part="track"
              class="fx-track"
              role="slider"
              tabindex="0"
              aria-label={props.label ?? "Effort"}
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={count() - 1}
              aria-valuenow={unknown() ? undefined : shown()}
              aria-valuetext={levelText(level())}
              aria-disabled={props.disabled ? "true" : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onBlur={() => { if (settle !== undefined) flush(); }}
            >
              <span class="fx-rail" aria-hidden="true">
                <span class="fx-fill"><span class="fx-fill-peak" /></span>
                <For each={props.options}>
                  {(_, index) => (
                    <span
                      class="fx-tick"
                      classList={{ passed: !unknown() && index() <= shown(), "fx-pulse-a": pulseClass(index()) === "fx-pulse-a", "fx-pulse-b": pulseClass(index()) === "fx-pulse-b" }}
                      style={{ left: `calc(var(--fx-edge) + ${levelPosition(index(), count())} * (100% - 2 * var(--fx-edge)))`, "animation-delay": pulseDelay(index()) }}
                    />
                  )}
                </For>
                <Show when={peak()}>
                  <span class="fx-sparkles">
                    <For each={SPARKLES}>{(n) => <i class={`fx-sparkle fx-sparkle-${n}`} />}</For>
                  </span>
                </Show>
              </span>
              <span class="fx-knob" aria-hidden="true" />
            </div>
            <button data-fx-part="higher" class="fx-step" aria-label="Higher effort" aria-disabled={atEnd(1) ? "true" : undefined} onPointerDown={startHold(1)} onPointerUp={stopHold} onPointerCancel={stopHold} onLostPointerCapture={stopHold} onClick={keyClick(1)}>
              <Icon name="Add" size={14} />
            </button>
          </div>
          {footer()}
          <span class="fx-live" aria-live="polite">{announce()}</span>
        </div>
      </Show>
    </Show>
  );
}
