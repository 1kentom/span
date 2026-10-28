// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { CommandPalette } from "./CommandPalette";
import { resolveKeybindings } from "../lib/commands";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { await Promise.resolve(); await Promise.resolve(); }
describe("command palette", () => {
  it("only lists registered handlers, shows resolved shortcuts, and executes the selected command", async () => {
    const root = document.createElement("div"); document.body.append(root);
    const save = vi.fn(); const open = vi.fn(); const close = vi.fn();
    disposers.push(render(() => <CommandPalette handlers={{ save, quickOpen: open }} bindings={resolveKeybindings({ save: ["Ctrl+Alt+S"] }, "linux")} platform="linux" onClose={close} />, root));
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(root.textContent).toContain("Ctrl+Alt+S"); expect(root.textContent).not.toContain("Split Editor");
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    input.value = "save"; input.dispatchEvent(new Event("input", { bubbles: true })); await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(save).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });
  it("shows an empty state and keeps Enter inert when nothing matches", async () => {
    const root = document.createElement("div"); document.body.append(root); const save = vi.fn(); const close = vi.fn();
    disposers.push(render(() => <CommandPalette handlers={{ save }} bindings={resolveKeybindings({}, "mac")} platform="mac" onClose={close} />, root));
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    input.value = "missing command"; input.dispatchEvent(new Event("input", { bubbles: true })); await settle();
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(0); expect(root.querySelector('[role="status"]')?.textContent).toContain("No commands");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(save).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});
