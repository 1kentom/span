/** Builders for hub view tests. Fixtures only: nothing here talks to a language server. */
import type { CapabilitiesDto, LanguageServerId } from "../bindings";
import { serverOrder } from "../lib/language-intelligence-copy";
import type { HubActivity, HubRowFields } from "../lib/lsp-hub-types";
import { buildHubView, type HubServerSnapshot, type HubSnapshot, type HubView } from "./language-intelligence";
import type { BufferLspState, ServerEntry } from "./language-servers";

export const allCapabilities: CapabilitiesDto = {
  completion: true, hover: true, definition: true, formatting: true, rangeFormatting: false, rename: true, prepareRename: true, references: true,
  implementation: true, typeDefinition: true, declaration: false, documentSymbol: true, workspaceSymbol: true, callHierarchy: true,
  typeHierarchy: true, documentHighlight: true, signatureHelp: true,
};

export const hubFields = (over: Partial<HubRowFields> = {}): HubRowFields => ({ languages: [], activity: [], trust: { workspaceTrusted: true, needsTrust: false, reason: null }, ...over });

export type EntryOverrides = Omit<Partial<ServerEntry>, "hub"> & { hub?: Partial<HubRowFields> };
export function makeEntry(server: LanguageServerId, over: EntryOverrides = {}): ServerEntry {
  const { hub, ...rest } = over;
  return { server, root: "/w", state: { kind: "ready" }, installed: true, enabled: true, version: "1.62.0", epoch: 1, capabilities: allCapabilities, ...rest, hub: hubFields(hub) };
}

export function makeServer(id: LanguageServerId, state: BufferLspState, entry?: EntryOverrides, activity: HubActivity[] = [], error?: string): HubServerSnapshot {
  return { id, state, entry: entry === undefined ? undefined : makeEntry(id, entry), activity, error };
}

export function makeSnapshot(file: HubServerSnapshot | undefined, over: Partial<HubSnapshot> = {}): HubSnapshot {
  const others = serverOrder.filter(id => id !== file?.id).map(id => makeServer(id, { kind: "ready", server: id, capabilities: allCapabilities }, { state: { kind: "ready" } }));
  return { hasFile: true, fileServer: file?.id, servers: file ? [file, ...others] : others, autoInstall: true, dismissedTrust: new Set(), trustRestarting: false, preview: false, ...over };
}

export function viewOf(file: HubServerSnapshot | undefined, over: Partial<HubSnapshot> = {}): HubView {
  return buildHubView(makeSnapshot(file, over));
}

export const javaInstalling = (percent: number, received: number, total: number, phase = "downloading"): HubServerSnapshot =>
  makeServer("jdtls", { kind: "installing", server: "jdtls", phase, overallReceived: received, overallTotal: total, percent }, { state: { kind: "installing" }, installed: false });
