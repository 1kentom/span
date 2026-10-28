import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import Icon from '../Icon';

export interface ModeOption<T extends string> { id: T; label: string; icon?: string; tip?: string }

/**
 * Segmented toggle group with a sliding thumb (design: source bar mode switch, image background switch).
 * Buttons carry aria-pressed. Left and Right arrows move between options and select them.
 * The thumb only animates when motion is allowed (see viewer.css).
 */
export function ModeSwitch<T extends string>(props: { label: string; options: ModeOption<T>[]; value: T | null; onChange: (value: T) => void; icons?: boolean; class?: string }) {
  let group!: HTMLDivElement;
  const [thumb, setThumb] = createSignal({ x: 0, width: 0 });
  const measure = () => {
    const active = group?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    setThumb(active ? { x: active.offsetLeft, width: active.offsetWidth } : { x: 0, width: 0 });
  };
  createEffect(() => { props.value; props.options.length; queueMicrotask(measure); });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(measure);
    queueMicrotask(() => group && observer.observe(group));
    onCleanup(() => observer.disconnect());
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = props.options.findIndex(option => option.id === props.value);
    const next = props.options[(Math.max(0, at) + (event.key === 'ArrowRight' ? 1 : -1) + props.options.length) % props.options.length];
    event.preventDefault();
    props.onChange(next.id);
    queueMicrotask(() => group.querySelector<HTMLButtonElement>(`[data-mode="${next.id}"]`)?.focus());
  };
  return <div ref={group} class={`vw-modes ${props.icons ? 'vw-modes-icons' : ''} ${props.class ?? ''}`} role="group" aria-label={props.label} data-measured={thumb().width > 0} onKeyDown={onKeyDown}>
    <span class="vw-modes-thumb" aria-hidden="true" style={{ transform: `translateX(${thumb().x}px)`, width: `${thumb().width}px` }} />
    <For each={props.options}>{option => <button type="button" class="vw-mode" data-mode={option.id} aria-pressed={props.value === option.id} aria-label={props.icons ? option.label : undefined}
      title={option.tip ?? option.label} onClick={() => props.onChange(option.id)}>
      <Show when={props.icons && option.icon} fallback={option.label}><Icon name={option.icon!} size={14} /><span class="vw-sr">{option.label}</span></Show>
    </button>}</For>
  </div>;
}
