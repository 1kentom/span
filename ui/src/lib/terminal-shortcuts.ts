import { nativeMenuBindings, shortcutFromEvent, type Platform, type ResolvedKeybindings } from "./commands";

/** Command shortcuts belong to the Mac workbench; Control remains shell input. */
export function terminalAllowsAppShortcut(event: KeyboardEvent, platform: Platform): boolean {
  if (platform !== "mac" || !event.metaKey || event.ctrlKey) return false;
  const key = shortcutFromEvent(event);
  return !!key && !/^Meta\+(?:C|V|X|A|Z|Shift\+Z|Y)$/.test(key);
}

/** Native accelerators must yield shell Control keys before the webview sees them. */
export function menuBindingsForFocus(bindings: ResolvedKeybindings, platform: Platform, terminalFocused: boolean, recording: boolean): Record<string, string[]> {
  if (recording) return {};
  const menu = nativeMenuBindings(bindings);
  if (!terminalFocused) return menu;
  if (platform !== "mac") return {};
  return Object.fromEntries(Object.entries(menu).map(([action, keys]) => [action, keys.filter(key => key.startsWith("Meta+") && !key.includes("Ctrl+"))]));
}
