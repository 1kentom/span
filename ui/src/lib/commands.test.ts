// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { canDispatchAction, dispatchKeyboard, formatShortcut, nativeMenuBindings, normalizeShortcut, resolveKeybindings, shortcutFromEvent, validateKeybindings } from "./commands";
function key(key: string, options: KeyboardEventInit = {}, target?: Element) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}
describe("central keyboard commands", () => {
  it("normalizes modifiers and resolves portable defaults per platform", () => {
    expect(normalizeShortcut("shift + cmd + p")).toBe("Meta+Shift+P");
    expect(normalizeShortcut("Mod+P", "linux")).toBe("Ctrl+P");
    expect(resolveKeybindings({}, "mac").quickOpen).toEqual(["Meta+P", "Meta+K", "Meta+E", "Ctrl+P"]);
    expect(formatShortcut("Mod+Shift+P", "mac")).toBe("⌘⇧P");
    expect(formatShortcut("Mod+Shift+P", "windows")).toBe("Ctrl+Shift+P");
    expect(normalizeShortcut("P")).toBeUndefined();
    expect(normalizeShortcut("Ctrl+Ctrl+P")).toBeUndefined();
    expect(normalizeShortcut("Ctrl+😀")).toBeUndefined();
    expect(normalizeShortcut("Shift+P")).toBeUndefined();
    expect(resolveKeybindings({}, "linux").quickOpen).toContain("Ctrl+E");
  });
  it("rejects reserved editing and quit shortcuts and conflicts with inherited defaults", () => {
    expect(validateKeybindings({ closeTab: ["Mod+Q"] }, "mac")[0].message).toContain("Quit");
    expect(validateKeybindings({ settings: ["Ctrl+Z"] }, "linux")[0].message).toContain("text editing");
    expect(validateKeybindings({ save: ["Mod+P"] }, "mac")[0].message).toContain("already assigned");
    expect(validateKeybindings({ mystery: ["Ctrl+P"] }, "linux")[0].message).toContain("Unknown");
    expect(validateKeybindings({ save: ["Ctrl+"] }, "linux")[0].message).toContain("Invalid");
  });
  it("rebinds and disables actions without retaining their defaults", () => {
    const bindings = resolveKeybindings({ quickOpen: ["Mod+K"], save: [] }, "linux");
    const open = vi.fn(); const save = vi.fn();
    expect(dispatchKeyboard(key("p", { ctrlKey: true }), { bindings, handlers: { quickOpen: open } })).toBe(false);
    expect(dispatchKeyboard(key("k", { ctrlKey: true }), { bindings, handlers: { quickOpen: open } })).toBe(true);
    expect(dispatchKeyboard(key("s", { ctrlKey: true }), { bindings, handlers: { save } })).toBe(false);
    expect(open).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });
  it("does not hijack typing, composition, repeats, recorders, or editor actions in text fields", () => {
    const bindings = resolveKeybindings({}, "linux"); const handler = vi.fn(); const handlers = { quickOpen: handler, findInFile: handler };
    const input = document.createElement("input");
    expect(dispatchKeyboard(key("p", {}, input), { bindings, handlers })).toBe(false);
    expect(dispatchKeyboard(key("f", { ctrlKey: true }, input), { bindings, handlers })).toBe(false);
    expect(dispatchKeyboard(key("p", { ctrlKey: true, isComposing: true }, input), { bindings, handlers })).toBe(false);
    expect(dispatchKeyboard(key("p", { ctrlKey: true, repeat: true }, input), { bindings, handlers })).toBe(false);
    input.dataset.shortcutRecorder = "true";
    expect(dispatchKeyboard(key("p", { ctrlKey: true }, input), { bindings, handlers })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(canDispatchAction("findInFile", input)).toBe(false);
    expect(canDispatchAction("quickOpen", input)).toBe(false);
    delete input.dataset.shortcutRecorder;
    expect(canDispatchAction("quickOpen", input)).toBe(true);
  });
  it("dispatches current-file find in CodeMirror and consumes the event exactly once", () => {
    const editor = document.createElement("div"); editor.className = "cm-editor";
    const content = document.createElement("div"); content.setAttribute("contenteditable", "true"); editor.append(content);
    const handler = vi.fn(); const event = key("f", { ctrlKey: true }, content);
    const options = { bindings: resolveKeybindings({}, "linux"), handlers: { findInFile: handler } };
    expect(dispatchKeyboard(event, options)).toBe(true); expect(event.defaultPrevented).toBe(true);
    expect(dispatchKeyboard(event, options)).toBe(false); expect(handler).toHaveBeenCalledOnce();
  });
  it("keeps native accelerator ownership separate from macOS Control-P alias", () => {
    const bindings = resolveKeybindings({}, "mac"); const handler = vi.fn();
    const options = { bindings, handlers: { quickOpen: handler, closeTab: handler }, nativeActions: new Set(["quickOpen", "closeTab"] as const) };
    expect(dispatchKeyboard(key("p", { metaKey: true }), options)).toBe(false);
    expect(dispatchKeyboard(key("p", { ctrlKey: true }), options)).toBe(true);
    expect(dispatchKeyboard(key("w", { metaKey: true }), options)).toBe(false);
    expect(nativeMenuBindings(bindings).quickOpen).toEqual(["Meta+P"]);
    expect(handler).toHaveBeenCalledOnce();
  });
  it("normalizes shifted letter casing and punctuation", () => {
    expect(shortcutFromEvent(key("P", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+P");
    expect(shortcutFromEvent(key("Ï", { altKey: true, shiftKey: true, code: "KeyF" }))).toBe("Alt+Shift+F");
    expect(shortcutFromEvent(key("|", { ctrlKey: true, shiftKey: true, code: "Backslash" }))).toBe("Ctrl+Shift+\\");
  });
});
