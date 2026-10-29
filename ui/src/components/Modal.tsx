import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import "../styles/modal.css";

export type ModalProps = {
  label: string;
  class?: string;
  children: JSX.Element;
  onClose: () => void;
  initialFocus?: string | (() => HTMLElement | null | undefined);
  /** Opt-in default action. The caller owns success dismissal and its current intent guard. */
  onSubmit?: () => void | boolean | Promise<void | boolean>;
  onSubmitError?: (error: unknown) => void;
  defaultAction?: string;
  busy?: boolean;
  preventCloseWhileBusy?: boolean;
  allowGlobalShortcut?: (event: KeyboardEvent) => boolean;
};

type OpenModal = { dialog: HTMLDivElement; allows: (event: KeyboardEvent) => boolean };
const openModals: OpenModal[] = [];
const inertOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>();

/** The window shortcut dispatcher can use this before handling its capture-phase event. */
export function modalAllowsGlobalShortcut(event: KeyboardEvent): boolean {
  return openModals.at(-1)?.allows(event) ?? true;
}

function visible(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function Modal(props: ModalProps) {
  let backdrop!: HTMLDivElement;
  let dialog!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal("");
  let submitGeneration = 0;
  let disposed = false;
  let lastFocused: HTMLElement | undefined;
  const busy = () => Boolean(props.busy || submitting());
  const topmost = () => openModals.at(-1)?.dialog === dialog;
  const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex],[contenteditable="true"]')).filter(element => element.tabIndex >= 0 && visible(element));
  const preferredFocus = () => {
    const preferred = typeof props.initialFocus === "string" ? dialog.querySelector<HTMLElement>(props.initialFocus) : props.initialFocus?.();
    const autofocus = dialog.querySelector<HTMLElement>("[autofocus]");
    const target = preferred && dialog.contains(preferred) && visible(preferred) ? preferred : autofocus && visible(autofocus) ? autofocus : focusable()[0];
    (target || dialog).focus();
  };
  const cancel = () => {
    if (busy() && props.preventCloseWhileBusy) return;
    submitGeneration += 1; setSubmitting(false); setError(""); props.onClose();
  };
  const defaultButton = () => dialog.querySelector<HTMLButtonElement>(props.defaultAction || "[data-modal-default]");
  async function submit() {
    if (busy() || !props.onSubmit) return;
    const generation = ++submitGeneration;
    setSubmitting(true); setError("");
    try { await props.onSubmit(); }
    catch (cause) {
      if (!disposed && generation === submitGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause)); props.onSubmitError?.(cause);
      }
    } finally { if (!disposed && generation === submitGeneration) setSubmitting(false); }
  }
  function captureClick(event: MouseEvent) {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || !dialog.contains(button)) return;
    if (button.matches("[data-modal-cancel]")) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (busy() && button.closest(".dialog-actions,[data-modal-actions]")) { event.preventDefault(); event.stopPropagation(); return; }
    if (props.onSubmit && (button === defaultButton() || button.hasAttribute("data-modal-submit"))) { event.preventDefault(); event.stopPropagation(); void submit(); }

  }
  onMount(() => {
    dialog.addEventListener("click", captureClick, true);
    openModals.push({ dialog, allows: event => props.allowGlobalShortcut?.(event) ?? false });
    const owned: HTMLElement[] = [];
    for (let current: HTMLElement | null = backdrop; current?.parentElement; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (!(sibling instanceof HTMLElement) || sibling === current || ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)) continue;
        const owner = inertOwners.get(sibling) || { count: 0, original: sibling.hasAttribute("inert") };
        owner.count += 1; inertOwners.set(sibling, owner); sibling.setAttribute("inert", ""); owned.push(sibling);
      }
      if (current.parentElement === document.body) break;
    }
    const containFocus = (event: FocusEvent) => {
      if (!topmost()) return;
      const target = event.target as HTMLElement | null;
      if (target && dialog.contains(target)) { lastFocused = target; return; }
      if (lastFocused?.isConnected && visible(lastFocused)) lastFocused.focus(); else preferredFocus();
    };
    document.addEventListener("focusin", containFocus, true);
    queueMicrotask(() => { if (!disposed && topmost()) preferredFocus(); });
    onCleanup(() => {
      dialog.removeEventListener("click", captureClick, true);
      document.removeEventListener("focusin", containFocus, true);
      const index = openModals.findIndex(modal => modal.dialog === dialog);
      if (index >= 0) openModals.splice(index, 1);
      for (const element of owned) {
        const owner = inertOwners.get(element); if (!owner) continue;
        owner.count -= 1;
        if (!owner.count) { if (!owner.original) element.removeAttribute("inert"); inertOwners.delete(element); }
      }
      const remaining = openModals.at(-1)?.dialog;
      if (previous?.isConnected && visible(previous) && (!remaining || remaining.contains(previous))) previous.focus();
      else remaining?.querySelector<HTMLElement>("[autofocus],button:not([disabled]),input:not([disabled])")?.focus();
    });
  });
  onCleanup(() => { disposed = true; submitGeneration += 1; });
  return <div ref={backdrop} class="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && topmost()) cancel(); }}><div ref={dialog} class={`modal ${props.class || ""}`} role="dialog" aria-label={props.label} aria-modal="true" aria-busy={busy() || undefined} tabIndex={-1} data-modal-shortcuts="isolated" onKeyDown={event => {
    if (!props.allowGlobalShortcut?.(event)) event.stopPropagation();
    if (event.defaultPrevented || !topmost()) return;
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.key === "Enter" && !event.isComposing && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const target = event.target as Element | null;
      if (target?.closest('textarea,button,a,[contenteditable="true"],form,[role="combobox"],[role="listbox"]')) return;
      const button = defaultButton();
      if (props.onSubmit || button) { event.preventDefault(); if (!busy()) { if (props.onSubmit) void submit(); else if (!button?.disabled) button?.click(); } }
      return;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    const items = focusable(); const first = items[0]; const last = items.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (!dialog.contains(document.activeElement) || document.activeElement === dialog) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>{props.children}<Show when={error()}><div class="modal-submit-error" role="alert">{error()}</div></Show></div></div>;
}
