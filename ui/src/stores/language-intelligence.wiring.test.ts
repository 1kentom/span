// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

/** Wiring tests: the real `hubPort` and `lspPort` from lib/client run against a mocked generated `commands` and `events` module. */
const mocks = vi.hoisted(() => {
  const listeners: Record<string, (event: { payload: unknown }) => void> = {};
  const event = (name: string) => ({ listen: vi.fn(async (fn: (event: { payload: unknown }) => void) => { listeners[name] = fn; return () => undefined; }) });
  return {
    listeners,
    commands: { lspStatus: vi.fn(), lspTrustWorkspace: vi.fn(), lspCancelInstall: vi.fn(async () => null), lspInstall: vi.fn(async () => null), lspRestart: vi.fn(async () => null), lspCancel: vi.fn(async () => null) },
    events: {
      diagnosticsPublished: event("diagnostics"), languageServerStateChanged: event("state"), languageServerInstallProgress: event("install"),
      languageServerError: event("error"), languageServerWorkProgress: event("work"),
    },
  };
});

vi.mock("../bindings", async importOriginal => ({ ...(await importOriginal<typeof import("../bindings")>()), commands: mocks.commands, events: mocks.events }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "/jdks/jdk-25") }));

const capabilities = { completion: true, hover: true, definition: true, formatting: true, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, declaration: false, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: true, signatureHelp: true };
const jdtls = (trust: { workspaceTrusted: boolean; needsTrust: boolean; reason: string | null }, epoch = 1) => ({
  server: "jdtls", root: "/w", state: { kind: "ready" }, installed: true, enabled: true, version: "1.62.0", epoch, capabilities,
  displayName: "Java (Eclipse JDT LS)", languages: ["Java"], installedSizeBytes: 1024, runtime: null, failureReason: null, failureDetails: null, activity: [], trust, install: null,
});
const needsTrust = { workspaceTrusted: false, needsTrust: true, reason: "pom.xml" };
const trusted = { workspaceTrusted: true, needsTrust: false, reason: null };

beforeEach(() => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}; vi.resetModules(); });
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; Object.values(mocks.commands).forEach(mock => mock.mockClear()); });

async function connect() {
  const client = await import("../lib/client");
  const { createLanguageServers } = await import("./language-servers");
  const { createLanguageIntelligence } = await import("./language-intelligence");
  expect(client.isDesktop).toBe(true);
  return createRoot(dispose => {
    const servers = createLanguageServers(client.lspPort, { hub: client.hubPort });
    const hub = createLanguageIntelligence({ servers, activePath: () => "src/A.java", workspaceRoot: () => "/w", autoInstall: () => true, setUserSetting: async () => undefined, pickPath: client.hubPort.pickPath, openSettings: () => undefined });
    return { client, servers, hub, dispose };
  });
}

describe("hub wiring against the generated commands", () => {
  it("calls the generated commands directly and forwards work progress events", async () => {
    const { client } = await import("../lib/client").then(client => ({ client }));
    mocks.commands.lspTrustWorkspace.mockResolvedValue([]);
    await client.hubPort.trustWorkspace(true);
    expect(mocks.commands.lspTrustWorkspace).toHaveBeenCalledWith(true);
    await client.hubPort.cancelInstall("jdtls");
    expect(mocks.commands.lspCancelInstall).toHaveBeenCalledWith("jdtls");
    const seen: unknown[] = [];
    await client.hubPort.onWorkProgress(event => seen.push(event));
    const payload = { server: "jdtls", root: "/w", token: "t", title: "Indexing", message: null, percentage: 10, kind: "begin" };
    mocks.listeners.work({ payload });
    expect(seen).toEqual([payload]);
  });

  it("Trust folder calls lspTrustWorkspace(true) and the status refresh shows trust.workspaceTrusted", async () => {
    mocks.commands.lspStatus.mockResolvedValue([jdtls(needsTrust)]);
    const m = await connect();
    await m.servers.init();
    expect(m.servers.entryFor("jdtls", "/w/src/A.java")?.hub.trust).toEqual(needsTrust);
    expect(m.hub.view().banner).toBeDefined();

    mocks.commands.lspTrustWorkspace.mockImplementation(async () => { mocks.commands.lspStatus.mockResolvedValue([jdtls(trusted, 2)]); return [jdtls(trusted, 2)]; });
    await m.hub.perform("trust", "jdtls");
    expect(mocks.commands.lspTrustWorkspace).toHaveBeenCalledWith(true);
    const trust = m.servers.entryFor("jdtls", "/w/src/A.java")?.hub.trust;
    expect(trust?.workspaceTrusted).toBe(true);
    expect(trust?.needsTrust).toBe(false);
    expect(m.hub.view().banner).toBeUndefined();
    m.dispose();
  });

  it("the hover hint for an untrusted project reads trust.needsTrust from the generated status row", async () => {
    mocks.commands.lspStatus.mockResolvedValue([jdtls(needsTrust)]);
    const m = await connect();
    await m.servers.init();
    expect(m.hub.hoverHint("src/A.java")?.actionLabel).toBe("Trust folder");
    mocks.commands.lspStatus.mockResolvedValue([jdtls(trusted)]);
    await m.servers.refresh();
    expect(m.hub.hoverHint("src/A.java")).toBeUndefined();
    m.dispose();
  });
});
