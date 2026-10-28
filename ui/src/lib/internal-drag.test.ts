// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInternalDrag } from "./internal-drag";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers(); });
function pointer(type: string, x = 0, y = 0, extra: MouseEventInit & { pointerId?: number; isPrimary?: boolean } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra });
  Object.defineProperties(event, { pointerId: { value: extra.pointerId ?? 1 }, isPrimary: { value: extra.isPrimary ?? true } }); return event;
}
function setup() {
  const source = document.createElement("button"); document.body.append(source);
  let captured = false;
  source.setPointerCapture = vi.fn(() => { captured = true; }); source.hasPointerCapture = vi.fn(() => captured); source.releasePointerCapture = vi.fn(() => { captured = false; });
  let valid = true; let target: number | undefined = 2;
  const preview = vi.fn(); const drop = vi.fn();
  const drag = createInternalDrag({ valid: () => valid, targetAt: vi.fn(() => target), preview, drop });
  source.addEventListener("pointerdown", event => drag.start(event, { path: "a.ts", generation: 1 })); disposers.push(drag.dispose);
  const start = (extra = {}) => source.dispatchEvent(pointer("pointerdown", 10, 10, extra));
  const move = (extra = {}) => window.dispatchEvent(pointer("pointermove", 25, 20, extra));
  const up = (extra = {}) => window.dispatchEvent(pointer("pointerup", 30, 30, extra));
  return { source, preview, drop, drag, start, move, up, invalidate: () => { valid = false; }, outside: () => { target = undefined; } };
}
describe("internal pointer dragging", () => {
  it("leaves ordinary clicks and sub-threshold motion alone", () => {
    const view = setup(); const clicked = vi.fn(); view.source.addEventListener("click", clicked);
    view.start(); window.dispatchEvent(pointer("pointermove", 14, 12)); view.up();
    view.source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(clicked).toHaveBeenCalledOnce(); expect(view.drop).not.toHaveBeenCalled(); expect(view.source.setPointerCapture).not.toHaveBeenCalled();
  });
  it("captures above threshold, uses the release modifier, and suppresses only the resulting pointer click", () => {
    const view = setup(); const clicked = vi.fn(); view.source.addEventListener("click", clicked);
    view.start(); view.move(); expect(view.source.setPointerCapture).toHaveBeenCalledWith(1);
    expect(view.preview).toHaveBeenLastCalledWith(expect.objectContaining({ target: 2, x: 25, y: 20, copy: false }));
    view.up({ altKey: true }); expect(view.drop).toHaveBeenCalledWith({ path: "a.ts", generation: 1 }, 2, true);
    view.source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); expect(clicked).not.toHaveBeenCalled();
    view.source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); expect(clicked).toHaveBeenCalledOnce();
    view.start(); view.up(); view.source.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); expect(clicked).toHaveBeenCalledTimes(2);
    expect(document.documentElement.classList.contains("internal-dragging")).toBe(false);
  });
  it.each(["escape", "pointercancel", "blur", "lostcapture", "dispose"])("cancels %s without dropping and removes listeners", kind => {
    const view = setup(); view.start(); view.move();
    if (kind === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    if (kind === "pointercancel") window.dispatchEvent(pointer("pointercancel"));
    if (kind === "blur") window.dispatchEvent(new Event("blur"));
    if (kind === "lostcapture") view.source.dispatchEvent(pointer("lostpointercapture"));
    if (kind === "dispose") view.drag.dispose();
    view.up(); expect(view.drop).not.toHaveBeenCalled(); expect(view.preview).toHaveBeenLastCalledWith(undefined);
    expect(document.documentElement.classList.contains("internal-dragging")).toBe(false);
  });
  it("rejects stale workspace/source state and removed destinations at release", () => {
    const view = setup(); view.start(); view.move(); view.invalidate(); view.up(); expect(view.drop).not.toHaveBeenCalled();
    const next = setup(); next.start(); next.move(); next.outside(); next.up(); expect(next.drop).not.toHaveBeenCalled();
  });
  it("ignores other pointers and non-primary or secondary-button gestures", () => {
    const view = setup(); view.start({ button: 2 }); view.move(); view.up();
    view.start({ isPrimary: false }); view.move(); view.up(); expect(view.drop).not.toHaveBeenCalled();
    view.start(); view.move({ pointerId: 3 }); window.dispatchEvent(pointer("pointercancel", 0, 0, { pointerId: 3 })); view.up({ pointerId: 3 }); expect(view.drop).not.toHaveBeenCalled();
    view.move(); view.up(); expect(view.drop).toHaveBeenCalledOnce();
  });
  it("cancels disconnected sources instead of moving a removed tab", () => {
    const view = setup(); view.start(); view.move(); view.source.remove(); view.up(); expect(view.drop).not.toHaveBeenCalled();
  });
});
