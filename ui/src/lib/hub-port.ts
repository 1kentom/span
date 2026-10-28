/**
 * Types and the row normaliser the language intelligence hub uses. Every shape comes from the generated
 * bindings (`ServerStatusDto`, `LanguageServerWorkProgress`, `LanguageServerInstallProgress`); nothing
 * here redeclares a backend field.
 */
import type { ActivityDto_Deserialize, InstallStatusDto_Deserialize, LanguageServerId, LanguageServerWorkProgress_Deserialize, RuntimeDto_Deserialize, ServerStatusDto_Serialize, TrustDto_Deserialize } from "../bindings";

export type HubRuntime = RuntimeDto_Deserialize;
export type HubTrust = TrustDto_Deserialize;
/** One piece of running work. The token is optional so a view can show work a fixture did not name. */
export type HubActivity = Omit<ActivityDto_Deserialize, "token"> & { token?: string };
export type HubInstallStatus = InstallStatusDto_Deserialize;
/** `LanguageServerWorkProgress`. */
export type WorkProgressEvent = LanguageServerWorkProgress_Deserialize;

/** The hub fields of a status row, cleaned: blank text and nulls become undefined, lists and trust always present. */
export interface HubRowFields {
  displayName?: string;
  languages: string[];
  installedSizeBytes?: number;
  runtime?: HubRuntime;
  failureReason?: string;
  failureDetails?: string;
  activity: HubActivity[];
  trust: HubTrust;
  install?: HubInstallStatus;
}

/** Commands and events of the hub, plus the folder dialog. */
export interface HubPort {
  cancelInstall(server: LanguageServerId): Promise<unknown>;
  /** Resolves with the updated status rows. */
  trustWorkspace(trusted: boolean): Promise<ServerStatusDto_Serialize[] | null>;
  onWorkProgress(listener: (event: WorkProgressEvent) => void): Promise<() => void>;
  /** Native dialog for a folder (a JDK home) or a file (the Node.js executable). Resolves null when the user cancels. */
  pickPath(kind: "folder" | "file", title: string): Promise<string | null>;
}

const text = (value: string | null | undefined): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: number | null | undefined): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function readActivity(value: readonly Partial<ActivityDto_Deserialize>[] | null | undefined): HubActivity[] {
  if (!Array.isArray(value)) return [];
  const items: HubActivity[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const percentage = count(item.percentage);
    items.push({ token: text(item.token), title: text(item.title), message: text(item.message), percentage: percentage === undefined ? undefined : Math.min(100, percentage) });
  }
  return items;
}

/** Reads the hub fields of a status row. A row without them (an older backend, a partial fixture) gets safe defaults. */
export function readHubFields(row: Partial<ServerStatusDto_Serialize> | null | undefined): HubRowFields {
  const source = row ?? {};
  const { runtime, trust, install } = source;
  return {
    displayName: text(source.displayName),
    languages: Array.isArray(source.languages) ? source.languages.filter(item => typeof item === "string") : [],
    installedSizeBytes: count(source.installedSizeBytes),
    runtime: runtime && text(runtime.name) && count(runtime.requiredVersion) !== undefined
      ? { name: runtime.name, requiredVersion: runtime.requiredVersion, foundVersion: text(runtime.foundVersion) ?? null, foundPath: text(runtime.foundPath) ?? null }
      : undefined,
    failureReason: text(source.failureReason),
    failureDetails: text(source.failureDetails),
    activity: readActivity(source.activity),
    trust: trust ? { workspaceTrusted: trust.workspaceTrusted !== false, needsTrust: trust.needsTrust === true, reason: text(trust.reason) ?? null } : { workspaceTrusted: true, needsTrust: false, reason: null },
    install: install && text(install.phase) ? { phase: install.phase, overallReceived: count(install.overallReceived) ?? 0, overallTotal: count(install.overallTotal) ?? null, artifactIndex: count(install.artifactIndex) ?? 0, artifactCount: count(install.artifactCount) ?? 1 } : undefined,
  };
}
