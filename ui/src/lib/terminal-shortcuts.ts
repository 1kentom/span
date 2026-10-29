import { nativeMenuBindings, shortcutFromEvent, type ActionId, type Platform, type ResolvedKeybindings } from "./commands";

const terminalAppActions: ReadonlySet<ActionId> = new Set(["showSourceControl"]);

/** Explicit workbench actions skip the shell; other Control keys remain shell input. */
export function terminalAllowsAppShortcut(event: KeyboardEvent, platform: Platform, bindings?: ResolvedKeybindings): boolean {
  const key = shortcutFromEvent(event);
  if (key && bindings && [...terminalAppActions].some(action => bindings[action].includes(key))) return true;
  if (platform !== "mac" || !event.metaKey || event.ctrlKey) return false;
  return !!key && !/^Meta\+(?:C|V|X|A|Z|Shift\+Z|Y)$/.test(key);
}

/** Native accelerators must yield shell Control keys before the webview sees them. */
export function menuBindingsForFocus(bindings: ResolvedKeybindings, platform: Platform, terminalFocused: boolean, recording: boolean): Record<string, string[]> {
  if (recording) return {};
  const menu = nativeMenuBindings(bindings);
  if (!terminalFocused) return menu;
  if (platform !== "mac") return Object.fromEntries(Object.entries(menu).filter(([action]) => terminalAppActions.has(action as ActionId)));
  return Object.fromEntries(Object.entries(menu).map(([action, keys]) => [
    action,
    terminalAppActions.has(action as ActionId) ? keys : keys.filter(key => key.startsWith("Meta+") && !key.includes("Ctrl+")),
  ]));
}
