/** Editor actions are shared by the command palette, key dispatcher, and settings. */
export const actionDefinitions = [
  { id: "quickOpen", label: "Go to File", category: "Navigation", keys: ["Mod+P", "Mod+K", "Mod+E"], inputs: true },
  { id: "commandPalette", label: "Show All Commands", category: "Navigation", keys: ["Mod+Shift+P"], inputs: true },
  { id: "findInFile", label: "Find in File", category: "Editor", keys: ["Mod+F"], inputs: false },
  { id: "searchWorkspace", label: "Search in Files", category: "Navigation", keys: ["Mod+Shift+F"], inputs: true },
  { id: "settings", label: "Open Settings", category: "Preferences", keys: ["Mod+,"], inputs: true },
  { id: "closeTab", label: "Close Editor Tab", category: "File", keys: ["Mod+W"], inputs: true },
  { id: "save", label: "Save File", category: "File", keys: ["Mod+S"], inputs: true },
  { id: "openFolder", label: "Open Folder", category: "File", keys: ["Mod+O"], inputs: true },
  { id: "splitEditor", label: "Split Editor", category: "View", keys: ["Mod+\\"], inputs: true },
  { id: "toggleProject", label: "Toggle Project Panel", category: "View", keys: ["Mod+B"], inputs: true },
  { id: "toggleAssistant", label: "Toggle AI Assistant", category: "View", keys: ["Mod+Alt+B"], inputs: true },
  { id: "toggleTerminal", label: "Toggle Terminal Panel", category: "View", keys: ["Mod+J"], inputs: true },
  { id: "markdownPreview", label: "Toggle Markdown Preview", category: "Editor", keys: ["Mod+Shift+V"], inputs: false },
  { id: "formatDocument", label: "Format Document", category: "Editor", keys: ["Alt+Shift+F"], inputs: false },
  { id: "goToLine", label: "Go to Line", category: "Editor", keys: ["Ctrl+G", "Mod+Alt+G"], inputs: false },
] as const;
export type ActionId = typeof actionDefinitions[number]["id"];
export type Platform = "mac" | "windows" | "linux";
export type KeybindingOverrides = Record<string, string[]>;
export type ResolvedKeybindings = Record<ActionId, string[]>;
export type ActionHandlers = Partial<Record<ActionId, () => void>>;
export type KeybindingIssue = { action: string; message: string };
export function currentPlatform(): Platform {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return /Mac|iPhone|iPad/i.test(platform) ? "mac" : /Win/i.test(platform) ? "windows" : "linux";
}
const modifierNames: Record<string, string> = { mod: "Mod", cmdorctrl: "Mod", commandorcontrol: "Mod", ctrl: "Ctrl", control: "Ctrl", cmd: "Meta", command: "Meta", meta: "Meta", alt: "Alt", option: "Alt", shift: "Shift" };
const modifierOrder = ["Mod", "Meta", "Ctrl", "Alt", "Shift"];
const namedKeys: Record<string, string> = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight" };
export function normalizeShortcut(value: string, platform?: Platform): string | undefined {
  const tokens = value.split("+").map(token => token.trim());
  if (tokens.some(token => !token) || tokens.length < 2) return;
  const modifiers = new Set<string>(); let key: string | undefined;
  for (const token of tokens) {
    let modifier = modifierNames[token.toLowerCase()];
    if (modifier === "Mod" && platform) modifier = platform === "mac" ? "Meta" : "Ctrl";
    if (modifier) { if (modifiers.has(modifier)) return; modifiers.add(modifier); continue; }
    if (key) return;
    key = namedKeys[token.toLowerCase()] || (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(token) ? token.toUpperCase() : /^[a-z0-9`\\,./;'\[\]\-=]$/i.test(token) ? token.toUpperCase() : undefined);
    if (!key) return;
  }
  // Modified shortcuts preserve ordinary typing and native text navigation.
  if (!key || !["Mod", "Meta", "Ctrl", "Alt"].some(mod => modifiers.has(mod))) return;
  return [...modifierOrder.filter(mod => modifiers.has(mod)), key].join("+");
}
export function resolveKeybindings(overrides: KeybindingOverrides = {}, platform: Platform = currentPlatform()): ResolvedKeybindings {
  return Object.fromEntries(actionDefinitions.map(action => {
    const defaults: readonly string[] = action.id === "quickOpen" && platform === "mac" ? [...action.keys, "Ctrl+P"] : action.keys;
    const keys = Object.hasOwn(overrides, action.id) ? overrides[action.id] : defaults;
    return [action.id, [...new Set(keys.map(key => normalizeShortcut(key, platform)).filter((key): key is string => Boolean(key)))]];
  })) as ResolvedKeybindings;
}
export function validateKeybindings(overrides: KeybindingOverrides, platform: Platform = currentPlatform()): KeybindingIssue[] {
  const issues: KeybindingIssue[] = [];
  for (const [action, values] of Object.entries(overrides)) {
    if (!actionDefinitions.some(definition => definition.id === action)) { issues.push({ action, message: `Unknown command: ${action}` }); continue; }
    if (!Array.isArray(values)) { issues.push({ action, message: "Shortcuts must be an array of strings." }); continue; }
    if (values.length > 4) { issues.push({ action, message: "At most four shortcuts are allowed per command." }); continue; }
    for (const value of values) {
      const key = typeof value === "string" ? normalizeShortcut(value, platform) : undefined;
      if (!key) issues.push({ action, message: `Invalid shortcut: ${String(value)}. Use modifiers and one key, for example Mod+Shift+P.` });
      else if (/^(?:Meta|Ctrl)\+Q$/.test(key)) issues.push({ action, message: "Quit is reserved by the application. Choose another shortcut." });
      else if (/^(?:Meta|Ctrl)\+(?:C|V|X|A|Z|Shift\+Z|Y)$/.test(key)) issues.push({ action, message: "This shortcut is reserved for text editing. Choose another shortcut." });
    }
  }
  if (issues.length) return issues;
  const used = new Map<string, ActionId>();
  const resolved = resolveKeybindings(overrides, platform);
  for (const action of actionDefinitions) for (const key of resolved[action.id]) {
    const conflict = used.get(key);
    if (conflict && conflict !== action.id) issues.push({ action: action.id, message: `${formatShortcut(key, platform)} is already assigned to ${actionDefinitions.find(item => item.id === conflict)!.label}.` });
    else used.set(key, action.id);
  }
  return issues;
}
export function formatShortcut(shortcut: string, platform: Platform = currentPlatform()): string {
  const normalized = normalizeShortcut(shortcut, platform) || shortcut;
  const parts = normalized.split("+");
  if (platform === "mac") return parts.map(part => ({ Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Space: "Space" }[part] || part)).join("");
  return parts.map(part => part === "Meta" ? "Win" : part).join("+");
}
export function shortcutLabel(id: ActionId, bindings: ResolvedKeybindings, platform: Platform = currentPlatform()): string { return bindings[id][0] ? formatShortcut(bindings[id][0], platform) : ""; }
export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph", "Dead", "Unidentified"].includes(event.key)) return;
  // KeyboardEvent.key follows the active layout, while shifted punctuation is mapped by physical code.
  const punctuation: Record<string, string> = { Backslash: "\\", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=" };
  const optionLetter = event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : undefined;
  const key = punctuation[event.code] || optionLetter || (event.key === " " ? "Space" : event.key);
  return normalizeShortcut([...event.metaKey ? ["Meta"] : [], ...event.ctrlKey ? ["Ctrl"] : [], ...event.altKey ? ["Alt"] : [], ...event.shiftKey ? ["Shift"] : [], key].join("+"));
}
function textInput(target: EventTarget | null): boolean { return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')); }
export function canDispatchAction(id: ActionId, target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('[data-shortcut-recorder="true"]')) return false;
  const action = actionDefinitions.find(action => action.id === id)!;
  return action.inputs || !textInput(target) || (target instanceof Element && Boolean(target.closest(".cm-editor")));
}
export function dispatchKeyboard(event: KeyboardEvent, options: { bindings: ResolvedKeybindings; handlers: ActionHandlers; platform?: Platform; nativeActions?: ReadonlySet<ActionId> }): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.getModifierState("AltGraph")) return false;
  if (event.target instanceof Element && event.target.closest('[data-shortcut-recorder="true"]')) return false;
  const key = shortcutFromEvent(event); if (!key) return false;
  const action = actionDefinitions.find(action => options.bindings[action.id].includes(key)); if (!action) return false;
  // Native menu accelerators own the first binding; aliases stay in the webview.
  if (options.nativeActions?.has(action.id) && options.bindings[action.id][0] === key) return false;
  if (!canDispatchAction(action.id, event.target)) return false;
  const handler = options.handlers[action.id]; if (!handler) return false;
  event.preventDefault(); event.stopPropagation(); handler(); return true;
}
/** Only primary native accelerators are installed. Alternate keys use the same webview dispatcher. */
export function nativeMenuBindings(bindings: ResolvedKeybindings): Record<string, string[]> {
  return Object.fromEntries(actionDefinitions.map(action => [action.id, bindings[action.id].slice(0, 1)]));
}
