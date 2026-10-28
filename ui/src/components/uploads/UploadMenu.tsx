import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { clampMenu } from '../../lib/navigation';
import Icon from '../Icon';
import type { MenuItem } from './upload-model';
import '../../styles/uploads.css';

const hoverDelay = 140;

/**
 * Context menu for uploads and tabs (design: header with the file, items with shortcuts, Open with submenu).
 * Escape and an outside click close it and focus returns to where it was. Arrow keys, Home and End move,
 * Right or Enter opens the submenu, Left or Escape closes it. Every entry is a real action (see upload-model).
 */
export function UploadMenu(props: { items: MenuItem[]; x: number; y: number; label: string; title?: string; icon?: JSX.Element; onClose: () => void }) {
  const previous = document.activeElement as HTMLElement | null;
  let root!: HTMLDivElement;
  let closed = false;
  const close = () => { if (closed) return; closed = true; props.onClose(); };
  onCleanup(() => { if (previous?.isConnected) previous.focus(); });
  onMount(() => {
    const away = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', close); window.addEventListener('resize', close);
    onCleanup(() => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('blur', close); window.removeEventListener('resize', close); });
  });
  return <div ref={root} class="up-menu-layer" onContextMenu={event => event.preventDefault()}>
    <Panel items={props.items} x={props.x} y={props.y} label={props.label} title={props.title} icon={props.icon} onClose={close} root />
  </div>;
}

function Panel(props: { items: MenuItem[]; x: number; y: number; label: string; title?: string; icon?: JSX.Element; onClose: () => void; root?: boolean; onBack?: () => void; flipFrom?: number }) {
  let element!: HTMLDivElement;
  const [position, setPosition] = createSignal({ x: props.x, y: props.y });
  const [open, setOpen] = createSignal<{ id: string; x: number; y: number; left: number } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const rows = () => [...element.querySelectorAll<HTMLButtonElement>(':scope > .up-menu-list > button:not(:disabled)')];
  onMount(() => {
    const bounds = element.getBoundingClientRect();
    let x = props.x;
    if (props.flipFrom !== undefined && x + bounds.width > window.innerWidth - 8) x = props.flipFrom - bounds.width - 4;
    setPosition(clampMenu(x, props.y, bounds.width, bounds.height));
    rows()[0]?.focus();
  });
  const openSub = (item: MenuItem, button: HTMLButtonElement, focus: boolean) => {
    const bounds = button.getBoundingClientRect();
    setOpen({ id: item.id, x: bounds.right + 4, y: bounds.top - 6, left: bounds.left });
    if (!focus) button.focus({ preventScroll: true });
  };
  const activate = (item: MenuItem, button: HTMLButtonElement) => {
    if (item.disabled) return;
    if (item.children?.length) { openSub(item, button, true); return; }
    props.onClose();
    item.run?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    const list = rows(); const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const item = props.items.find(entry => entry.id === (document.activeElement as HTMLElement | null)?.dataset.item);
    const move = (index: number) => { event.preventDefault(); setOpen(null); list[(index + list.length) % list.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'ArrowRight' && item?.children?.length) { event.preventDefault(); openSub(item, document.activeElement as HTMLButtonElement, true); }
    else if ((event.key === 'ArrowLeft' || event.key === 'Escape') && props.onBack) { event.preventDefault(); props.onBack(); }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); props.onClose(); }
    else if ((event.key === 'Enter' || event.key === ' ') && item) { event.preventDefault(); activate(item, document.activeElement as HTMLButtonElement); }
  };
  return <div ref={element} class="up-menu" classList={{ 'up-submenu': !props.root }} role="menu" aria-label={props.label} style={{ left: `${position().x}px`, top: `${position().y}px` }} onKeyDown={onKeyDown}>
    <Show when={props.title}><div class="up-menu-title" aria-hidden="true">{props.icon}<span>{props.title}</span></div></Show>
    <div class="up-menu-list">
      <For each={props.items}>{item => {
        let button!: HTMLButtonElement;
        return <>
          <Show when={item.separatorBefore}><div class="up-menu-separator" role="separator" /></Show>
          <button ref={button} type="button" role={item.checked !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={item.checked !== undefined ? item.checked : undefined}
            class="up-menu-item" classList={{ 'up-danger': item.danger, 'up-menu-open': open()?.id === item.id }} data-item={item.id} tabIndex={-1} disabled={item.disabled}
            aria-haspopup={item.children?.length ? 'menu' : undefined} aria-expanded={item.children?.length ? open()?.id === item.id : undefined}
            onPointerEnter={() => { clearTimeout(timer); if (item.children?.length) timer = setTimeout(() => openSub(item, button, false), hoverDelay); else if (open()) timer = setTimeout(() => setOpen(null), hoverDelay); }}
            onClick={() => activate(item, button)}>
            <span class="up-menu-icon"><Show when={item.icon}><Icon name={item.icon!} size={13} /></Show></span>
            <span class="up-menu-label">{item.label}</span>
            <Show when={item.shortcut}><span class="up-menu-key">{item.shortcut}</span></Show>
            <Show when={item.checked}><Icon name="Check" size={12} class="up-menu-tick" /></Show>
            <Show when={item.children?.length}><Icon name="arrow-right4" size={8} class="up-menu-chevron" /></Show>
          </button>
          <Show when={open()?.id === item.id && item.children}>{children => <Panel items={children()} x={open()!.x} y={open()!.y} flipFrom={open()!.left} label={item.label} onClose={props.onClose} onBack={() => { setOpen(null); button.focus(); }} />}</Show>
        </>;
      }}</For>
    </div>
  </div>;
}
