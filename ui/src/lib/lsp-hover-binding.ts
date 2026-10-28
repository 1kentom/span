import type { CapabilitiesDto, LocationDto } from "../bindings";
import { createLspSession, serverLabels, type LspPort } from "./lsp-client";
import type { LspBinding, ServerNotice } from "./lsp-codemirror";
import { previewDiagnostics, previewHoverCapabilities, previewHoverServer } from "./hover-preview";

/** What the workbench lends to the hover layer on top of the language server store's binding. */
export interface HoverExtras {
  notice: (path: string) => ServerNotice | undefined;
  shortcut: (id: "goToDefinition" | "peekDefinition" | "quickInfo") => string;
  openExternal: (url: string) => Promise<void> | void;
  navigateFile: (target: { path: string; line?: number; column?: number }) => void;
  openLocationToSide: (location: LocationDto) => void;
  readSource: NonNullable<LspBinding["readSource"]>;
  hoverHint?: LspBinding["hoverHint"];
}

export function withHoverExtras(binding: LspBinding, path: string, extras: HoverExtras): LspBinding {
  return {
    ...binding,
    getServerNotice: () => extras.notice(path),
    getShortcut: id => extras.shortcut(id) || undefined,
    openExternal: url => { void Promise.resolve(extras.openExternal(url)).catch(() => undefined); },
    navigateFile: extras.navigateFile,
    openLocationToSide: extras.openLocationToSide,
    readSource: extras.readSource,
    hoverHint: extras.hoverHint,
  };
}

/** Maps a store entry to the notice a hover shows while the server cannot give a full answer. `activity` is read when the status hub provides it. */
export function noticeFor(state: string, entry: unknown): ServerNotice | undefined {
  if (state === "starting" || state === "installing") return "starting";
  const activity = (entry as { activity?: { indexing?: boolean; kind?: string } | string | null } | undefined)?.activity;
  if (activity && (typeof activity === "string" || activity.indexing || activity.kind === "indexing")) return "indexing";
  return undefined;
}

export interface PreviewBindingContext {
  getRevision: () => number;
  isSynchronized: () => boolean;
  isActive: () => boolean;
  getWorkspaceGeneration: () => number;
  openLocation: (location: LocationDto) => void;
  notify: (message: string) => void;
}

/** PREVIEW ONLY: a ready fixture server for the hover sample files, see hover-preview.ts. */
export function createPreviewBinding(path: string, context: PreviewBindingContext, port: LspPort): LspBinding | undefined {
  const server = previewHoverServer(path);
  if (!server) return undefined;
  const capabilities: CapabilitiesDto = previewHoverCapabilities;
  return {
    server, createSession: () => createLspSession(port),
    getRevision: () => 0, isSynchronized: context.isSynchronized, isActive: context.isActive, getWorkspaceGeneration: context.getWorkspaceGeneration,
    getEpoch: () => 0, getCapabilities: () => capabilities,
    subscribeDiagnostics: () => () => undefined, subscribeReset: () => () => undefined,
    openLocation: context.openLocation, notify: context.notify,
    getLatestDiagnostics: () => previewDiagnostics(path, 0),
  };
}

export const previewServerLabel = (path: string) => { const server = previewHoverServer(path); return server ? serverLabels[server] : undefined; };
