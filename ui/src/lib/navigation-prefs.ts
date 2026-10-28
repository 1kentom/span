import { createSignal } from "solid-js";

// UI-only navigation preferences kept in the webview, like explorer-prefs. Nothing here touches native settings.
export type SymbolSort = "position" | "name" | "type";
export const symbolSorts: readonly SymbolSort[] = ["position", "name", "type"];

function readKey(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function writeKey(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* storage can be unavailable */ } }

const [showPath, setShowPath] = createSignal(readKey("span.breadcrumbs.symbolPath") !== "false");
const [sort, setSort] = createSignal<SymbolSort>((symbolSorts as readonly string[]).includes(readKey("span.breadcrumbs.symbolSort") ?? "") ? readKey("span.breadcrumbs.symbolSort") as SymbolSort : "position");
const [keepPeek, setKeepPeek] = createSignal(readKey("span.peek.stable") === "true");

/** Show the symbol path (File > Class > method) in the breadcrumb bar. Default on. */
export const showSymbolPath = showPath;
export const setShowSymbolPath = (value: boolean) => { setShowPath(value); writeKey("span.breadcrumbs.symbolPath", String(value)); };
/** Order of the sibling dropdown of a symbol crumb. Default is source position. */
export const symbolSortOrder = sort;
export const setSymbolSortOrder = (value: SymbolSort) => { setSort(value); writeKey("span.breadcrumbs.symbolSort", value); };
/** Like VS Code's `editor.stablePeek`: a double click inside a peek does not close it. Default off. */
export const keepPeekOpen = keepPeek;
export const setKeepPeekOpen = (value: boolean) => { setKeepPeek(value); writeKey("span.peek.stable", String(value)); };
