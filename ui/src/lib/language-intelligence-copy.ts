/**
 * Every user facing sentence of the language intelligence hub lives here, so the wording can be
 * reviewed in one place. Plain language, no server jargon without a human name next to it.
 */
import type { LanguageServerId } from "../bindings";

export const hubText = {
  title: "Language intelligence",
  allLanguages: "All languages",
  settingsLink: "Language server settings",
  previewTag: "preview",
  noFile: "Open a file to see its language features.",
  noServer: "No language support for this file type.",
  unavailable: "Status unavailable. Try again.",
  restarting: (name: string) => `Restarting ${name} with its dependencies`,
  copyDetails: "Copy details",
  copiedDetails: "Copied",
  stopTrusting: "Stop trusting",
  trustFolder: "Trust folder",
  notNow: "Not now",
  trustedFolder: "Trusted folder",
  untrustedFolder: "Untrusted folder",
  why: "Why?",
  closeTrust: "Dismiss",
  hoverTrustHint: "Library types are not loaded until this folder is trusted.",
  languages: "Languages",
  filterAll: "All",
  filterActive: "Active",
  filterLabel: "Show languages",
  search: "Filter languages",
  noMatches: "No languages match.",
  more: "More actions",
  restart: "Restart",
  stop: "Stop",
  trust: "Trust",
  capabilities: "Capabilities",
  unsupported: "not supported",
  noServerName: "No language support",
  trustShort: "Build tools stay off, so library types are not loaded. Trust only folders you know.",
  /** A file whose language has no server in the catalog. There is nothing to install, so say what still works. */
  noServerFor: (language: string) => `No completions or error checking for ${language}. Editing works as usual.`,
} as const;

/** Human language names, as shown in the panel header. */
export const languageNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Java", vtsls: "TypeScript and JavaScript", html: "HTML", css: "CSS, SCSS and Less", json: "JSON",
  "rust-analyzer": "Rust", basedpyright: "Python",
};
/** One or two words, for the status bar, the list rows and tooltips. */
export const shortLanguageNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Java", vtsls: "TypeScript", html: "HTML", css: "CSS", json: "JSON", "rust-analyzer": "Rust", basedpyright: "Python",
};
/** The technical name, shown small and muted under the language name. */
export const technicalNames: Readonly<Record<LanguageServerId, string>> = {
  jdtls: "Eclipse JDT LS", vtsls: "vtsls", html: "VS Code HTML", css: "VS Code CSS",
  json: "VS Code JSON", "rust-analyzer": "rust-analyzer", basedpyright: "basedpyright",
};
/** The server ids in the order the "All languages" list shows them. */
export const serverOrder: readonly LanguageServerId[] = ["jdtls", "vtsls", "html", "css", "json", "rust-analyzer", "basedpyright"];
/** Servers that run the project's own build tool, so they depend on folder trust. */
export const projectCodeServers: ReadonlySet<LanguageServerId> = new Set<LanguageServerId>(["jdtls", "rust-analyzer"]);

export const supportName = (id: LanguageServerId) => `${languageNames[id]} support`;
/** "Eclipse JDT LS 1.62": major and minor only. A build suffix such as "-202610131109" is dropped. */
export function shortVersion(version?: string | null): string {
  const clean = (version ?? "").trim().replace(/^v/i, "");
  return /^(\d+\.\d+)(?:[.+-].*)?$/.exec(clean)?.[1] ?? clean;
}
export const technicalLabel = (id: LanguageServerId, version?: string | null) => [technicalNames[id], shortVersion(version)].filter(Boolean).join(" ");
const runtimeFor = (id: LanguageServerId) => id === "jdtls" ? "JDK" : "Node.js";

/** "42 MB", "1.2 GB". Decimal steps are binary on purpose, the same as the backend size hints. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Install progress as a whole number, never above 100. Undefined while the total is unknown. */
export function percentOf(received?: number | null, total?: number | null): number | undefined {
  if (!total || total <= 0 || received === undefined || received === null || received < 0) return undefined;
  return Math.min(100, Math.floor((received / total) * 100));
}

/** The percent text of the panel and the status bar. A fixed shape, so digits never move the layout around it. */
export const percentText = (percent: number | undefined) => percent === undefined ? "" : `${Math.max(0, Math.min(100, Math.round(percent)))}%`;

/** "128 of 320 MB": the unit is written once when both sides share it. */
export function bytesPair(received: number, total: number): string {
  const [a, b] = [formatBytes(received), formatBytes(total)];
  const unit = b.split(" ")[1];
  return a.endsWith(` ${unit}`) ? `${a.slice(0, -unit.length - 1)} of ${b}` : `${a} of ${b}`;
}

/** One short phrase per install phase. */
export function installPhaseLine(phase: string | undefined, received?: number | null, total?: number | null): string {
  switch (phase) {
    case "downloading":
      return total && total > 0 ? `Downloading ${bytesPair(received ?? 0, total)}` : received ? `Downloading ${formatBytes(received)}` : "Downloading";
    case "verifying": return "Checking the download";
    case "extracting": return "Unpacking";
    case "finalizing": return "Finishing";
    case "reused": return "Using files already here";
    case "waitingForLock": return "Waiting for another install";
    case "cancelled": return "Install cancelled";
    default: return "Getting ready";
  }
}

export const needsInstallLine = (bytes?: number | null) => bytes && bytes > 0 ? `Install for completions and errors (about ${formatBytes(bytes)})` : "Install for completions and errors";
export const needsInstallTip = (autoInstall: boolean) => autoInstall ? "You can keep editing while it downloads." : "You can keep editing while it downloads. Automatic install is off.";
export const startingLine = "The first start can take a minute";
export const startingTip = "Features turn on by themselves when it is ready.";
export const workLine = "Reading your project";
export const workTip = "Results can be incomplete until it finishes.";
export const crashedLine = "Stopped unexpectedly";
export const disabledLine = "Turn on for completions and errors";
export const idleLine = "Not started yet";
export const checkingLine = "Checking";
export const installFailedLine = (retryable: boolean) => retryable ? "Couldn't install. Check your connection" : "Couldn't install. Check the settings";
export const startFailedLine = "Didn't start. Try restarting";
export const nonRetryable = "Retrying will not fix this. Check the settings, then restart.";

export interface RuntimeFacts { name?: string; requiredVersion: number; foundVersion?: string | null; foundPath?: string | null; foundList?: string[] }
/** "Needs JDK 25 or newer. Found JDK 21" */
export function runtimeMissingLine(id: LanguageServerId, facts: RuntimeFacts): string {
  const runtime = runtimeFor(id);
  const found = facts.foundVersion ? `Found ${runtime} ${facts.foundVersion}`
    : facts.foundList?.length ? `Found ${facts.foundList.map(item => /^\d/.test(item) ? `${runtime} ${item}` : item).join(", ")}` : `No ${runtime} found`;
  return `Needs ${runtime} ${facts.requiredVersion} or newer. ${found}`;
}
export const runtimeMissingTip = (id: LanguageServerId, facts: RuntimeFacts) =>
  [facts.foundPath ? `Found at ${facts.foundPath}.` : "", `Install a newer ${runtimeFor(id)}, or choose one.`].filter(Boolean).join(" ");
export const chooseRuntimeLabel = (id: LanguageServerId) => id === "jdtls" ? "Choose JDK" : "Choose Node.js";
export const chooseRuntimeTitle = (id: LanguageServerId) => id === "jdtls" ? "Choose a JDK folder" : "Choose the Node.js executable";

/** The trust prompt over the editor, and the long explanation in the panel footer tooltip. */
export const trustPrompt = {
  question: "Trust this folder to load its dependencies?",
  explain: "Build tools (Maven, Gradle, Cargo) run to load libraries. Only trust folders from a source you trust. Without trust, library types are not loaded.",
} as const;

export interface FeatureSpec { id: string; label: string }
export const featureSpecs: readonly FeatureSpec[] = [
  { id: "completion", label: "completions" }, { id: "diagnostics", label: "errors" }, { id: "hover", label: "hover" },
  { id: "definition", label: "go to definition" }, { id: "references", label: "references" }, { id: "rename", label: "rename" }, { id: "format", label: "format" },
];
/** "Completions, errors, hover": only what is on. */
export function featuresLine(on: readonly string[]): string {
  const text = featureSpecs.filter(spec => on.includes(spec.id)).map(spec => spec.label).join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Ready";
}

/** The word next to the dot in the panel header, only for states where it adds something. */
export function headerWord(kind: string): string {
  switch (kind) {
    case "installing": return "Installing";
    case "starting": return "Starting";
    case "working": return "Indexing";
    case "disabled": return "Off";
    default: return "";
  }
}
/** The full state name, for the dot's tooltip and label. */
export function stateName(kind: string): string {
  switch (kind) {
    case "ready": return "Ready";
    case "working": return "Indexing";
    case "installing": return "Installing";
    case "starting": return "Starting";
    case "needs-install": return "Not installed";
    case "runtime-missing": return "Needs a runtime";
    case "install-failed": return "Install failed";
    case "failed": return "Did not start";
    case "crashed": return "Stopped";
    case "disabled": return "Off";
    case "idle": return "Not started";
    case "unavailable": return "Unavailable";
    default: return "Checking";
  }
}

/** The state word in an "All languages" row. Empty when ready or when the action says it all. */
export function rowWord(kind: string, percent?: number): string {
  switch (kind) {
    case "working": return percent === undefined ? "Indexing" : `Indexing ${percentText(percent)}`;
    case "installing": return percent === undefined ? "Installing" : `Installing ${percentText(percent)}`;
    case "starting": return "Starting";
    case "needs-install": return "Not installed";
    case "runtime-missing": return "Needs runtime";
    case "install-failed": case "failed": return "Failed";
    case "crashed": return "Stopped";
    case "unavailable": return "Unavailable";
    case "unknown": return "Checking";
    default: return "";
  }
}

/** Status bar text: the language, plus a short word only when work runs or attention is needed. */
export function statusBarText(id: LanguageServerId, kind: string, percent?: number, restricted = false): string {
  const name = shortLanguageNames[id];
  const word = (() => {
    switch (kind) {
      case "ready": return restricted ? "Trust" : "";
      case "working": case "installing": return percent === undefined ? (kind === "working" ? "Indexing" : "Installing") : "";
      case "starting": return "Starting";
      case "needs-install": return "Install";
      case "runtime-missing": return runtimeFor(id);
      case "install-failed": case "failed": return "Failed";
      case "crashed": return "Stopped";
      case "disabled": return "Off";
      case "unavailable": return "Unavailable";
      default: return "";
    }
  })();
  if ((kind === "working" || kind === "installing") && percent !== undefined) return `${name} ${percentText(percent)}`;
  return word ? `${name} \u00b7 ${word}` : name;
}

/** Spoken and tooltip summary, always built from the same numbers as the panel. */
export function buttonSummary(id: LanguageServerId | undefined, kind: string, percent?: number, restricted = false): string {
  if (!id) return "No language support for this file";
  const name = shortLanguageNames[id];
  const pct = percent === undefined ? "" : ` (${percentText(percent)})`;
  switch (kind) {
    case "installing": return `Installing ${name}${pct}`;
    case "working": return `Indexing ${name}${pct}`;
    case "starting": return `Starting ${name}`;
    case "ready": return restricted ? `${name} is ready, folder not trusted` : `${name} is ready`;
    case "needs-install": return `${name} is not installed`;
    case "runtime-missing": return `${name} needs ${runtimeFor(id)}`;
    case "install-failed": return `${name} did not install`;
    case "failed": return `${name} did not start`;
    case "crashed": return `${name} stopped unexpectedly`;
    case "disabled": return `${name} is off`;
    case "idle": return `${name} is not started`;
    case "unavailable": return "Language status is unavailable";
    default: return `Checking ${name}`;
  }
}
