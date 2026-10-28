/**
 * Every user facing sentence of the language intelligence hub lives here, so the wording can be
 * reviewed in one place. Plain language, no server jargon without a human name next to it.
 */
import type { LanguageServerId } from "../bindings";

export const hubText = {
  title: "Language intelligence",
  subtitle: "Completions, error checking, hover info and go to definition for your code.",
  thisFile: "This file",
  allLanguages: "All languages",
  settingsLink: "Language server settings",
  previewLabel: "Preview fixture, not a real language server",
  noFile: "Open a file to see which language features it has.",
  noServer: "No language support is available for this file type. You can still edit it normally.",
  unavailable: "Language support status could not be read. You can keep editing, but completions and error checking may be missing.",
  unavailableShort: "Status unavailable",
  keepEditing: "You can keep editing.",
  restarting: (name: string) => `Restarting ${name} with project dependencies…`,
  closePanel: "Close language intelligence",
  technicalDetails: "Technical details",
  copyDetails: "Copy details",
  copiedDetails: "Copied",
  stopTrusting: "Stop trusting",
  trustFolder: "Trust folder",
  trustThisFolder: "Trust this folder",
  notNow: "Not now",
  learnMore: "Learn more",
  hideDetails: "Hide details",
  restricted: "Restricted",
  trustedLine: "This folder is trusted, so language support can run its build tools (Maven, Gradle or Cargo).",
  hoverTrustHint: "Library types are not loaded until this folder is trusted.",
} as const;

/** Human language names, as shown on the card. */
export const languageNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Java", vtsls: "TypeScript and JavaScript", html: "HTML", css: "CSS, SCSS and Less", json: "JSON",
  "rust-analyzer": "Rust", basedpyright: "Python",
};
/** One or two words, for the status bar and tooltips. */
export const shortLanguageNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Java", vtsls: "TypeScript", html: "HTML", css: "CSS", json: "JSON", "rust-analyzer": "Rust", basedpyright: "Python",
};
/** The technical name, shown small and grey under the language name. */
export const technicalNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Eclipse JDT LS", vtsls: "vtsls", html: "VS Code HTML language server", css: "VS Code CSS language server",
  json: "VS Code JSON language server", "rust-analyzer": "rust-analyzer", basedpyright: "basedpyright",
};
/** The server ids in the order the "All languages" list shows them. */
export const serverOrder: readonly LanguageServerId[] = ["jdtls", "vtsls", "html", "css", "json", "rust-analyzer", "basedpyright"];
/** Servers that run the project's own build tool, so they depend on folder trust. */
export const projectCodeServers: ReadonlySet<LanguageServerId> = new Set<LanguageServerId>(["jdtls", "rust-analyzer"]);

export const supportName = (id: LanguageServerId) => `${languageNames[id]} support`;
export const technicalLabel = (id: LanguageServerId, version?: string | null) => `${technicalNames[id]}${version ? ` ${version.replace(/^v/i, "")}` : ""}`;
const runtimeFor = (id: LanguageServerId) => id === "jdtls" ? "JDK" : "Node.js";

/** "42 MB", "1.2 GB". Decimal steps are binary on purpose, the same as the backend size hints. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export const approxSize = (bytes?: number | null) => bytes && bytes > 0 ? `About ${formatBytes(bytes)}.` : "";

/** Install progress as a whole number, never above 100. Undefined while the total is unknown. */
export function percentOf(received?: number | null, total?: number | null): number | undefined {
  if (!total || total <= 0 || received === undefined || received === null || received < 0) return undefined;
  return Math.min(100, Math.floor((received / total) * 100));
}

export function installPhaseLine(phase: string | undefined, received?: number | null, total?: number | null): string {
  switch (phase) {
    case "downloading":
      return total && total > 0 ? `Downloading… ${formatBytes(received ?? 0)} of ${formatBytes(total)}` : received ? `Downloading… ${formatBytes(received)} so far` : "Downloading…";
    case "verifying": return "Checking the download…";
    case "extracting": return "Unpacking…";
    case "finalizing": return "Finishing…";
    case "reused": return "Using files already on this computer…";
    case "waitingForLock": return "Waiting for another install to finish…";
    case "cancelled": return "Install cancelled.";
    default: return "Getting ready…";
  }
}

export const needsInstallDetail = (id: LanguageServerId, bytes: number | null | undefined, autoInstall: boolean) =>
  [`${supportName(id)} is not installed. Install it to get completions, error checking and go to definition.`, approxSize(bytes), "You can keep editing while it downloads."].filter(Boolean).join(" ")
  + (autoInstall ? "" : " Automatic install is off, so nothing downloads until you choose Install.");
export const installLabel = (id: LanguageServerId) => `Install ${supportName(id)}`;
export const installingKeepEditing = (id: LanguageServerId) => `You can keep editing. ${languageNames[id]} features switch on by themselves when it is ready.`;
export const startingDetail = (id: LanguageServerId) => `Starting ${supportName(id)}. The first start can take a minute while it reads your project.`;
export const readyDetail = "Ready. Completions, errors, hover and go to definition are on for this file.";
export const crashedDetail = (id: LanguageServerId) => `${supportName(id)} stopped unexpectedly.`;
export const disabledDetail = (id: LanguageServerId) => `${supportName(id)} is turned off.`;
export const idleDetail = (id: LanguageServerId) => `${supportName(id)} has not started yet.`;
export const checkingDetail = (id: LanguageServerId) => `Checking ${supportName(id)}…`;
export const installFailedFallback = (id: LanguageServerId) => `${supportName(id)} could not be installed.`;
export const startFailedFallback = (id: LanguageServerId) => `${supportName(id)} did not start.`;
export const nonRetryable = "Retrying will not fix this. Check the language server settings, then restart.";

export interface RuntimeFacts { name?: string; requiredVersion: number; foundVersion?: string | null; foundPath?: string | null; foundList?: string[] }
/** "Java support needs JDK 25 or newer. Found: JDK 21 at /path. Install a newer JDK, or choose one." */
export function runtimeMissingDetail(id: LanguageServerId, facts: RuntimeFacts): string {
  const runtime = runtimeFor(id);
  const found = facts.foundVersion
    ? `Found: ${runtime} ${facts.foundVersion}${facts.foundPath ? ` at ${facts.foundPath}` : ""}.`
    : facts.foundList?.length ? `Found: ${facts.foundList.map(item => /^\d/.test(item) ? `${runtime} ${item}` : item).join(", ")}.` : `Found: no ${runtime} on this computer.`;
  return `${supportName(id)} needs ${runtime} ${facts.requiredVersion} or newer. ${found} Install a newer ${runtime}, or choose one.`;
}
export const chooseRuntimeLabel = (id: LanguageServerId) => id === "jdtls" ? "Choose JDK folder…" : "Choose Node.js…";
export const chooseRuntimeTitle = (id: LanguageServerId) => id === "jdtls" ? "Choose a JDK folder" : "Choose the Node.js executable";

/** Work the server reports, for example indexing. `title` comes from the server. */
export function workHeadline(title: string | null | undefined, percentage: number | null | undefined): string {
  const lead = !title || /index/i.test(title) ? "Indexing your project" : title.replace(/[….]+$/, "").trim();
  return `${lead}…${percentage === undefined || percentage === null ? "" : ` ${Math.round(percentage)}%`}`;
}
export const workDetail = (id: LanguageServerId) => `${supportName(id)} is still reading your project. Results can be incomplete until it finishes.`;

export const trustBanner = {
  title: "Trust this folder to load project dependencies?",
  body: "Language support needs to run this project's build tool (Maven, Gradle or Cargo) to understand its libraries. Only trust projects you got from a source you trust.",
  more: "Without trust, language support starts in a restricted mode. Your own code still gets completions and error checking, but types that come from libraries are not loaded, so hover and go to definition can come up empty for them. Trusting runs the project's build tool on your computer, the same way opening it in an IDE does. You can stop trusting this folder at any time from this panel.",
} as const;

export interface FeatureChipSpec { id: string; label: string; on: string; off: string }
export const featureChipSpecs: readonly FeatureChipSpec[] = [
  { id: "completion", label: "Completions", on: "Suggestions appear as you type.", off: "Suggestions as you type are not available for this file." },
  { id: "diagnostics", label: "Errors", on: "Problems are underlined as you type.", off: "Error checking is not available for this file." },
  { id: "hover", label: "Hover", on: "Hover a name to see its type and documentation.", off: "Hover info is not available for this file." },
  { id: "definition", label: "Go to definition", on: "Jump to where a name is defined.", off: "Go to definition is not available for this file." },
  { id: "references", label: "References", on: "Find every place a name is used.", off: "Finding references is not available for this file." },
  { id: "rename", label: "Rename", on: "Rename a name everywhere it is used.", off: "Renaming across files is not available for this file." },
  { id: "format", label: "Format", on: "Tidy the file with the language's formatter.", off: "Formatting is not available for this file." },
];
export const chipsWaiting = (id: LanguageServerId) => `Available once ${supportName(id)} is ready.`;

/** Short state words for the "All languages" rows. */
export function rowStateText(kind: string, percent?: number): string {
  switch (kind) {
    case "ready": return "Ready";
    case "working": return percent === undefined ? "Indexing" : `Indexing ${percent}%`;
    case "installing": return percent === undefined ? "Installing" : `Installing ${percent}%`;
    case "starting": return "Starting";
    case "needs-install": return "Not installed";
    case "runtime-missing": return "Needs a runtime";
    case "install-failed": return "Install failed";
    case "failed": return "Problem";
    case "crashed": return "Stopped";
    case "disabled": return "Off";
    case "idle": return "Not started";
    case "unavailable": return "Unavailable";
    default: return "Checking";
  }
}

/** Status bar summary, for example "Java: installing 42%". */
export function statusBarText(id: LanguageServerId, kind: string, percent?: number, restricted = false): string {
  const name = shortLanguageNames[id];
  const word = (() => {
    switch (kind) {
      case "ready": return restricted ? "ready (restricted)" : "ready";
      case "working": return percent === undefined ? "indexing" : `indexing ${percent}%`;
      case "installing": return percent === undefined ? "installing" : `installing ${percent}%`;
      case "starting": return "starting";
      case "needs-install": return "not installed";
      case "runtime-missing": return `needs ${runtimeFor(id)}`;
      case "install-failed": case "failed": return "needs attention";
      case "crashed": return "stopped";
      case "disabled": return "off";
      case "idle": return "idle";
      case "unavailable": return "status unavailable";
      default: return "checking";
    }
  })();
  return `${name}: ${word}`;
}

/** Spoken and tooltip summary, always built from the same numbers as the panel. */
export function buttonSummary(id: LanguageServerId | undefined, kind: string, percent?: number, restricted = false): string {
  if (!id) return "No language support for this file";
  const name = supportName(id);
  switch (kind) {
    case "installing": return percent === undefined ? `Installing ${name}` : `Installing ${name} (${percent}%)`;
    case "working": return percent === undefined ? `${name} is indexing your project` : `${name} is indexing your project (${percent}%)`;
    case "starting": return `Starting ${name}`;
    case "ready": return restricted ? `${name} is ready, with this folder restricted` : `${name} is ready`;
    case "needs-install": return `${name} is not installed`;
    case "runtime-missing": return `${name} needs ${runtimeFor(id)}`;
    case "install-failed": case "failed": return `${name} needs attention`;
    case "crashed": return `${name} stopped unexpectedly`;
    case "disabled": return `${name} is turned off`;
    case "idle": return `${name} has not started yet`;
    case "unavailable": return "Language support status is unavailable";
    default: return `Checking ${name}`;
  }
}
