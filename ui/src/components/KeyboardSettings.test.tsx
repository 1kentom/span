// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { KeyboardSettings } from "./KeyboardSettings";
import type { KeybindingOverrides } from "../lib/commands";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function mount(initial: KeybindingOverrides = {}, onRecordingChange?: (recording: boolean) => void) {
  const root = document.createElement("div"); document.body.append(root); const [bindings, setBindings] = createSignal(initial);
  const onChange = vi.fn(async (value: KeybindingOverrides) => { setBindings(value); });
  disposers.push(render(() => <KeyboardSettings keybindings={bindings()} onChange={onChange} onRecordingChange={onRecordingChange} platform="linux" />, root));
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label)!;
  return { root, onChange, button };
}
describe("keyboard shortcut preferences", () => {
  it("records a portable shortcut, persists it, and resets the command", async () => {
    const { root, button, onChange } = mount(); button("Change shortcut for Go to File").click(); await settle();
    const input = root.querySelector<HTMLInputElement>('[aria-label="Record shortcut for Go to File"]')!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })); await settle();
    expect(input.value).toBe("Ctrl+K"); button("Save").click(); await settle();
    expect(onChange).toHaveBeenCalledWith({ quickOpen: ["Mod+K"] });
    button("Reset shortcut for Go to File").click(); await settle(); expect(onChange).toHaveBeenLastCalledWith({});
  });
  it("shows collisions before saving and lets a shortcut be disabled", async () => {
    const { root, button, onChange } = mount(); button("Change shortcut for Save File").click(); await settle();
    root.querySelector<HTMLInputElement>('[aria-label="Record shortcut for Save File"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle(); button("Save").click(); await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("already assigned"); expect(onChange).not.toHaveBeenCalled();
    button("Cancel").click(); await settle(); button("Remove shortcut for Save File").click(); await settle();
    expect(onChange).toHaveBeenCalledWith({ save: [] });
  });
  it("suspends native accelerators while recording and restores them on cancel", async () => {
    const recording = vi.fn(); const { root, button } = mount({}, recording); await settle();
    expect(recording).toHaveBeenLastCalledWith(false);
    button("Change shortcut for Go to File").click(); await settle();
    expect(recording).toHaveBeenLastCalledWith(true);
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Record shortcut for Go to File"]'));
    button("Cancel").click(); await settle(); expect(recording).toHaveBeenLastCalledWith(false);
  });
  it("filters commands and restores all defaults", async () => {
    const { root, button, onChange } = mount({ quickOpen: ["Ctrl+K"] });
    const search = root.querySelector<HTMLInputElement>('[aria-label="Search keyboard shortcuts"]')!; search.value = "markdown"; search.dispatchEvent(new Event("input", { bubbles: true })); await settle();
    expect(root.textContent).toContain("Toggle Markdown Preview"); expect(root.textContent).not.toContain("Go to File");
    button("Reset all shortcuts").click(); await settle(); expect(onChange).toHaveBeenCalledWith({});
  });
});
