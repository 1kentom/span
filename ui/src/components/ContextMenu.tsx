import { For, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { clampMenu } from "../lib/navigation";
import "../styles/navigation.css";

export type ContextMenuItem = { id: string; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string; separator?: boolean; keepOpen?: boolean };

export function ContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void; label?: string; placement?: "above" }) {
  let menu!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  const [position, setPosition] = createSignal({ x: props.x, y: props.y });
  const rows = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  const close = () => { props.onClose(); };
  createEffect(() => {
    props.items; props.x; props.y;
    queueMicrotask(() => {
      if (!menu?.isConnected) return;
      const bounds = menu.getBoundingClientRect();
      setPosition(clampMenu(props.x, props.placement === "above" ? props.y - bounds.height : props.y, bounds.width, bounds.height));
      if (!menu.contains(document.activeElement)) rows()[0]?.focus();
    });
  });
  onMount(() => {
    rows()[0]?.focus();
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) close(); };
    const reposition = () => close();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("blur", close);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", reposition); window.removeEventListener("blur", close); });
  });
  onCleanup(() => { if (previous?.isConnected) previous.focus(); });
  return <div ref={menu} class="context-menu" role="menu" aria-label={props.label || "File actions"} style={{ left: `${position().x}px`, top: `${position().y}px` }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const items = rows(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); }
  }}><For each={props.items}>{item => <>
    {item.separator && <div class="context-menu-separator" role="separator" />}
    <button type="button" role="menuitem" disabled={item.disabled} onClick={() => { if (!item.disabled) { if (!item.keepOpen) close(); item.onSelect(); } }}><span>{item.label}</span>{item.shortcut && <span class="context-menu-shortcut">{item.shortcut}</span>}</button>
  </>}</For></div>;
}
