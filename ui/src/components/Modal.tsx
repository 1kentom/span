import { onCleanup, onMount, type JSX } from "solid-js";
export function Modal(props: { label: string; class?: string; children: JSX.Element; onClose: () => void }) {
  let dialog!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => {
    queueMicrotask(() => dialog.querySelector<HTMLElement>("[autofocus], input, textarea, button")?.focus());
  });
  onCleanup(() => previous?.isConnected && previous.focus());
  return <div class="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}><div ref={dialog} class={`modal ${props.class || ""}`} role="dialog" aria-label={props.label} aria-modal="true" onKeyDown={e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); props.onClose(); }
    if (e.key !== "Tab") return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter(el => el.offsetParent !== null);
    const first = items[0]; const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }}>{props.children}</div></div>;
}
