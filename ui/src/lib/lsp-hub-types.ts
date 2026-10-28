/**
 * Local shape of the language intelligence fields the backend adds to `lsp_status` rows, the install
 * progress event and the work progress event. Every field is optional here so the hub still works
 * against bindings generated before those fields existed. When the generated types are the source of
 * truth, replace the interfaces below with imports and keep `readHubFields` and `readInstallExt`.
 */
import type { LanguageServerId } from "../bindings";

export interface HubRuntime { name: string; requiredVersion: number; foundVersion?: string | null; foundPath?: string | null }
export interface HubTrust { workspaceTrusted: boolean; needsTrust: boolean; reason?: string | null }
export interface HubActivity { token?: string; title?: string | null; message?: string | null; percentage?: number | null }
export interface HubInstallStatus { phase: string; overallReceived: number; overallTotal?: number | null; artifactIndex: number; artifactCount: number }

/** The row extensions, normalised: always present, with safe defaults when the backend did not send them. */
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

/** Extra fields of `LanguageServerInstallProgress`. */
export interface HubInstallExt { overallReceived?: number; overallTotal?: number | null; artifactIndex?: number; artifactCount?: number }

/** `LanguageServerWorkProgress`. */
export interface WorkProgressEvent {
  server: LanguageServerId;
  root: string;
  token: string;
  title?: string | null;
  message?: string | null;
  percentage?: number | null;
  kind: "begin" | "report" | "end";
}

/** Commands and events that may not exist in older bindings, plus the folder dialog. */
export interface HubPort {
  cancelInstall(server: LanguageServerId): Promise<unknown>;
  trustWorkspace(trusted: boolean): Promise<unknown>;
  onWorkProgress(listener: (event: WorkProgressEvent) => void): Promise<() => void>;
  /** Native dialog for a folder (a JDK home) or a file (the Node.js executable). Resolves null when the user cancels. */
  pickPath(kind: "folder" | "file", title: string): Promise<string | null>;
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;

export function readActivity(value: unknown): HubActivity[] {
  if (!Array.isArray(value)) return [];
  const items: HubActivity[] = [];
  for (const raw of value) {
    const item = record(raw);
    if (!item) continue;
    const percentage = count(item.percentage);
    items.push({ token: text(item.token), title: text(item.title), message: text(item.message), percentage: percentage === undefined ? undefined : Math.min(100, percentage) });
  }
  return items;
}

/** Reads the hub fields of a status row. Never throws, whatever the row looks like. */
export function readHubFields(row: unknown): HubRowFields {
  const source = record(row) ?? {};
  const runtime = record(source.runtime);
  const trust = record(source.trust);
  const install = record(source.install);
  return {
    displayName: text(source.displayName),
    languages: Array.isArray(source.languages) ? source.languages.filter((item): item is string => typeof item === "string") : [],
    installedSizeBytes: count(source.installedSizeBytes),
    runtime: runtime && text(runtime.name) && count(runtime.requiredVersion) !== undefined
      ? { name: runtime.name as string, requiredVersion: runtime.requiredVersion as number, foundVersion: text(runtime.foundVersion) ?? null, foundPath: text(runtime.foundPath) ?? null }
      : undefined,
    failureReason: text(source.failureReason),
    failureDetails: text(source.failureDetails),
    activity: readActivity(source.activity),
    trust: trust ? { workspaceTrusted: trust.workspaceTrusted !== false, needsTrust: trust.needsTrust === true, reason: text(trust.reason) ?? null } : { workspaceTrusted: true, needsTrust: false, reason: null },
    install: install && text(install.phase) ? { phase: install.phase as string, overallReceived: count(install.overallReceived) ?? 0, overallTotal: count(install.overallTotal) ?? null, artifactIndex: count(install.artifactIndex) ?? 0, artifactCount: count(install.artifactCount) ?? 1 } : undefined,
  };
}

export function readInstallExt(event: unknown): HubInstallExt {
  const source = record(event) ?? {};
  return { overallReceived: count(source.overallReceived), overallTotal: count(source.overallTotal) ?? null, artifactIndex: count(source.artifactIndex), artifactCount: count(source.artifactCount) };
}
