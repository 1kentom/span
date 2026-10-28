import { createSignal } from "solid-js";

// UI-only Explorer preferences kept in the webview. Nothing here touches native settings.
const COMPACT_KEY = "span.explorer.compactFolders";
function read(): boolean {
  try { return window.localStorage.getItem(COMPACT_KEY) !== "false"; } catch { return true; }
}
const [compact, setCompact] = createSignal(read());
export const compactFolders = compact;
export function setCompactFolders(value: boolean) {
  setCompact(value);
  try { window.localStorage.setItem(COMPACT_KEY, String(value)); } catch { /* storage can be unavailable */ }
}

function flag(key: string, fallback: boolean): boolean {
  try { const value = window.localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; }
}
function store(key: string, value: boolean) { try { window.localStorage.setItem(key, String(value)); } catch { /* storage can be unavailable */ } }
const [reveal, setReveal] = createSignal(flag("span.explorer.autoReveal", true));
const [confirm, setConfirm] = createSignal(flag("span.explorer.confirmDelete", true));
/** Reveal the active file in the tree whenever the active tab changes. */
export const autoReveal = reveal;
export const setAutoReveal = (value: boolean) => { setReveal(value); store("span.explorer.autoReveal", value); };
/** Ask before moving files to the Trash. */
export const confirmDelete = confirm;
export const setConfirmDelete = (value: boolean) => { setConfirm(value); store("span.explorer.confirmDelete", value); };
