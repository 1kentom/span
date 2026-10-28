// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { KeyboardSettings } from "./KeyboardSettings";
import type { KeybindingOverrides } from "../lib/commands";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function mount(initial: KeybindingOverrides = {}, onRecordingChange?: (recording: boolean) => void, extra: Partial<Parameters<typeof KeyboardSettings>[0]> = {}) {
  const root = document.createElement("div"); document.body.append(root); const [bindings, setBindings] = createSignal(initial);
  const onChange = vi.fn(async (value: KeybindingOverrides) => { setBindings(value); });
  disposers.push(render(() => <KeyboardSettings keybindings={bindings()} onChange={onChange} onRecordingChange={onRecordingChange} platform="linux" {...extra} />, root));
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
  it("renders the four real columns, supported commands, and read-only focus metadata", () => {
    const { root } = mount({ save: ["Ctrl+Alt+S"] });
    expect([...root.querySelectorAll("th")].map(cell => cell.textContent)).toEqual(["Command", "Keybinding", "When", "Source"]);
    const table = root.querySelector('table[aria-label="Keyboard shortcut commands"]')!;
    expect(table.querySelector('[data-command="save"] .kb-source>span')?.textContent).toBe("User");
    expect(table.querySelector('[data-command="quickOpen"] .kb-source>span')?.textContent).toBe("Default");
    expect(table.querySelector('[data-command="openFile"]')?.textContent).toContain("Open File");
    expect([...table.querySelectorAll('[data-command="focusFiles"] kbd')].map(key => key.textContent)).toEqual(["Ctrl", "E", "Ctrl", "Shift", "E"]);
    expect(table.querySelector('[data-command="toggleWordWrap"] .kb-context')?.textContent).toBe("Editor or non-text focus");
    expect(root.querySelector('input[aria-label*="When"]')).toBeNull();
    expect(root.textContent).toContain("Custom When expressions are not supported");
    expect(root.querySelectorAll("kbd").length).toBeGreaterThan(10);
  });
  it("reports provided scope sources and only resets overrides in the selected scope", () => {
    const { root, button } = mount({ save: ["Ctrl+Alt+S"], toggleProject: ["Ctrl+Alt+P"] }, undefined, { scope: "workspace", bindingSources: { save: "User", toggleProject: "Workspace" } });
    expect(root.querySelector('[data-command="save"] .kb-source>span')?.textContent).toBe("User");
    expect(root.querySelector('[data-command="toggleProject"] .kb-source>span')?.textContent).toBe("Workspace");
    expect(button("Reset shortcut for Save File").disabled).toBe(true);
    expect(button("Reset shortcut for Toggle Project Panel").disabled).toBe(false);
  });
  it("filters customized and disabled bindings through User and source search", async () => {
    const { root, button } = mount({ save: [] });
    button("Show user keybindings").click(); await settle();
    expect(root.querySelectorAll("tbody tr[data-command]")).toHaveLength(1);
    expect(root.querySelector('[data-command="save"]')?.textContent).toContain("Unassigned");
    button("Show user keybindings").click();
    const search = root.querySelector<HTMLInputElement>('[aria-label="Search keyboard shortcuts"]')!;
    search.value = "@source:default zoom"; search.dispatchEvent(new Event("input", { bubbles: true })); await settle();
    expect(root.querySelectorAll("tbody tr[data-command]")).toHaveLength(3);
    expect(root.querySelector('[data-command="save"]')).toBeNull();
  });
  it("records an exact keybinding search and releases native accelerators when recording stops", async () => {
    const recording = vi.fn(); const { root, button } = mount({}, recording);
    button("Record keys to search").click(); await settle();
    expect(recording).toHaveBeenLastCalledWith(true);
    const input = root.querySelector<HTMLInputElement>('[aria-label="Search keyboard shortcuts"]')!;
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event); await settle();
    expect(event.defaultPrevented).toBe(true); expect(input.value).toBe("Ctrl+P");
    expect(root.querySelectorAll("tbody tr[data-command]")).toHaveLength(1);
    expect(root.querySelector('[data-command="quickOpen"]')).not.toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle();
    expect(recording).toHaveBeenLastCalledWith(false);
    button("Clear shortcut search").click(); await settle();
    expect(root.querySelectorAll("tbody tr[data-command]").length).toBeGreaterThan(10);
  });
  it("filters commands and restores all defaults", async () => {
    const { root, button, onChange } = mount({ quickOpen: ["Ctrl+K"] });
    const search = root.querySelector<HTMLInputElement>('[aria-label="Search keyboard shortcuts"]')!; search.value = "markdown"; search.dispatchEvent(new Event("input", { bubbles: true })); await settle();
    expect(root.textContent).toContain("Toggle Markdown Preview"); expect(root.textContent).not.toContain("Go to File");
    button("Reset all shortcuts").click(); await settle(); expect(onChange).toHaveBeenCalledWith({});
  });
});
