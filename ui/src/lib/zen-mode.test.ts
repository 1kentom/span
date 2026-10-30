import { describe, expect, it } from "vitest";
import { actionDefinitions, dispatchKeyboard, nativeMenuBindings, resolveKeybindings, shortcutFromEvent, validateKeybindings, type Platform } from "./commands";
import { NO_PEEK, ZEN_DEFAULTS, ZEN_SETTINGS_KEY, captureZenLayout, createDoubleEscape, readZenSettings, restoreZenLayout, writeZenSettings, zenChrome, zenClasses, zenPanels, type ZenLayout } from "./zen-mode";

const layout: ZenLayout<"Files" | "Search" | "Git" | "Uploads", "terminal" | "run"> = {
  panels: { projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: false, projectWidth: 312, assistantWidth: 418, terminalHeight: 247 },
  leftView: "Git",
  bottomTab: "run",
  assistantHeld: false,
};
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items };
}

describe("zen layout", () => {
  it("hides the project panel and bottom dock and keeps the agent sidebar and every width", () => {
    expect(zenPanels(layout.panels)).toEqual({ ...layout.panels, projectCollapsed: true, terminalCollapsed: true });
    const closed = { ...layout.panels, assistantCollapsed: true };
    expect(zenPanels(closed).assistantCollapsed).toBe(true);
  });

  it("shows a peeked panel without changing the stored layout", () => {
    const stored = { ...layout.panels };
    expect(zenPanels(stored, { project: true, terminal: false })).toMatchObject({ projectCollapsed: false, terminalCollapsed: true });
    expect(zenPanels(stored, { project: false, terminal: true })).toMatchObject({ projectCollapsed: true, terminalCollapsed: false });
    expect(stored).toEqual(layout.panels);
    expect(zenPanels(stored, NO_PEEK)).toEqual(zenPanels(stored));
  });

  it("restores exactly what was there, whatever changed during zen", () => {
    const snapshot = captureZenLayout(layout);
    layout.panels.assistantWidth = 999; // the snapshot is a copy, not a reference
    layout.panels.assistantWidth = 418;
    const during = { panels: { ...layout.panels, assistantCollapsed: true, assistantWidth: 600, extra: "kept" } };
    const restored = restoreZenLayout(snapshot, during);
    expect(restored).toEqual({ panels: { ...layout.panels, extra: "kept" }, leftView: "Git", bottomTab: "run", assistantHeld: false });
    expect(restoreZenLayout(captureZenLayout({ ...layout, panels: { ...layout.panels, projectCollapsed: true, terminalCollapsed: true }, assistantHeld: true }), during))
      .toMatchObject({ panels: { projectCollapsed: true, terminalCollapsed: true }, assistantHeld: true });
  });

  it("round trips every combination of panel visibility", () => {
    for (let bits = 0; bits < 8; bits += 1) {
      const panels = { ...layout.panels, projectCollapsed: !!(bits & 1), assistantCollapsed: !!(bits & 2), terminalCollapsed: !!(bits & 4) };
      const snapshot = captureZenLayout({ ...layout, panels });
      expect(restoreZenLayout(snapshot, { panels: zenPanels(panels, { project: true, terminal: true }) }).panels).toEqual(panels);
    }
  });
});

describe("zen chrome and settings", () => {
  it("defaults to hidden tabs, visible line numbers, no centering and no full screen", () => {
    expect(ZEN_DEFAULTS).toEqual({ hideTabs: true, hideLineNumbers: false, centerLayout: false, fullScreen: false });
    expect(zenChrome(ZEN_DEFAULTS, { assistantOpen: true, agentsMode: false })).toEqual({ tabs: false, lineNumbers: true, centered: false });
  });

  it("centers only with the agent sidebar closed and never on the Agents page", () => {
    const settings = { ...ZEN_DEFAULTS, centerLayout: true };
    expect(zenChrome(settings, { assistantOpen: false, agentsMode: false }).centered).toBe(true);
    expect(zenChrome(settings, { assistantOpen: true, agentsMode: false }).centered).toBe(false);
    expect(zenChrome(settings, { assistantOpen: false, agentsMode: true }).centered).toBe(false);
  });

  it("maps every settings combination to root classes", () => {
    for (let bits = 0; bits < 8; bits += 1) {
      const settings = { ...ZEN_DEFAULTS, hideTabs: !!(bits & 1), hideLineNumbers: !!(bits & 2), centerLayout: !!(bits & 4) };
      const classes = zenClasses(true, zenChrome(settings, { assistantOpen: false, agentsMode: false }), false).split(" ");
      expect(classes).toContain("zen");
      expect(classes.includes("zen-no-tabs")).toBe(settings.hideTabs);
      expect(classes.includes("zen-no-line-numbers")).toBe(settings.hideLineNumbers);
      expect(classes.includes("zen-centered")).toBe(settings.centerLayout);
      expect(classes).not.toContain("zen-agents");
    }
    expect(zenClasses(false, zenChrome(ZEN_DEFAULTS, { assistantOpen: false, agentsMode: false }), false)).toBe("");
    expect(zenClasses(true, zenChrome(ZEN_DEFAULTS, { assistantOpen: false, agentsMode: true }), true)).toContain("zen-agents");
  });

  it("reads and writes device preferences and falls back to defaults on bad or blocked storage", () => {
    const storage = memoryStorage();
    expect(readZenSettings(storage)).toEqual(ZEN_DEFAULTS);
    expect(writeZenSettings({ ...ZEN_DEFAULTS, centerLayout: true }, storage)).toBe(true);
    expect(readZenSettings(storage)).toEqual({ ...ZEN_DEFAULTS, centerLayout: true });
    expect(readZenSettings(memoryStorage({ [ZEN_SETTINGS_KEY]: "{not json" }))).toEqual(ZEN_DEFAULTS);
    expect(readZenSettings(memoryStorage({ [ZEN_SETTINGS_KEY]: JSON.stringify({ hideTabs: "yes", fullScreen: true }) }))).toEqual({ ...ZEN_DEFAULTS, fullScreen: true });
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readZenSettings(blocked)).toEqual(ZEN_DEFAULTS);
    expect(writeZenSettings(ZEN_DEFAULTS, blocked)).toBe(false);
    expect(readZenSettings(undefined)).toEqual(ZEN_DEFAULTS);
  });
});

describe("double Escape", () => {
  it("needs two unanswered presses close together", () => {
    const escape = createDoubleEscape(500);
    expect(escape.press(false, 0)).toBe(false);
    expect(escape.press(false, 400)).toBe(true);
    expect(escape.press(false, 1000)).toBe(false);
    expect(escape.press(false, 1600)).toBe(false); // too slow: this press starts a new sequence
    expect(escape.press(false, 1700)).toBe(true);
  });

  it("does not count a press something else answered and starts over after it", () => {
    const escape = createDoubleEscape(500);
    expect(escape.press(false, 0)).toBe(false);
    expect(escape.press(true, 100)).toBe(false);
    expect(escape.press(false, 200)).toBe(false);
    expect(escape.press(false, 300)).toBe(true);
    escape.press(false, 1000); escape.reset();
    expect(escape.press(false, 1100)).toBe(false);
  });
});

describe("toggle zen mode binding", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, ...init });
  it("is Ctrl+Cmd+Z on macOS and Ctrl+Alt+Z elsewhere, never Redo", () => {
    expect(resolveKeybindings({}, "mac").toggleZenMode).toEqual(["Meta+Ctrl+Z"]);
    for (const platform of ["windows", "linux"] as Platform[]) expect(resolveKeybindings({}, platform).toggleZenMode).toEqual(["Ctrl+Alt+Z"]);
    expect(shortcutFromEvent(key({ key: "z", metaKey: true, ctrlKey: true }))).toBe("Meta+Ctrl+Z");
    expect(shortcutFromEvent(key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Z");
    expect(resolveKeybindings({}, "mac").toggleZenMode).not.toContain("Meta+Shift+Z");
  });

  it("conflicts with no other default on any platform", () => {
    for (const platform of ["mac", "windows", "linux"] as Platform[]) {
      expect(validateKeybindings({}, platform)).toEqual([]);
      const resolved = resolveKeybindings({}, platform);
      const zen = resolved.toggleZenMode[0];
      expect(actionDefinitions.filter(action => action.id !== "toggleZenMode" && resolved[action.id].includes(zen))).toEqual([]);
    }
  });

  it("is rebindable, and an existing binding on its key wins without an error", () => {
    expect(resolveKeybindings({ toggleZenMode: ["Mod+Alt+K"] }, "mac").toggleZenMode).toEqual(["Meta+Alt+K"]);
    expect(validateKeybindings({ toggleZenMode: ["Mod+Alt+K"] }, "mac")).toEqual([]);
    const claimed = resolveKeybindings({ save: ["Meta+Ctrl+Z"] }, "mac");
    expect(claimed.toggleZenMode).toEqual([]);
    expect(validateKeybindings({ save: ["Meta+Ctrl+Z"] }, "mac")).toEqual([]);
  });

  it("dispatches to the toggle and is sent to the native View menu", () => {
    let toggled = 0;
    const event = key({ key: "z", code: "KeyZ", metaKey: true, ctrlKey: true });
    expect(dispatchKeyboard(event, { bindings: resolveKeybindings({}, "mac"), handlers: { toggleZenMode: () => { toggled += 1; } }, platform: "mac" })).toBe(true);
    expect(toggled).toBe(1);
    expect(nativeMenuBindings(resolveKeybindings({}, "mac")).toggleZenMode).toEqual(["Meta+Ctrl+Z"]);
    expect(actionDefinitions.find(action => action.id === "toggleZenMode")).toMatchObject({ label: "Toggle Zen Mode", category: "View" });
  });
});
