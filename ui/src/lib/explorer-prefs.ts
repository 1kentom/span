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
