/**
 * Pure mappings behind the language server popover and the status bar item: the five visible states,
 * the pill word, capability chips, the list filter, the worst state for the top bar badge, and the
 * hold that keeps a short indexing burst from flickering the dot.
 */
import type { CapabilitiesDto } from "../bindings";

/** The detailed states the hub view model knows. Mirrors HubStateKind in stores/language-intelligence. */
export type LanguageKind =
  | "unknown" | "unavailable" | "disabled" | "idle" | "needs-install" | "installing" | "starting" | "working"
  | "ready" | "runtime-missing" | "install-failed" | "failed" | "crashed";

/** What a dot, a pill and the status bar show. */
export type LanguageState = "ready" | "starting" | "error" | "off" | "needs-trust";

export function languageState(kind: LanguageKind, needsTrust = false): LanguageState {
  switch (kind) {
    case "ready": return needsTrust ? "needs-trust" : "ready";
    case "working": case "starting": case "installing": case "unknown": return "starting";
    case "disabled": case "idle": case "needs-install": return "off";
    default: return "error";
  }
}

/** The word in the header pill. The percent lives in the status line, so the pill keeps a steady width. */
export function pillLabel(kind: LanguageKind, needsTrust = false): string {
  switch (kind) {
    case "ready": return needsTrust ? "Needs trust" : "Ready";
    case "working": return "Indexing";
    case "installing": return "Installing";
    case "starting": return "Starting";
    case "unknown": return "Checking";
    case "disabled": return "Off";
    case "idle": return "Not started";
    case "needs-install": return "Not installed";
    case "runtime-missing": return "Needs runtime";
    case "install-failed": return "Install failed";
    case "crashed": return "Stopped";
    case "unavailable": return "Unavailable";
    default: return "Error";
  }
}

/** "Installing 42%": the pill word with the percent, for the status bar tooltip. */
export const withPercent = (label: string, percent?: number) => percent === undefined ? label : `${label} ${Math.max(0, Math.min(100, Math.round(percent)))}%`;

/** "Rust, rust-analyzer 2026-10-12, ready". Without a server: "Markdown, no language support". */
export function statusTooltip(language: string, server: string | undefined, pill: string | undefined): string {
  if (!server || !pill) return `${language}, no language support`;
  return `${language}, ${server}, ${pill.toLowerCase()}`;
}

export interface CapabilityChip { id: string; label: string; on: boolean }
export const capabilitySpecs: readonly { id: string; label: string }[] = [
  { id: "completion", label: "Completions" }, { id: "diagnostics", label: "Diagnostics" }, { id: "hover", label: "Hover" },
  { id: "definition", label: "Definition" }, { id: "references", label: "References" }, { id: "rename", label: "Rename" }, { id: "format", label: "Format" },
];

export function capabilityOn(id: string, caps: CapabilitiesDto | undefined | null): boolean {
  if (!caps) return false;
  switch (id) {
    case "completion": return caps.completion;
    case "diagnostics": return true;
    case "hover": return caps.hover;
    case "definition": return caps.definition;
    case "references": return caps.references;
    case "rename": return caps.rename;
    case "format": return caps.formatting || caps.rangeFormatting;
    default: return false;
  }
}

/** All seven chips, in a fixed order. Only a running server lights any of them. */
export function capabilityChips(kind: LanguageKind, caps: CapabilitiesDto | undefined | null): CapabilityChip[] {
  const running = kind === "ready" || kind === "working";
  return capabilitySpecs.map(spec => ({ ...spec, on: running && capabilityOn(spec.id, caps) }));
}

export type RowFilter = "all" | "active";
export interface FilterableRow { name: string; technical: string; enabled: boolean }
/** The list after the segmented filter and the search text. */
export function filterRows<T extends FilterableRow>(rows: readonly T[], filter: RowFilter, query = ""): T[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(row => (filter === "all" || row.enabled) && (!needle || row.name.toLowerCase().includes(needle) || row.technical.toLowerCase().includes(needle)));
}
/** The All / Active switch is shown only when it changes the list. */
export const filterUseful = (rows: readonly FilterableRow[]) => rows.some(row => row.enabled) && rows.some(row => !row.enabled);
/** A search field earns its place only in a long list. */
export const SEARCH_THRESHOLD = 8;
export const searchUseful = (rows: readonly unknown[]) => rows.length > SEARCH_THRESHOLD;

/** The badge on the top bar button: an error anywhere wins over an untrusted folder. Off servers do not count. */
export function worstState(rows: readonly { state: LanguageState; enabled: boolean }[], needsTrust: boolean): "error" | "needs-trust" | undefined {
  if (rows.some(row => row.enabled && row.state === "error")) return "error";
  return needsTrust || rows.some(row => row.enabled && row.state === "needs-trust") ? "needs-trust" : undefined;
}

/** How long a ready server must stay busy before the dot starts pulsing. */
export const SETTLE_MS = 400;
/**
 * The state to show. Leaving Ready for a short busy burst (a quick indexing pass) waits `delay`
 * milliseconds; every other change, and every change back to Ready, shows at once.
 */
export function settleState(shown: LanguageState, next: LanguageState, nextForMs: number, delay = SETTLE_MS): LanguageState {
  if (shown === "ready" && next === "starting" && nextForMs < delay) return shown;
  return next;
}
