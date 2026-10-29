import { createSignal } from "solid-js";
import type { ExplorerLegacyPreferences_Deserialize as LegacyPreferences, Settings_Serialize as Settings } from "../bindings";

const COMPACT_KEY = "span.explorer.compactFolders";
const AUTO_REVEAL_KEY = "span.explorer.autoReveal";
const CONFIRM_DELETE_KEY = "span.explorer.confirmDelete";
const LEGACY_KEYS: Record<string, string> = {
  compactFolders: COMPACT_KEY,
  autoReveal: AUTO_REVEAL_KEY,
  confirmDelete: CONFIRM_DELETE_KEY,
};

function flag(key: string, fallback: boolean): boolean {
  try { const value = window.localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; }
}
function store(key: string, value: boolean) { try { window.localStorage.setItem(key, String(value)); } catch { /* storage can be unavailable */ } }

const [compact, setCompact] = createSignal(flag(COMPACT_KEY, true));
/** Compatibility accessors for the old preview and context-menu wiring. */
export const compactFolders = compact;
export function setCompactFolders(value: boolean) { setCompact(value); store(COMPACT_KEY, value); }
const [reveal, setReveal] = createSignal(flag(AUTO_REVEAL_KEY, true));
/** Reveal the active file in the tree whenever the active tab changes. */
export const autoReveal = reveal;
export const setAutoReveal = (value: boolean) => { setReveal(value); store(AUTO_REVEAL_KEY, value); };
const [confirm, setConfirm] = createSignal(flag(CONFIRM_DELETE_KEY, true));
/** Ask before moving files to the Trash. */
export const confirmDelete = confirm;
export const setConfirmDelete = (value: boolean) => { setConfirm(value); store(CONFIRM_DELETE_KEY, value); };

export type ExplorerPreferences = Required<NonNullable<Settings["explorer"]>>;

/** Use typed settings whenever present. Legacy storage is a fallback only for older previews. */
export function explorerPreferences(settings: Settings): ExplorerPreferences {
  const typed = settings.explorer;
  if (typed) return typed;
  return {
    showHiddenFiles: true,
    showIgnoredFiles: false,
    compactFolders: compact(),
    autoReveal: reveal(),
    confirmDelete: confirm(),
  };
}

/** Values from the three local-storage keys understood by the one-time settings migration. */
export function legacyExplorerPreferences(): LegacyPreferences {
  return {
    compactFolders: flagValue(COMPACT_KEY),
    autoReveal: flagValue(AUTO_REVEAL_KEY),
    confirmDelete: flagValue(CONFIRM_DELETE_KEY),
  };
}
function flagValue(key: string): boolean | null {
  try { const value = window.localStorage.getItem(key); return value === null ? null : value === "true"; } catch { return null; }
}

/** Remove only the exact legacy keys the backend says were resolved. */
export function resolveLegacyExplorerPreferences(keys: readonly string[]): void {
  try { for (const key of keys) { const storageKey = LEGACY_KEYS[key]; if (storageKey) window.localStorage.removeItem(storageKey); } } catch { /* storage can be unavailable */ }
}
