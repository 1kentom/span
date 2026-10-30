/**
 * Zen mode: only the editor and the agent sidebar stay on screen. The workbench keeps its real layout untouched while
 * zen is on and shows a derived one instead, so leaving zen puts back exactly what was there (VS Code `zenMode.restore`).
 * Zen itself is never persisted: the app always starts in the normal layout.
 */

/** Preferences kept on this device (localStorage), since adding user settings needs the Rust settings schema. */
export interface ZenSettings {
  /** Hide the editor tab strip. */
  hideTabs: boolean;
  /** Hide the line number gutter. The run and fold gutters stay. */
  hideLineNumbers: boolean;
  /** Center the editor with a maximum width while the agent sidebar is closed. */
  centerLayout: boolean;
  /** Enter OS full screen together with zen mode. */
  fullScreen: boolean;
}

export const ZEN_DEFAULTS: Readonly<ZenSettings> = { hideTabs: true, hideLineNumbers: false, centerLayout: false, fullScreen: false };
export const ZEN_SETTINGS_KEY = "span.zenMode.settings";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const browserStorage = (): Storage | undefined => { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } };

/** Saved preferences merged over the defaults. Unknown keys, wrong types and unreadable storage fall back to defaults. */
export function readZenSettings(storage: Storage | undefined = browserStorage()): ZenSettings {
  try {
    const raw = storage?.getItem(ZEN_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (!parsed || typeof parsed !== "object") return { ...ZEN_DEFAULTS };
    const record = parsed as Record<string, unknown>;
    const pick = (key: keyof ZenSettings) => typeof record[key] === "boolean" ? record[key] as boolean : ZEN_DEFAULTS[key];
    return { hideTabs: pick("hideTabs"), hideLineNumbers: pick("hideLineNumbers"), centerLayout: pick("centerLayout"), fullScreen: pick("fullScreen") };
  } catch { return { ...ZEN_DEFAULTS }; }
}

/** Best effort: a private window or blocked storage keeps the preference for this session only. */
export function writeZenSettings(value: ZenSettings, storage: Storage | undefined = browserStorage()): boolean {
  try { storage?.setItem(ZEN_SETTINGS_KEY, JSON.stringify(value)); return !!storage; } catch { return false; }
}

/** The panel fields zen mode reads and restores. Matches the workbench session panels. */
export interface ZenPanels {
  projectCollapsed: boolean;
  assistantCollapsed: boolean;
  terminalCollapsed: boolean;
  projectWidth: number;
  assistantWidth: number;
  terminalHeight: number;
}

/** Everything zen mode puts back on exit. */
export interface ZenLayout<View extends string = string, Tab extends string = string> {
  panels: ZenPanels;
  leftView: View;
  bottomTab: Tab;
  assistantHeld: boolean;
}

/** Panels the user asked for while in zen: they open as overlays and close again without touching the saved layout. */
export interface ZenPeek { project: boolean; terminal: boolean }
export const NO_PEEK: Readonly<ZenPeek> = { project: false, terminal: false };

/**
 * The layout shown while zen is on: the project panel and bottom dock are hidden unless peeked, the agent sidebar and
 * every width are left as they are.
 */
export function zenPanels<P extends ZenPanels>(base: P, peek: ZenPeek = NO_PEEK): P {
  return { ...base, projectCollapsed: !peek.project, terminalCollapsed: !peek.terminal };
}

/** A copy of the layout at the moment zen starts. */
export function captureZenLayout<V extends string, T extends string>(layout: ZenLayout<V, T>): ZenLayout<V, T> {
  return { panels: { ...layout.panels }, leftView: layout.leftView, bottomTab: layout.bottomTab, assistantHeld: layout.assistantHeld };
}

/**
 * The layout to put back on exit: the snapshot wins for every field zen mode tracks, so an agent sidebar toggled or
 * resized during zen, or a Search peek that switched the left view, returns to how it was. Fields the snapshot does not
 * know (added to the session later) keep their current value.
 */
export function restoreZenLayout<P extends ZenPanels, V extends string, T extends string>(snapshot: ZenLayout<V, T>, current: { panels: P }): { panels: P; leftView: V; bottomTab: T; assistantHeld: boolean } {
  return { panels: { ...current.panels, ...snapshot.panels }, leftView: snapshot.leftView, bottomTab: snapshot.bottomTab, assistantHeld: snapshot.assistantHeld };
}

/** What the workbench draws in zen, from the preferences and what is open. */
export interface ZenChrome { tabs: boolean; lineNumbers: boolean; centered: boolean }
export function zenChrome(settings: ZenSettings, context: { assistantOpen: boolean; agentsMode: boolean }): ZenChrome {
  return {
    tabs: !settings.hideTabs,
    lineNumbers: !settings.hideLineNumbers,
    // Centering only makes sense with room on both sides: never next to the agent sidebar, never on the Agents page.
    centered: settings.centerLayout && !context.assistantOpen && !context.agentsMode,
  };
}

/** Class names for the workbench root. Empty outside zen. */
export function zenClasses(active: boolean, chrome: ZenChrome, agentsMode: boolean): string {
  if (!active) return "";
  return ["zen", agentsMode ? "zen-agents" : "", chrome.tabs ? "" : "zen-no-tabs", chrome.lineNumbers ? "" : "zen-no-line-numbers", chrome.centered ? "zen-centered" : ""].filter(Boolean).join(" ");
}

/** Two Escape presses within this many milliseconds leave zen. */
export const DOUBLE_ESCAPE_MS = 500;

/**
 * Escape twice leaves zen, but only presses nobody else answered count: an Escape that closed a popover, the find
 * panel or a completion, or stopped the agent, resets the sequence instead.
 */
export function createDoubleEscape(windowMs = DOUBLE_ESCAPE_MS) {
  let last: number | undefined;
  return {
    /** Records one press. True when it completes a double press. */
    press(consumed: boolean, now: number): boolean {
      if (consumed) { last = undefined; return false; }
      if (last !== undefined && now - last <= windowMs) { last = undefined; return true; }
      last = now;
      return false;
    },
    reset() { last = undefined; },
  };
}
