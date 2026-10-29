// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { Settings_Serialize as SettingsValue } from "../bindings";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";

const defaults: SettingsValue = {
  theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false,
  uiFontSize: 13, uiFontFamily: "Inter", editorFontFamily: "JetBrains Mono",
  collapsePanelsOnDrag: true, markdownPreviewDefault: true, formatOnSave: false, autoSave: "off", autoSaveDelay: 1000, tabLimitEnabled: true, tabLimit: 10, tabLimitPerGroup: false, zoomLevel: null,
  keybindings: {}, formatters: {}, languageServers: { autoInstall: false, enabled: {}, javaHome: null, nodePath: null, runProjectCode: false, trustedWorkspaces: [] },
};
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function mount(overrides: Partial<SettingsPageProps> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const [settings, updateSettings] = createSignal<SettingsValue>({ ...defaults });
  const [source, setSource] = createSignal("// Workspace preferences\n{}\n");
  const onChange = vi.fn(async (patch: Partial<SettingsValue>) => { updateSettings(value => ({ ...value, ...patch })); });
  const props = { onChange, onSaveJsonc: vi.fn(async () => settings()), onReloadJsonc: vi.fn(async () => source()), ...overrides };
  disposers.push(render(() => <SettingsPage {...props} settings={settings()} settingsJsonc={source()} />, root));
  return { root, onChange, props, updateSettings, setSource };
}
function button(root: HTMLElement, name: string) {
  const element = [...root.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === name || item.textContent === name);
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
}
function input(root: HTMLElement, name: string) { return root.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!; }
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) { element.value = value; element.dispatchEvent(new Event("input", { bubbles: true })); }

describe("workspace SettingsPage", () => {
  it("renders a workspace surface with section navigation and searchable labelled preferences", async () => {
    const { root } = mount();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
    type(input(root, "Search settings"), "indentation");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Search results");
    expect(input(root, "Tab size")).not.toBeNull();
    expect(input(root, "Editor font size")).toBeNull();
    type(input(root, "Search settings"), "no matching setting");
    await settle();
    expect(root.textContent).toContain("No settings found");
  });

  it("applies typed controls and resets a changed preference to its default", async () => {
    const { root, onChange } = mount();
    button(root, "Editor").click(); await settle();
    const font = input(root, "Editor font size"); font.value = "18"; font.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(onChange).toHaveBeenCalledWith({ fontSize: 18 });
    button(root, "Reset editor font size to default").click(); await settle();
    expect(onChange).toHaveBeenLastCalledWith({ fontSize: 13 });
    button(root, "Word wrap").click(); await settle();
    expect(onChange).toHaveBeenLastCalledWith({ wordWrap: true });
  });

  it("exposes the enabled tab limit, value, and per-group scope", async () => {
    const { root, onChange } = mount();
    button(root, "Editor").click(); await settle();
    expect(button(root, "Limit open tabs").getAttribute("aria-checked")).toBe("true");
    const limit = input(root, "Maximum open tabs"); limit.value = "12"; limit.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(); expect(onChange).toHaveBeenCalledWith({ tabLimit: 12 });
    button(root, "Limit tabs per editor group").click(); await settle();
    expect(onChange).toHaveBeenLastCalledWith({ tabLimitPerGroup: true });
  });

  it("keeps an invalid JSONC draft after save failure and after saved settings change", async () => {
    const onSaveJsonc = vi.fn(async () => { throw new Error("Settings must contain an object"); });
    const onDirtyChange = vi.fn();
    const { root, setSource } = mount({ onSaveJsonc, onDirtyChange });
    button(root, "JSONC").click(); await settle();
    const json = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Settings JSONC"]')!;
    type(json, "{ invalid draft"); await settle();
    button(root, "Save settings").click(); await settle();
    expect(onSaveJsonc).toHaveBeenCalledWith("{ invalid draft");
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Settings must contain an object");
    expect(json.value).toBe("{ invalid draft");
    setSource('{ "fontSize": 17 }'); await settle();
    expect(json.value).toBe("{ invalid draft");
    expect(root.textContent).toContain("Your draft has been kept");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("requires an explicit discard choice before reloading over a draft", async () => {
    const onReloadJsonc = vi.fn(async () => '{ "tabSize": 4 }\n');
    const { root } = mount({ onReloadJsonc });
    button(root, "JSONC").click(); await settle();
    const json = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Settings JSONC"]')!;
    type(json, '{ "tabSize": 8 }'); await settle();
    button(root, "Reload saved").click(); await settle();
    expect(onReloadJsonc).not.toHaveBeenCalled();
    button(root, "Keep editing").click(); await settle();
    expect(json.value).toBe('{ "tabSize": 8 }');
    button(root, "Reload saved").click(); await settle();
    button(root, "Discard and reload").click(); await settle();
    expect(onReloadJsonc).toHaveBeenCalledOnce();
    expect(json.value).toBe('{ "tabSize": 4 }\n');
  });

  it("restores the persisted numeric value when a preference update fails", async () => {
    const onChange = vi.fn(async () => { throw new Error("Could not write workspace settings"); });
    const { root } = mount({ onChange });
    button(root, "Editor").click(); await settle();
    const font = input(root, "Editor font size"); font.value = "19"; font.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Could not write workspace settings");
    expect(font.value).toBe("13");
  });

  it("exposes a close-time save guard and keeps rejected drafts dirty", async () => {
    let save!: () => Promise<boolean>;
    const onSaveJsonc = vi.fn(async () => { throw new Error("Invalid JSONC"); });
    const { root } = mount({ onSaveJsonc, onSaveReady: handler => { save = handler; } });
    button(root, "JSONC").click(); await settle();
    type(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Settings JSONC"]')!, "invalid");
    expect(await save()).toBe(false);
    expect(root.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("invalid");
    expect(button(root, "Save settings").disabled).toBe(false);
  });

  it("provides custom keyboard navigation for font choices", async () => {
    const { root, onChange } = mount();
    const trigger = button(root, "Interface font"); trigger.click(); await settle();
    const choices = root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    choices[0].focus();
    choices[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(choices[1]);
    choices[1].click(); await settle();
    expect(onChange).toHaveBeenCalledWith({ uiFontFamily: "system-ui" });
    expect(root.querySelector("select")).toBeNull();
  });

  it("offers four Auto Save modes with a delay control active only after selecting After delay", async () => {
    const { root, onChange } = mount(); button(root, "Files").click(); await settle();
    expect(input(root, "Auto Save delay").disabled).toBe(true);
    button(root, "Auto Save").click(); await settle();
    expect([...root.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(["Off✓", "After delay", "On focus change", "On window change"]);
    button(root, "After delay").click(); await settle(); expect(onChange).toHaveBeenCalledWith({ autoSave: "afterDelay" });
    expect(input(root, "Auto Save delay").disabled).toBe(false);
    const delay = input(root, "Auto Save delay"); delay.value = "250"; delay.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    expect(onChange).toHaveBeenLastCalledWith({ autoSaveDelay: 250 });
  });

  it("shows the Explorer visibility preferences and sends nested leaf updates", async () => {
    const onSettingChange = vi.fn(async () => {});
    const { root } = mount({ onSettingChange });
    button(root, "Explorer").click(); await settle();
    expect(root.textContent).toContain(".env.example");
    expect(root.textContent).toContain("lazy Explorer rows");
    const hidden = button(root, "Show hidden files");
    expect(hidden.getAttribute("aria-checked")).toBe("true");
    hidden.click(); await settle();
    expect(onSettingChange).toHaveBeenCalledWith("explorer.showHiddenFiles", false);
    button(root, "Show ignored files").click(); await settle();
    expect(onSettingChange).toHaveBeenLastCalledWith("explorer.showIgnoredFiles", true);
  });

  it("resets only a configured Explorer leaf and blocks changes while JSONC is dirty", async () => {
    const onSettingChange = vi.fn(async () => {});
    const { root } = mount({ configuredKeys: ["explorer.compactFolders"], onSettingChange });
    button(root, "Explorer").click(); await settle();
    expect(button(root, "Reset compact folders override").disabled).toBe(false);
    button(root, "Reset compact folders override").click(); await settle();
    expect(onSettingChange).toHaveBeenCalledWith("explorer.compactFolders", null);
    button(root, "JSONC").click(); await settle();
    type(root.querySelector<HTMLTextAreaElement>("textarea")!, "{ dirty draft"); await settle();
    button(root, "Explorer").click(); await settle();
    const reveal = button(root, "Auto reveal active file");
    expect(reveal.disabled).toBe(true);
    reveal.click();
    expect(onSettingChange).toHaveBeenCalledTimes(1);
  });

  it("requests real scope changes and disables scope switching while a JSONC draft is dirty", async () => {
    const onScopeChange = vi.fn(async () => {}); const { root } = mount({ scope: "workspace", onScopeChange });
    button(root, "User").click(); await settle(); expect(onScopeChange).toHaveBeenCalledWith("user");
    button(root, "JSONC").click(); await settle(); type(root.querySelector<HTMLTextAreaElement>("textarea")!, "{ draft"); await settle();
    expect(button(root, "User").disabled).toBe(true); expect(root.textContent).toContain("Auto Save never applies this draft");
    button(root, "User").click(); expect(onScopeChange).toHaveBeenCalledTimes(1);
  });

  it("resets an explicit scoped override even when it equals the factory default and filters modified settings", async () => {
    const onReset = vi.fn(async () => {}); const { root, onChange } = mount({ configuredKeys: ["fontSize"], onReset });
    type(input(root, "Search settings"), "@modified"); await settle();
    expect(input(root, "Editor font size")).not.toBeNull(); expect(input(root, "Tab size")).toBeNull();
    expect(button(root, "Reset editor font size override").disabled).toBe(false);
    button(root, "Reset editor font size override").click(); await settle();
    expect(onReset).toHaveBeenCalledWith("fontSize"); expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts fractional window zoom without changing the editor font", async () => {
    const { root, onChange } = mount(); const zoom = input(root, "Window zoom level"); zoom.value = "1.5"; zoom.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    expect(onChange).toHaveBeenCalledWith({ zoomLevel: 1.5 }); expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ fontSize: expect.anything() }));
  });

  it("opens the real settings editor through the file icon and JSONC navigation", async () => {
    const onOpenJsonc = vi.fn(); const { root } = mount({ onOpenJsonc });
    button(root, "Open settings JSONC").click(); expect(onOpenJsonc).toHaveBeenCalledOnce();
    button(root, "JSONC").click(); await settle(); expect(onOpenJsonc).toHaveBeenCalledTimes(2);
    expect(root.querySelector('textarea[aria-label="Settings JSONC"]')).toBeNull();
    button(root, "Files").click(); await settle(); button(root, "Configure formatters in JSONC").click();
    expect(onOpenJsonc).toHaveBeenCalledTimes(3);
  });
});
