// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: undefined as undefined | ((event: { payload: unknown }) => void), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async (handler: (event: { payload: unknown }) => void) => { mocks.handler = handler; return () => { mocks.handler = undefined; }; } }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));

import { droppedRelative, listenNativeDrops, outsideNotice, physicalToLogical, planEditorDrop, pointInside, readDroppedFile, type DroppedPath } from "./native-drop";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const file = (path: string, size = 10): DroppedPath => ({ path, name: path.split("/").pop()!, isDir: false, size });
const folder = (path: string): DroppedPath => ({ path, name: path.split("/").pop()!, isDir: true, size: 0 });
afterEach(() => { mocks.invoke.mockReset(); document.body.replaceChildren(); });

describe("native drop hit testing", () => {
  it("converts Tauri physical positions to CSS pixels with the device pixel ratio", () => {
    expect(physicalToLogical({ x: 2000, y: 600 }, 2)).toEqual({ x: 1000, y: 300 });
    expect(physicalToLogical({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(physicalToLogical({ x: 40, y: 20 }, 0)).toEqual({ x: 40, y: 20 });
    expect(physicalToLogical({ x: 40, y: 20 }, Number.NaN)).toEqual({ x: 40, y: 20 });
  });
  it("tests the converted point against the panel box, and never against a hidden panel", () => {
    const panel = document.createElement("section");
    panel.getBoundingClientRect = () => box(1000, 0, 400, 900);
    // A drop at physical x=2100 on a 2x display lands at CSS x=1050: inside a panel that starts at 1000.
    expect(pointInside(panel, physicalToLogical({ x: 2100, y: 400 }, 2))).toBe(true);
    // Without the conversion the same drop would be read as x=2100 and miss the panel.
    expect(pointInside(panel, physicalToLogical({ x: 1900, y: 400 }, 2))).toBe(false);
    panel.getBoundingClientRect = () => box(0, 0, 0, 0);
    expect(pointInside(panel, { x: 0, y: 0 })).toBe(false);
    expect(pointInside(null, { x: 0, y: 0 })).toBe(false);
  });
  it("maps every Tauri drag-drop payload and converts positions", async () => {
    const seen: unknown[] = [];
    const stop = await listenNativeDrops(drop => seen.push(drop), () => 2);
    mocks.handler!({ payload: { type: "enter", paths: ["/a.png"], position: { x: 200, y: 100 } } });
    mocks.handler!({ payload: { type: "over", position: { x: 400, y: 100 } } });
    mocks.handler!({ payload: { type: "drop", paths: ["/a.png"], position: { x: 400, y: 200 } } });
    mocks.handler!({ payload: { type: "leave" } });
    expect(seen).toEqual([
      { kind: "hover", point: { x: 100, y: 50 } },
      { kind: "hover", point: { x: 200, y: 50 } },
      { kind: "drop", paths: ["/a.png"], point: { x: 200, y: 100 } },
      { kind: "leave" },
    ]);
    stop();
    expect(mocks.handler).toBeUndefined();
  });
  it("reads dropped bytes through the drop-scoped command with the size limit", async () => {
    mocks.invoke.mockResolvedValue(btoa("hi"));
    expect(Array.from(await readDroppedFile("/d/a.txt", 64))).toEqual([104, 105]);
    expect(mocks.invoke).toHaveBeenCalledWith("read_dropped_file", { path: "/d/a.txt", maxBytes: 64 });
  });
});

describe("editor drop plan", () => {
  it("opens exactly the dropped file inside the project and never names a folder to switch to", () => {
    const plan = planEditorDrop([file("/w/proj/src/a.ts")], "/w/proj");
    expect(plan).toEqual({ open: ["src/a.ts"], outside: [], refused: undefined });
    expect(plan.folder).toBeUndefined();
  });
  it("reports files outside the project, or with no project open, instead of opening their folder", () => {
    const outside = file("/elsewhere/notes.md");
    expect(planEditorDrop([outside], "/w/proj")).toEqual({ open: [], outside: [outside], refused: undefined });
    expect(planEditorDrop([outside], undefined)).toEqual({ open: [], outside: [outside], refused: undefined });
    expect(outsideNotice([outside], "/w/proj")).toContain("does not switch projects");
    expect(outsideNotice([outside], undefined)).toContain("no folder is open");
    expect(outsideNotice([], "/w/proj")).toBeUndefined();
  });
  it("offers only a lone folder as a project, and refuses folders mixed with files", () => {
    expect(planEditorDrop([folder("/w/other")], "/w/proj").folder).toBe("/w/other");
    const mixed = planEditorDrop([folder("/w/other"), file("/w/proj/a.ts")], "/w/proj");
    expect(mixed.folder).toBeUndefined();
    expect(mixed.open).toEqual(["a.ts"]);
    expect(mixed.refused).toContain("on its own");
  });
  it("ignores the Windows verbatim prefix of canonical paths", () => {
    expect(droppedRelative("C:\\w\\proj", "\\\\?\\C:\\w\\proj\\src\\a.ts")).toBe("src/a.ts");
    expect(droppedRelative(undefined, "/w/a.ts")).toBeUndefined();
  });
});

describe("internal drag targets", () => {
  it("lets the agent panel take an editor tab released over it, and the editor otherwise", async () => {
    const { createInternalDrag } = await import("./internal-drag");
    const panel = document.createElement("section"); panel.className = "agent-panel"; document.body.append(panel);
    panel.getBoundingClientRect = () => box(1000, 0, 400, 900);
    const { agentPanelElement, internalDropTarget } = await import("./native-drop");
    const overAgent = (x: number, y: number) => pointInside(agentPanelElement(), { x, y });
    const editor = () => ({ group: 1, zone: "center" as const });
    const source = document.createElement("div"); document.body.append(source);
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false); source.releasePointerCapture = vi.fn();
    const drop = vi.fn(); const preview = vi.fn();
    const drag = createInternalDrag<{ path: string }, ReturnType<typeof editor> | "agent">({ valid: () => true, targetAt: (x, y) => internalDropTarget(x, y, overAgent, editor), preview, drop });
    const pointer = (type: string, x: number, y: number) => { const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); return event; };
    source.addEventListener("pointerdown", event => drag.start(event as PointerEvent, { path: "src/a.ts" }));
    source.dispatchEvent(pointer("pointerdown", 500, 100));
    window.dispatchEvent(pointer("pointermove", 1100, 100));
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ target: "agent" }));
    window.dispatchEvent(pointer("pointerup", 1100, 100));
    expect(drop).toHaveBeenCalledWith({ path: "src/a.ts" }, "agent", false);
    source.dispatchEvent(pointer("pointerdown", 500, 100));
    window.dispatchEvent(pointer("pointermove", 700, 100));
    window.dispatchEvent(pointer("pointerup", 700, 100));
    expect(drop).toHaveBeenLastCalledWith({ path: "src/a.ts" }, { group: 1, zone: "center" }, false);
    drag.dispose();
  });
});
