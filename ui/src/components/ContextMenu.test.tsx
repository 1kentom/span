// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ContextMenu } from "./ContextMenu";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { await Promise.resolve(); await Promise.resolve(); }
const key = (element: Element, value: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));

describe("context menu", () => {
  it("skips unavailable actions, supports navigation and executes real callbacks", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const copy = vi.fn(); const save = vi.fn(); const close = vi.fn();
    disposers.push(render(() => <ContextMenu x={10} y={10} onClose={close} items={[
      { id: "copy", label: "Copy path", onSelect: copy }, { id: "disabled", label: "Unavailable", disabled: true, onSelect: vi.fn() }, { id: "save", label: "Save file", onSelect: save },
    ]} />, root)); await settle();
    const items = root.querySelectorAll<HTMLButtonElement>("button");
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "ArrowDown"); expect(document.activeElement).toBe(items[2]);
    key(items[2], "Home"); expect(document.activeElement).toBe(items[0]);
    key(items[0], "End"); expect(document.activeElement).toBe(items[2]);
    items[2].click(); expect(save).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(copy).not.toHaveBeenCalled();
  });
  it("dismisses with Escape and restores the invoking element focus", async () => {
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => { const [open, setOpen] = createSignal(true); return <Show when={open()}><ContextMenu x={10} y={10} items={[{ id: "copy", label: "Copy path", onSelect: vi.fn() }]} onClose={() => setOpen(false)} /></Show>; }, root));
    await settle(); key(root.querySelector("button")!, "Escape"); await settle();
    expect(root.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it("keeps a folder menu open when browsing its children", async () => {
    const root = document.createElement("div"); document.body.append(root); const browse = vi.fn(); const close = vi.fn();
    disposers.push(render(() => <ContextMenu x={10} y={10} onClose={close} items={[{ id: "folder", label: "public/", keepOpen: true, onSelect: browse }]} />, root));
    await settle(); root.querySelector<HTMLButtonElement>("button")!.click(); expect(browse).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  });
});

describe("nested context menus", () => {
  it("opens submenus with Right and Enter, returns with Left and Escape, and invokes one real command", async () => {
    const root = document.createElement("div"); document.body.append(root); const copy = vi.fn(); const close = vi.fn();
    disposers.push(render(() => <ContextMenu x={10} y={10} onClose={close} items={[
      { id: "open", label: "Open", icon: "DocumentText", onSelect: vi.fn() },
      { id: "copy", label: "Copy Path", separator: true, children: [
        { id: "relative", label: "Relative path", shortcut: "⌘C", icon: "Copy", onSelect: copy },
        { id: "more", label: "More", children: [{ id: "name", label: "Filename", onSelect: vi.fn() }] },
      ] },
    ]} />, root)); await settle();
    const menu = root.querySelector<HTMLElement>('[role="menu"]')!; const parent = menu.querySelectorAll<HTMLButtonElement>(":scope > button")[1];
    key(document.activeElement!, "End"); key(parent, "ArrowRight"); await settle();
    expect(parent.getAttribute("aria-expanded")).toBe("true"); expect(parent.querySelector('.icon')?.getAttribute("style")).toContain("arrow-right4");
    expect(document.activeElement?.textContent).toContain("Relative path");
    key(document.activeElement!, "End"); key(document.activeElement!, "Enter"); await settle(); expect(document.activeElement?.textContent).toBe("Filename");
    key(document.activeElement!, "ArrowLeft"); await settle(); expect(document.activeElement?.textContent).toContain("More"); expect(root.querySelectorAll('[role="menu"]')).toHaveLength(2);
    key(document.activeElement!, "Escape"); await settle(); expect(document.activeElement).toBe(parent); expect(root.querySelectorAll('[role="menu"]')).toHaveLength(1); expect(close).not.toHaveBeenCalled();
    key(parent, "Enter"); await settle(); key(document.activeElement!, "Enter"); expect(copy).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("fits submenus by flipping left and clamping vertically near a viewport edge", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches('[role="menu"]')) return { x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 180, width: 240, height: 180, toJSON: () => ({}) };
      return { x: 760, y: 740, left: 760, top: 740, right: 1000, bottom: 768, width: 240, height: 28, toJSON: () => ({}) };
    });
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <ContextMenu x={990} y={760} onClose={vi.fn()} items={[{ id: "copy", label: "Copy Path", children: [{ id: "relative", label: "Relative path", onSelect: vi.fn() }] }]} />, root)); await settle();
    key(document.activeElement!, "ArrowRight"); await settle(); const submenu = root.querySelector<HTMLElement>(".context-submenu")!;
    expect(submenu.classList.contains("context-submenu-left")).toBe(true); expect(submenu.style.left).toBe("517px"); expect(parseInt(submenu.style.top)).toBeLessThanOrEqual(window.innerHeight - 188);
    bounds.mockRestore();
  });
  it("allows pointer travel through the submenu gap without closing it", async () => {
    vi.useFakeTimers(); const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <ContextMenu x={10} y={10} onClose={vi.fn()} items={[{ id: "copy", label: "Copy Path", children: [{ id: "relative", label: "Relative path", onSelect: vi.fn() }] }]} />, root)); await settle();
    root.querySelector("button")!.dispatchEvent(new Event("pointerenter")); await vi.advanceTimersByTimeAsync(140); await settle();
    const menu = root.querySelector<HTMLElement>('[role="menu"]')!; const submenu = root.querySelector<HTMLElement>(".context-submenu")!; expect(submenu).not.toBeNull();
    menu.dispatchEvent(new Event("pointerleave")); await vi.advanceTimersByTimeAsync(120); submenu.dispatchEvent(new Event("pointerenter")); await vi.advanceTimersByTimeAsync(300);
    expect(root.querySelector(".context-submenu")).not.toBeNull();
    menu.dispatchEvent(new Event("pointerleave")); await vi.advanceTimersByTimeAsync(260); expect(root.querySelector(".context-submenu")).toBeNull(); vi.useRealTimers();
  });
  it("uses typeahead while disabled commands remain inert", async () => {
    const root = document.createElement("div"); document.body.append(root); const unavailable = vi.fn();
    disposers.push(render(() => <ContextMenu x={10} y={10} onClose={vi.fn()} items={[{ id: "open", label: "Open", onSelect: vi.fn() }, { id: "rename", label: "Rename", icon: "Edit2", onSelect: vi.fn() }, { id: "run", label: "Run", disabled: true, disabledReason: "No run configuration", onSelect: unavailable }]} />, root)); await settle();
    key(document.activeElement!, "r"); expect(document.activeElement?.textContent).toBe("Rename");
    const disabled = root.querySelector<HTMLButtonElement>('button[disabled]')!; expect(disabled.title).toBe("No run configuration"); disabled.click(); expect(unavailable).not.toHaveBeenCalled();
  });
});
