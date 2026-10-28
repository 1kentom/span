import { createEffect, onCleanup } from "solid-js";

/** Calls `handler` on Escape while mounted. Capture phase so popovers win over editor shortcuts. */
export function useEscape(handler: () => void, active: () => boolean = () => true) {
  createEffect(() => {
    if (!active()) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", keyboard, true);
    onCleanup(() => window.removeEventListener("keydown", keyboard, true));
  });
}

/** True when the key event came from a text field, empty or not. An empty composer is still a place the user types. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** True while a modal dialog (for example the attachment viewer) is open over the page. */
export const modalOpen = () => typeof document !== "undefined" && document.querySelector('[aria-modal="true"]') !== null;

/**
 * Whether a dock may act on this key. Only keys pressed with focus inside `dock` count, so typing in the composer,
 * the editor or a dialog never answers a request. Repeats, IME composition, handled events, modifier combos (Shift is
 * allowed for letters, so a capital Y still counts) and keys typed into a text field inside the dock are ignored.
 */
export function dockKey(event: KeyboardEvent, dock: HTMLElement | undefined): boolean {
  if (!dock || event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.shiftKey && !/^[a-z]$/i.test(event.key)) return false;
  const target = event.target;
  if (!(target instanceof Node) || !dock.contains(target)) return false;
  if (isTyping(event) || modalOpen()) return false;
  return true;
}

/** Moves focus between the enabled buttons of a container with the arrow keys. */
export function arrowFocus(event: KeyboardEvent, container: HTMLElement | undefined, selector = "button:not(:disabled)") {
  if (!container || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
  const list = [...container.querySelectorAll<HTMLElement>(selector)];
  const current = list.indexOf(event.target as HTMLElement);
  if (!list.length) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  list[current < 0 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length].focus();
}

export const percent = (used: number, size: number) =>
  size > 0 ? Math.min(100, Math.max(0, Math.round((used / size) * 100))) : 0;
