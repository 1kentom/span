// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { dispatchKeyboard, resolveKeybindings } from "./commands";
import { menuBindingsForFocus, terminalAllowsAppShortcut } from "./terminal-shortcuts";

describe("terminal shortcut ownership", () => {
  it("keeps Mac Command navigation and close while yielding Control and clipboard editing", () => {
    for (const key of ["e", "p", "j", "w"]) expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key, metaKey: true }), "mac")).toBe(true);
    for (const key of ["p", "w", "c", "j"]) expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key, ctrlKey: true }), "mac")).toBe(false);
    for (const key of ["c", "v", "x", "a", "z", "y"]) expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key, metaKey: true }), "mac")).toBe(false);
    expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }), "linux")).toBe(false);
  });

  it("retains only Mac Meta native primaries while shell focused, and restores on leaving", () => {
    const keys = resolveKeybindings({ quickOpen: ["Ctrl+P", "Meta+P"] }, "mac");
    const menu = menuBindingsForFocus(keys, "mac", true, false);
    expect(menu.quickOpen).toEqual([]);
    expect(menu.toggleFiles).toEqual(["Meta+E"]);
    expect(menu.closeTab).toEqual(["Meta+W"]);
    expect(Object.entries(menu).filter(([action]) => action !== "showSourceControl").flatMap(([, keys]) => keys).every(key => key.startsWith("Meta+") && !key.includes("Ctrl+"))).toBe(true);
    expect(menuBindingsForFocus(keys, "mac", false, false).quickOpen).toEqual(["Ctrl+P"]);
    expect(menuBindingsForFocus(keys, "mac", true, true)).toEqual({});
    expect(menuBindingsForFocus(resolveKeybindings({}, "windows"), "windows", true, false)).toEqual({ showSourceControl: ["Ctrl+Shift+G"] });
  });

  it("dispatches CmdE/P/J/W once from xterm while CtrlP/W/C remain unhandled", () => {
    const target = document.createElement("textarea");
    const calls = { toggleFiles: vi.fn(), quickOpen: vi.fn(), toggleTerminal: vi.fn(), closeTab: vi.fn() };
    for (const [key, action] of [["e", "toggleFiles"], ["p", "quickOpen"], ["j", "toggleTerminal"], ["w", "closeTab"]] as const) {
      const event = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true }); Object.defineProperty(event, "target", { value: target });
      if (terminalAllowsAppShortcut(event, "mac")) dispatchKeyboard(event, { handlers: calls, bindings: resolveKeybindings({}, "mac"), platform: "mac" });
      expect(event.defaultPrevented).toBe(true); expect(calls[action]).toHaveBeenCalledTimes(1);
    }
    for (const key of ["p", "w", "c"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
      if (terminalAllowsAppShortcut(event, "mac")) dispatchKeyboard(event, { handlers: calls, bindings: resolveKeybindings({}, "mac"), platform: "mac" });
      expect(event.defaultPrevented).toBe(false);
    }
  });
});


it("routes the configured Source Control action from terminal without consuming plain Control readline keys", () => {
  for (const platform of ["mac", "windows", "linux"] as const) {
    const bindings = resolveKeybindings({}, platform);
    expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true }), platform, bindings)).toBe(true);
    expect(menuBindingsForFocus(bindings, platform, true, false).showSourceControl).toEqual(["Ctrl+Shift+G"]);
    for (const key of ["g", "p", "w", "c"]) expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key, ctrlKey: true }), platform, bindings)).toBe(false);
    const custom = resolveKeybindings({ showSourceControl: ["Ctrl+Alt+G"], goToLine: [] }, platform);
    expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key: "G", ctrlKey: true, shiftKey: true }), platform, custom)).toBe(false);
    expect(terminalAllowsAppShortcut(new KeyboardEvent("keydown", { key: "g", ctrlKey: true, altKey: true }), platform, custom)).toBe(true);
  }
});
