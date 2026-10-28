/** Internal pointer gestures stay independent of the OS file-drop handler. */
export type InternalDragState<T> = { item: T; target?: number; x: number; y: number; copy: boolean };
export function createInternalDrag<T>(options: {
  valid: (item: T) => boolean;
  targetAt: (x: number, y: number) => number | undefined;
  preview: (state: InternalDragState<T> | undefined) => void;
  drop: (item: T, target: number, copy: boolean) => void;
  window?: Window;
}) {
  const host = options.window ?? window;
  let gesture: { item: T; source: HTMLElement; pointer: number; x: number; y: number; dragging: boolean } | undefined;
  const stopClick = (event: MouseEvent) => { if (event.detail) { event.preventDefault(); event.stopImmediatePropagation(); } };
  function suppressClick() {
    host.addEventListener("click", stopClick, true);
    host.addEventListener("pointerdown", restoreClicks, true);
  }
  function restoreClicks() { host.removeEventListener("click", stopClick, true); host.removeEventListener("pointerdown", restoreClicks, true); }
  function cancel() {
    const prior = gesture; gesture = undefined;
    host.removeEventListener("pointermove", move, true); host.removeEventListener("pointerup", up, true);
    host.removeEventListener("pointercancel", canceled, true); host.removeEventListener("keydown", keyboard, true);
    host.removeEventListener("blur", canceled); prior?.source.removeEventListener("lostpointercapture", canceled);
    if (prior?.source.hasPointerCapture?.(prior.pointer)) prior.source.releasePointerCapture(prior.pointer);
    host.document.documentElement.classList.remove("internal-dragging");
    options.preview(undefined);
  }
  function canceled(event?: Event) {
    if (event && "pointerId" in event && event.pointerId !== gesture?.pointer) return;
    if (gesture?.dragging) suppressClick(); cancel();
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape" && gesture) { event.preventDefault(); event.stopImmediatePropagation(); canceled(); }
  }
  function move(event: PointerEvent) {
    const current = gesture;
    if (!current || event.pointerId !== current.pointer) return;
    if (!current.source.isConnected || !options.valid(current.item)) { canceled(); return; }
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) return;
      current.dragging = true;
      try { current.source.setPointerCapture(event.pointerId); } catch { /* Window listeners still handle pointers when capture is unavailable. */ }
      host.document.documentElement.classList.add("internal-dragging");
    }
    event.preventDefault();
    options.preview({ item: current.item, target: options.targetAt(event.clientX, event.clientY), x: event.clientX, y: event.clientY, copy: event.altKey });
  }
  function up(event: PointerEvent) {
    const current = gesture;
    if (!current || event.pointerId !== current.pointer) return;
    const target = current.dragging && current.source.isConnected && options.valid(current.item) ? options.targetAt(event.clientX, event.clientY) : undefined;
    if (current.dragging) { event.preventDefault(); suppressClick(); }
    cancel();
    if (target !== undefined) options.drop(current.item, target, event.altKey);
  }
  return {
    start(event: PointerEvent, item: T) {
      if (event.button !== 0 || event.isPrimary === false || !options.valid(item)) return;
      const source = event.currentTarget;
      if (!(source instanceof HTMLElement)) return;
      cancel();
      gesture = { item, source, pointer: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      source.addEventListener("lostpointercapture", canceled);
      host.addEventListener("pointermove", move, { capture: true, passive: false }); host.addEventListener("pointerup", up, true);
      host.addEventListener("pointercancel", canceled, true); host.addEventListener("keydown", keyboard, true); host.addEventListener("blur", canceled);
    },
    cancel: canceled,
    dispose() { cancel(); restoreClicks(); },
  };
}
