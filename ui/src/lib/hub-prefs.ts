import { createSignal } from "solid-js";

// UI-only preference kept in the webview: whether the "All languages" list in the panel is open. Closed by default.
const KEY = "span.languageIntelligence.allLanguagesOpen";
function read(): boolean {
  try { return window.localStorage.getItem(KEY) === "true"; } catch { return false; }
}
const [open, setOpen] = createSignal(read());
export const allLanguagesOpen = open;
export function setAllLanguagesOpen(value: boolean) {
  setOpen(value);
  try { window.localStorage.setItem(KEY, String(value)); } catch { /* storage can be unavailable */ }
}
