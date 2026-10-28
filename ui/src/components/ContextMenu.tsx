import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { clampMenu } from "../lib/navigation";
import Icon, { FileIcon } from "./Icon";
import "../styles/navigation.css";

export type ContextMenuItem = {
  id: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  shortcut?: string;
  separator?: boolean;
  keepOpen?: boolean;
  icon?: string;
  fileIcon?: { path: string; directory?: boolean };
  children?: ContextMenuItem[];
};

type MenuAnchor = { x: number; y: number; right?: number; above?: boolean };
const hoverOpenDelay = 140;
const hoverLeaveDelay = 260;
function documentZoom(): number {
  const value = getComputedStyle(document.documentElement).zoom;
  const parsed = Number.parseFloat(value);
  const scale = value?.endsWith("%") ? parsed / 100 : parsed;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function ContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void; label?: string; placement?: "above" }) {
  let root!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  const [expanded, setExpanded] = createSignal<string[]>([]);
  const menuId = createUniqueId();
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
  let typeahead = "";
  const cancelHover = () => { clearTimeout(openTimer); clearTimeout(leaveTimer); };
  const close = () => { cancelHover(); props.onClose(); };
  const focusFirst = (menu: HTMLElement | undefined) => menu?.querySelector<HTMLButtonElement>(":scope > button:not([disabled])")?.focus();

  const MenuPanel = (panel: { items: ContextMenuItem[]; path: string[]; anchor: MenuAnchor; label: string; parent?: HTMLButtonElement }) => {
    let element!: HTMLDivElement;
    const [position, setPosition] = createSignal({ x: panel.anchor.x, y: panel.anchor.y });
    const [flipped, setFlipped] = createSignal(false);
    const depth = panel.path.length;
    const rows = () => Array.from(element.querySelectorAll<HTMLButtonElement>(":scope > button:not([disabled])"));
    const submenuId = (item: ContextMenuItem) => `${menuId}-${[...panel.path, item.id].map(encodeURIComponent).join("-")}`;
    const active = (item: ContextMenuItem) => expanded()[depth] === item.id;
    const collapse = () => { cancelHover(); setExpanded(path => path.slice(0, Math.max(0, depth - 1))); panel.parent?.focus(); };
    const openSubmenu = (item: ContextMenuItem, button: HTMLButtonElement, focus = false) => {
      if (item.disabled || !item.children?.length) return;
      cancelHover(); setExpanded([...panel.path, item.id]);
      if (focus) queueMicrotask(() => focusFirst(document.getElementById(submenuId(item)) || undefined));
      else button.focus({ preventScroll: true });
    };
    function activate(item: ContextMenuItem, button: HTMLButtonElement) {
      if (item.disabled) return;
      if (item.children?.length) { openSubmenu(item, button, true); return; }
      if (!item.onSelect) return;
      if (!item.keepOpen) close();
      item.onSelect();
    }
    createEffect(() => {
      panel.items; panel.anchor.x; panel.anchor.y;
      queueMicrotask(() => {
        if (!element?.isConnected) return;
        const scale = documentZoom();
        element.style.maxHeight = `${Math.max(0, window.innerHeight - 16) / scale}px`;
        element.style.maxWidth = `${Math.max(0, window.innerWidth - 16) / scale}px`;
        const bounds = element.getBoundingClientRect();
        const right = panel.anchor.right;
        const flip = right !== undefined && right + 3 + bounds.width > window.innerWidth - 8;
        const x = right === undefined ? panel.anchor.x : flip ? panel.anchor.x - bounds.width - 3 : right + 3;
        setFlipped(flip);
        const fitted = clampMenu(x, panel.anchor.above ? panel.anchor.y - bounds.height : panel.anchor.y, bounds.width, bounds.height);
        // Client coordinates and measured bounds are already zoomed; fixed CSS offsets are not.
        setPosition({ x: fitted.x / scale, y: fitted.y / scale });
        if (depth === 0 && !root.contains(document.activeElement)) focusFirst(element);
      });
    });
    return <div ref={node => { element = node; if (depth === 0) root = node; }} id={depth ? `${menuId}-${panel.path.map(encodeURIComponent).join("-")}` : menuId} class={`context-menu ${depth ? "context-submenu" : ""} ${flipped() ? "context-submenu-left" : ""}`} role="menu" aria-label={panel.label} style={{ left: `${position().x}px`, top: `${position().y}px` }} onContextMenu={event => event.preventDefault()} onPointerEnter={() => { clearTimeout(leaveTimer); }} onPointerLeave={() => {
      clearTimeout(leaveTimer); leaveTimer = setTimeout(() => setExpanded(path => path.slice(0, depth)), hoverLeaveDelay);
    }} onKeyDown={event => {
      event.stopPropagation();
      const items = rows(); const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const focused = panel.items.find(item => item.id === (document.activeElement as HTMLElement | null)?.dataset.menuItem);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); cancelHover();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        setExpanded(path => path.slice(0, depth)); items[next]?.focus();
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); if (focused) openSubmenu(focused, document.activeElement as HTMLButtonElement, true);
      } else if (event.key === "ArrowLeft" && depth) { event.preventDefault(); collapse(); }
      else if (event.key === "Escape") { event.preventDefault(); if (depth) collapse(); else close(); }
      else if (event.key === "Tab") { event.preventDefault(); close(); }
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); if (focused) activate(focused, document.activeElement as HTMLButtonElement);
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); clearTimeout(typeaheadTimer); typeahead += event.key.toLocaleLowerCase();
        const prefix = [...typeahead].every(letter => letter === typeahead[0]) ? typeahead[0] : typeahead;
        const next = [...items.slice(index + 1), ...items.slice(0, index + 1)].find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(prefix));
        next?.focus(); typeaheadTimer = setTimeout(() => { typeahead = ""; }, 600);
      }
    }}><For each={panel.items}>{(item, index) => {
      let button!: HTMLButtonElement;
      const anchor = () => { const bounds = button.getBoundingClientRect(); return { x: bounds.left, y: bounds.top - 5, right: bounds.right }; };
      return <>
        <Show when={item.separator && index() > 0}><div class="context-menu-separator" role="separator" /></Show>
        <button ref={button} type="button" role="menuitem" data-menu-item={item.id} disabled={item.disabled} aria-disabled={item.disabled || undefined} title={item.disabled ? item.disabledReason : undefined} aria-haspopup={item.children?.length ? "menu" : undefined} aria-expanded={item.children?.length ? active(item) : undefined} aria-controls={item.children?.length ? submenuId(item) : undefined} tabIndex={-1} class={active(item) ? "context-menu-open" : ""} onPointerEnter={event => {
          clearTimeout(openTimer); clearTimeout(leaveTimer);
          if (item.disabled) return;
          const target = event.currentTarget;
          if (item.children?.length) openTimer = setTimeout(() => openSubmenu(item, target), hoverOpenDelay);
          else leaveTimer = setTimeout(() => { setExpanded(path => path.slice(0, depth)); target.focus({ preventScroll: true }); }, hoverLeaveDelay);
        }} onClick={() => activate(item, button)}><span class="context-menu-icon" aria-hidden="true"><Show when={item.fileIcon} fallback={<Show when={item.icon}><Icon name={item.icon!} size={15} /></Show>}>{file => <FileIcon path={file().path} directory={file().directory} />}</Show></span><span class="context-menu-label">{item.label}</span><Show when={item.shortcut}><span class="context-menu-shortcut">{item.shortcut}</span></Show><span class="context-menu-chevron"><Show when={item.children?.length}><Icon name="arrow-right4" size={12} /></Show></span></button>
        <Show when={item.children?.length && active(item)}><MenuPanel items={item.children!} path={[...panel.path, item.id]} anchor={anchor()} label={item.label} parent={button} /></Show>
      </>;
    }}</For></div>;
  };
  onMount(() => {
    focusFirst(root);
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close); window.addEventListener("blur", close);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", close); window.removeEventListener("blur", close); });
  });
  onCleanup(() => { cancelHover(); clearTimeout(typeaheadTimer); if (previous?.isConnected) previous.focus(); });
  return <MenuPanel items={props.items} path={[]} anchor={{ x: props.x, y: props.y, above: props.placement === "above" }} label={props.label || "File actions"} />;
}
