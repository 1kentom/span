/** Editor actions are shared by the command palette, key dispatcher, and settings. */
export const actionDefinitions = [
  { id: "quickOpen", label: "Go to File", category: "Navigation", keys: ["Mod+P"], inputs: true },
  { id: "toggleFiles", label: "Toggle Files", category: "Navigation", keys: ["Mod+E"], inputs: true },
  { id: "focusFiles", label: "Show Files", category: "Navigation", keys: ["Mod+Shift+E"], inputs: true },
  { id: "openFile", label: "Open File", category: "File", keys: [], inputs: true },
  { id: "commandPalette", label: "Show All Commands", category: "Navigation", keys: ["Mod+Shift+P"], inputs: true },
  { id: "findInFile", label: "Find in File", category: "Editor", keys: ["Mod+F"], inputs: false },
  { id: "searchWorkspace", label: "Search in Files", category: "Navigation", keys: ["Mod+Shift+F"], inputs: true },
  { id: "showSourceControl", label: "Show Source Control", category: "Navigation", keys: ["Ctrl+Shift+G"], inputs: true },
  { id: "nextGitChange", label: "Next Git Change", category: "Git", keys: ["Alt+F5"], inputs: false },
  { id: "previousGitChange", label: "Previous Git Change", category: "Git", keys: ["Alt+Shift+F5"], inputs: false },
  { id: "toggleGitBlame", label: "Toggle Git Blame", category: "Git", keys: [], inputs: false },
  { id: "settings", label: "Open Settings", category: "Preferences", keys: ["Mod+,"], inputs: true },
  { id: "closeTab", label: "Close Editor Tab", category: "File", keys: ["Mod+W"], inputs: true },
  { id: "save", label: "Save File", category: "File", keys: ["Mod+S"], inputs: true },
  { id: "openFolder", label: "Open Folder", category: "File", keys: ["Mod+O"], inputs: true },
  { id: "splitEditor", label: "Split Editor", category: "View", keys: ["Mod+\\"], inputs: true },
  { id: "splitEditorDown", label: "Split Editor Down", category: "View", keys: ["Mod+Alt+\\"], inputs: true },
  { id: "newFile", label: "New File", category: "File", keys: ["Mod+N"], inputs: true },
  { id: "newFolder", label: "New Folder", category: "File", keys: ["Mod+Shift+N"], inputs: true },
  { id: "newFromTemplate", label: "New from Template", category: "File", keys: ["Alt+Insert"], inputs: true },
  { id: "toggleProject", label: "Toggle Project Panel", category: "View", keys: ["Mod+B"], inputs: true },
  { id: "toggleAssistant", label: "Toggle AI Assistant", category: "View", keys: ["Mod+Alt+B"], inputs: true },
  { id: "toggleTerminal", label: "Toggle Terminal Panel", category: "View", keys: ["Mod+J"], inputs: true },
  { id: "toggleWordWrap", label: "Toggle Word Wrap", category: "View", keys: ["Alt+Z"], inputs: false },
  { id: "markdownPreview", label: "Toggle Markdown Preview", category: "Editor", keys: ["Mod+Shift+V"], inputs: false },
  { id: "formatDocument", label: "Format Document", category: "Editor", keys: ["Alt+Shift+F"], inputs: false },
  { id: "formatWithLanguageServer", label: "Format with Language Server", category: "Editor", keys: ["Mod+Alt+Shift+F"], inputs: false },
  { id: "zoomIn", label: "Zoom In", category: "View", keys: ["Mod+=", "Mod+Shift+="], inputs: true },
  { id: "zoomOut", label: "Zoom Out", category: "View", keys: ["Mod+-"], inputs: true },
  { id: "resetZoom", label: "Reset Zoom", category: "View", keys: ["Mod+0"], inputs: true },
  { id: "goToLine", label: "Go to Line", category: "Editor", keys: ["Ctrl+G", "Mod+Alt+G"], inputs: false },
  // Code navigation. Each id dispatches to the registry in navigation-actions.ts. Defaults were checked against every default above,
  // the native menu, CodeMirror's default, search, fold, completion and history keymaps and the hard coded editor keymap.
  { id: "goToDefinition", label: "Go to Definition", category: "Navigation", keys: ["F12"], inputs: false },
  { id: "goToTypeDefinition", label: "Go to Type Definition", category: "Navigation", keys: ["Mod+Shift+F12"], inputs: false },
  { id: "goToImplementation", label: "Go to Implementation", category: "Navigation", keys: ["Mod+F12"], inputs: false },
  { id: "peekDefinition", label: "Peek Definition", category: "Navigation", keys: ["Alt+F12"], inputs: false },
  { id: "peekTypeDefinition", label: "Peek Type Definition", category: "Navigation", keys: [], inputs: false },
  { id: "peekImplementation", label: "Peek Implementation", category: "Navigation", keys: [], inputs: false },
  { id: "findReferences", label: "Find All References", category: "Navigation", keys: ["Shift+F12"], inputs: false },
  { id: "peekReferences", label: "Peek References", category: "Navigation", keys: ["Shift+Alt+F12"], inputs: false },
  { id: "goToSymbolInFile", label: "Go to Symbol in File", category: "Navigation", keys: ["Mod+Shift+O"], inputs: false },
  { id: "goToSymbolInWorkspace", label: "Go to Symbol in Workspace", category: "Navigation", keys: ["Mod+T"], inputs: true },
  { id: "quickInfo", label: "Show Quick Definition", category: "Navigation", keys: ["Mod+Shift+I"], inputs: false },
  { id: "showCallHierarchy", label: "Show Call Hierarchy", category: "Navigation", keys: ["Shift+Alt+H"], inputs: false },
  { id: "showTypeHierarchy", label: "Show Type Hierarchy", category: "Navigation", keys: ["Mod+Alt+H"], inputs: false },
  { id: "renameSymbol", label: "Rename Symbol", category: "Navigation", keys: ["F2"], inputs: false },
  { id: "goBack", label: "Go Back", category: "Navigation", keys: ["Mod+Alt+ArrowLeft"], inputs: true },
  { id: "goForward", label: "Go Forward", category: "Navigation", keys: ["Mod+Alt+ArrowRight"], inputs: true },
  { id: "focusBreadcrumbs", label: "Focus Breadcrumbs", category: "Navigation", keys: ["Mod+Shift+."], inputs: true },
  { id: "showUsage", label: "Show Usage", category: "View", keys: [], inputs: true },
] as const;
/** Colourable syntax tokens. Identical to `SYNTAX_TOKEN_IDS` in crates/core/src/settings.rs (a test compares them). */
export const syntaxTokenIds = ["keyword", "controlKeyword", "operator", "punctuation", "comment", "docComment", "string", "number", "constant", "boolean", "function", "method", "type", "class", "interface", "enum", "typeParameter", "variable", "parameter", "property", "namespace", "importPath", "annotation", "macro", "label", "tag", "attribute", "regexp", "escape", "invalid"] as const;
export type SyntaxTokenId = typeof syntaxTokenIds[number];
/** Identical to `SYNTAX_THEMES` in crates/core/src/settings.rs. */
export const syntaxThemeIds = ["dark", "light", "purple"] as const;
export type SyntaxThemeId = typeof syntaxThemeIds[number];
/** Defaults added after shortcuts could be saved. An existing explicit binding that claims one of these keys wins and only the default is dropped. */
const inheritedDefaultIds: ReadonlySet<string> = new Set(["toggleFiles", "focusFiles", "showSourceControl", "nextGitChange", "previousGitChange", "toggleGitBlame", "splitEditorDown", "newFile", "newFolder", "newFromTemplate", "goToDefinition", "goToTypeDefinition", "goToImplementation", "peekDefinition", "peekTypeDefinition", "peekImplementation", "findReferences", "peekReferences", "goToSymbolInFile", "goToSymbolInWorkspace", "quickInfo", "showCallHierarchy", "showTypeHierarchy", "renameSymbol", "goBack", "goForward", "focusBreadcrumbs"]);
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
const namedKeys: Record<string, string> = { equal: "=", numpadequal: "=", plus: "=", numpadplus: "=", numpadadd: "=", minus: "-", numpadminus: "-", numpadsubtract: "-", numpad0: "0", esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight" };
export function normalizeShortcut(value: string, platform?: Platform): string | undefined {
  const plusKey = /\+\+$/.test(value.trim());
  const tokens = (plusKey ? `${value.trim().slice(0, -1)}Plus` : value).split("+").map(token => token.trim());
  if (tokens.some(token => !token)) return;
  // A function key may stand alone (F12, F2); every other key needs a command modifier.
  if (tokens.length < 2 && !/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(tokens[0] ?? "")) return;
  const modifiers = new Set<string>(); let key: string | undefined;
  for (const token of tokens) {
    let modifier = modifierNames[token.toLowerCase()];
    if (modifier === "Mod" && platform) modifier = platform === "mac" ? "Meta" : "Ctrl";
    if (modifier) { if (modifiers.has(modifier)) return; modifiers.add(modifier); continue; }
    if (key) return;
    if (token.toLowerCase() === "plus") modifiers.add("Shift");
    key = namedKeys[token.toLowerCase()] || (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(token) ? token.toUpperCase() : /^[a-z0-9`\\,./;'\[\]\-=]$/i.test(token) ? token.toUpperCase() : undefined);
    if (!key) return;
  }
  // Modified shortcuts preserve ordinary typing and native text navigation.
  if (!key || (!["Mod", "Meta", "Ctrl", "Alt"].some(mod => modifiers.has(mod)) && !/^F\d+$/.test(key))) return;
  return [...modifierOrder.filter(mod => modifiers.has(mod)), key].join("+");
}
export function resolveKeybindings(overrides: KeybindingOverrides = {}, platform: Platform = currentPlatform()): ResolvedKeybindings {
  const claimed = new Set(Object.values(overrides).flatMap(keys => keys.map(key => normalizeShortcut(key, platform))));
  return Object.fromEntries(actionDefinitions.map(action => {
    const defaults: readonly string[] = action.id === "quickOpen" && platform === "mac" ? [...action.keys, "Ctrl+P"] : action.keys;
    // A newly introduced default must not invalidate an existing explicit binding.
    const inherited = inheritedDefaultIds.has(action.id) ? defaults.filter(key => !claimed.has(normalizeShortcut(key, platform))) : defaults;
    const keys = Object.hasOwn(overrides, action.id) ? overrides[action.id] : inherited;
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
      else if (key.endsWith("+Q") && key.split("+").some(part => part === "Meta" || part === "Ctrl")) issues.push({ action, message: "Quit is reserved by the application. Choose another shortcut." });
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
  const key = punctuation[event.code] || (event.key === "+" ? "=" : event.key === "Equal" ? "=" : event.key === "Minus" ? "-" : undefined) || optionLetter || (event.key === " " ? "Space" : event.key);
  return normalizeShortcut([...event.metaKey ? ["Meta"] : [], ...event.ctrlKey ? ["Ctrl"] : [], ...event.altKey ? ["Alt"] : [], ...event.shiftKey ? ["Shift"] : [], key].join("+"));
}
/** These labels describe the actual focus checks below, not an editable expression language. */
export function actionContext(id: ActionId): { label: string; description: string } {
  const action = actionDefinitions.find(action => action.id === id)!;
  return action.inputs
    ? { label: "Workbench", description: "Available throughout the workbench, except while recording a shortcut." }
    : { label: "Editor or non-text focus", description: "Available in the editor or outside text inputs. Ignored in other text fields and while recording a shortcut." };
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
/**
 * Actions that only the keyboard dispatcher and the command palette handle. The native menu has no item
 * for them (none today: the language server format and the navigation actions all have a menu item), and sending one makes `sync_native_menu` fail with "Unknown native menu action".
 * `commands.test.ts` checks this list against the ids in `apps/desktop/src/menu.rs`.
 */
const uiOnlyActions: ReadonlySet<string> = new Set<string>([]);

export function nativeMenuBindings(bindings: ResolvedKeybindings): Record<string, string[]> {
  return Object.fromEntries(actionDefinitions.filter(action => !uiOnlyActions.has(action.id)).map(action => {
    const primary = bindings[action.id][0];
    // Native Alt-letter accelerators consume Option characters before a text field can receive them.
    const textSensitive = !action.inputs && primary?.startsWith("Alt+");
    return [action.id, textSensitive ? [] : bindings[action.id].slice(0, 1)];
  }));
}
