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
