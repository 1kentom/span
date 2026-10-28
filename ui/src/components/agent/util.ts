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

/** True when the key event came from a text field the user is typing into. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) return target.value.length > 0;
  return target instanceof HTMLInputElement || (target instanceof HTMLElement && target.isContentEditable);
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
