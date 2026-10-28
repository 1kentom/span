import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import Icon from '../Icon';

export interface MenuAction { id: string; label: string; icon: string; danger?: boolean; run: () => void }

/** Overflow menu. Escape closes it and returns focus to the trigger. Arrow keys, Home and End move between items. */
export function ActionsMenu(props: { actions: MenuAction[]; label?: string }) {
  const [open, setOpen] = createSignal(false);
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const items = () => [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.focus(); };
  createEffect(() => {
    if (!open()) return;
    items()[0]?.focus();
    const away = (event: PointerEvent) => { if (!menu?.contains(event.target as Node) && !trigger.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', away, true);
    onCleanup(() => document.removeEventListener('pointerdown', away, true));
  });
  const onKeyDown = (event: KeyboardEvent) => {
    const list = items(); const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); list.at(-1)?.focus(); }
    else if (event.key === 'Tab') close(false);
  };
  return <div class="vw-menu-host">
    <button ref={trigger} type="button" class="vw-btn vw-btn-icon" aria-label={props.label ?? 'More actions'} aria-haspopup="menu" aria-expanded={open()} onClick={() => setOpen(!open())}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open()) { event.preventDefault(); setOpen(true); } else if (event.key === 'Escape' && open()) { event.stopPropagation(); close(); } }}><Icon name="3DotsMore" size={14} /></button>
    <Show when={open()}>
      <div ref={menu} class="vw-menu" role="menu" aria-label={props.label ?? 'More actions'} onKeyDown={onKeyDown}>
        <For each={props.actions}>{action => <button type="button" role="menuitem" class="vw-menu-item" classList={{ 'vw-danger': action.danger }} onClick={() => { close(); action.run(); }}><Icon name={action.icon} size={13} />{action.label}</button>}</For>
      </div>
    </Show>
  </div>;
}
