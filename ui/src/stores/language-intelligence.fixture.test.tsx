// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import type { LspPort } from "../lib/lsp-client";
import type { HubPort, WorkProgressEvent } from "../lib/hub-port";
import { LanguageIntelligenceButton } from "../components/LanguageIntelligenceButton";
import { LanguageIntelligencePanel } from "../components/LanguageIntelligencePanel";
import { LanguageServerStatus } from "../components/LanguageServerStatus";
import { createLanguageIntelligence } from "./language-intelligence";
import { createLanguageServers } from "./language-servers";

// Fixture tests: a fake port and a fake hub port feed the real store, view model and components.
const MB = 1024 * 1024;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });

const caps = { completion: true, hover: true, definition: true, formatting: true, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, declaration: false, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: true, signatureHelp: true };
const row = (over: any = {}) => ({ server: "jdtls", root: "/w", state: { kind: "installing" }, installed: false, enabled: true, version: "1.62.0", epoch: 1, capabilities: null, displayName: "Java (Eclipse JDT LS)", languages: ["Java"], activity: [], trust: { workspaceTrusted: true, needsTrust: false }, ...over });

async function setup(rows: any[], hubOver: Partial<HubPort> = {}) {
  const listeners: Record<string, (event: any) => void> = {};
  const listen = (name: string) => async (fn: (event: any) => void) => { listeners[name] = fn; return () => undefined; };
  const port = { completion: vi.fn(), hover: vi.fn(), definition: vi.fn(), format: vi.fn(), cancel: vi.fn(), install: vi.fn(async () => null), restart: vi.fn(async () => null), status: vi.fn(async () => rows), onDiagnostics: listen("diag"), onState: listen("state"), onInstallProgress: listen("progress"), onError: listen("error") } as unknown as LspPort;
  const hubPort: HubPort = { cancelInstall: vi.fn(async () => undefined), trustWorkspace: vi.fn(async () => []), onWorkProgress: async fn => { listeners.work = fn as never; return () => undefined; }, pickPath: vi.fn(async () => "/jdk/25"), ...hubOver };
  const root = document.createElement("div"); document.body.append(root);
  const setting = vi.fn(async () => undefined);
  const openSettings = vi.fn();
  const handle = createRoot(dispose => {
    disposers.push(dispose);
    const servers = createLanguageServers(port, { hub: hubPort });
    const hub = createLanguageIntelligence({ servers, activePath: () => "src/A.java", workspaceRoot: () => "/w", autoInstall: () => true, setUserSetting: setting, pickPath: hubPort.pickPath, openSettings });
    disposers.push(render(() => <>
      <LanguageIntelligenceButton view={hub.view()} open={false} onToggle={() => undefined} />
      <LanguageServerStatus view={hub.view()} language="java" open={false} onToggle={() => undefined} />
      <LanguageIntelligencePanel embedded view={hub.view()} onAction={(action, server) => void hub.perform(action, server)} onToggleServer={(server, on) => void hub.setEnabled(server, on)} />
    </>, root));
    return { servers, hub };
  });
  await handle.servers.init();
  return { ...handle, root, listeners, port, hubPort, setting, openSettings };
}
const progress = (overallReceived: number, index: number, received: number, size: number, phase = "downloading") => ({ server: "jdtls", version: "1.62.0", phase, received, total: size, message: null, overallReceived, overallTotal: 320 * MB, artifactIndex: index, artifactCount: 3 });
const text = (root: HTMLElement, selector: string) => root.querySelector(selector)?.textContent ?? "";
const click = (root: HTMLElement, selector: string) => root.querySelector<HTMLElement>(selector)!.click();

describe("fixture: one view model drives every surface", () => {
  it("keeps the percent equal to the overall bytes ratio and never lets it fall, across 3 artifacts", async () => {
    const m = await setup([row()]);
    const sizes = [40 * MB, 180 * MB, 100 * MB];
    const steps: { overall: number; index: number; received: number; size: number }[] = [];
    let overall = 0;
    sizes.forEach((size, index) => { for (let tick = 1; tick <= 5; tick++) steps.push({ overall: overall + (size * tick) / 5, index, received: (size * tick) / 5, size }); overall += size; });
    const seen: number[] = [];
    let floor = 0;
    for (const step of steps) {
      m.listeners.progress(progress(step.overall, step.index, step.received, step.size));
      // A late, stale event from an earlier moment must not move the bar back.
      m.listeners.progress(progress(Math.max(0, step.overall - 7 * MB), step.index, step.received, step.size));
      const expected = Math.floor((step.overall / (320 * MB)) * 100);
      floor = Math.max(floor, expected);
      const percent = Number(m.root.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow"));
      seen.push(percent);
      expect(percent).toBe(expected);
      // The same number in the button, the status bar and the panel text.
      expect(m.root.querySelector(".hub-button")!.getAttribute("aria-label")).toBe(`Language intelligence. Installing Java (${percent}%).`);
      expect(m.root.querySelector(".hub-button")!.getAttribute("data-percent")).toBe(String(percent));
      expect(m.root.querySelector(".lsp-status-button")!.getAttribute("aria-label")).toBe(`Java, Eclipse JDT LS 1.62, installing ${percent}%. Show language support`);
      expect(text(m.root, "[data-testid=hub-percent]")).toBe(`${percent}%`);
      expect(text(m.root, ".hub-state-word")).toBe("Installing");
      expect(text(m.root, ".hub-status-text")).toBe(`Downloading ${Math.round(step.overall / MB)} of 320 MB`);
    }
    for (let index = 1; index < seen.length; index++) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    expect(seen.at(-1)).toBe(100);
    expect(m.root.querySelector("[title]")).toBeNull();
  });
  it("seeds a late subscriber from the status row, then follows events", async () => {
    const m = await setup([row({ install: { phase: "downloading", overallReceived: 128 * MB, overallTotal: 320 * MB, artifactIndex: 1, artifactCount: 3 } })]);
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("40%");
    m.listeners.progress(progress(64 * MB, 1, 24 * MB, 180 * MB));
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("40%");
    m.listeners.progress(progress(160 * MB, 1, 120 * MB, 180 * MB));
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("50%");
  });
  it("moves through the later phases, then returns to needs install on cancel without an error", async () => {
    const m = await setup([row()]);
    m.listeners.progress(progress(320 * MB, 2, 100 * MB, 100 * MB));
    for (const [phase, line] of [["verifying", "Checking the download"], ["extracting", "Unpacking"], ["finalizing", "Finishing"]]) {
      m.listeners.progress(progress(320 * MB, 2, 0, 0, phase));
      expect(text(m.root, ".hub-status-text")).toBe(line);
      expect(text(m.root, "[data-testid=hub-percent]")).toBe("100%");
    }
    (m.port.status as any).mockResolvedValue([row({ state: { kind: "needsInstall", version: "1.62.0", sizeHint: 120 * MB } })]);
    click(m.root, '[data-action="cancel"]');
    expect(m.hubPort.cancelInstall).toHaveBeenCalledWith("jdtls");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text(m.root, ".hub-status-text")).toBe("Install for completions and errors (about 120 MB)");
    expect(m.root.querySelector('[data-action="install"]')).not.toBeNull();
    expect(m.servers.error()).toBe("");
    expect(m.root.querySelector("[role=progressbar]")).toBeNull();
  });
  it("shows indexing from work progress and ends with ready", async () => {
    const m = await setup([row({ state: { kind: "ready" }, installed: true, capabilities: caps })]);
    expect(m.root.querySelector(".hub-panel")!.getAttribute("data-kind")).toBe("ready");
    expect(text(m.root, ".hub-state-word")).toBe("Ready");
    expect(m.root.querySelectorAll('.hub-chip[data-on="true"]')).toHaveLength(7);
    const work = (event: Partial<WorkProgressEvent>) => m.listeners.work({ server: "jdtls", root: "/w", token: "t", kind: "report", ...event });
    work({ kind: "begin", title: "Indexing project", message: "Reading classes", percentage: 0 });
    work({ percentage: 35 });
    expect(text(m.root, ".hub-state-word")).toBe("Indexing");
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("35%");
    expect(text(m.root, ".hub-status-text")).toBe("Reading classes");
    expect(m.root.querySelector(".hub-button")!.getAttribute("data-percent")).toBe("35");
    expect(m.root.querySelector(".lsp-status-button")!.getAttribute("aria-label")).toContain("indexing 35%");
    work({ kind: "end" });
    expect(m.root.querySelector(".hub-panel")!.getAttribute("data-kind")).toBe("ready");
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("");
  });
  it("a switch updates the row, the status bar and the card at once, before the setting write returns", async () => {
    const m = await setup([row({ state: { kind: "ready" }, installed: true, capabilities: caps })]);
    let release!: () => void;
    m.setting.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
    const toggle = m.root.querySelector<HTMLElement>('.hub-row[data-server="jdtls"] [role=switch]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(m.setting).toHaveBeenCalledWith("languageServers.enabled.jdtls", false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(m.root.querySelector('.hub-row[data-server="jdtls"]')!.getAttribute("data-state")).toBe("off");
    expect(m.root.querySelector(".lsp-status")!.getAttribute("data-state")).toBe("off");
    expect(text(m.root, ".hub-state-word")).toBe("Off");
    (m.port.status as any).mockResolvedValue([row({ state: { kind: "disabled" }, enabled: false, installed: true })]);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(m.root.querySelector(".lsp-status")!.getAttribute("data-state")).toBe("off");
  });
  it("trust: restarts with a message, then clears it when the folder restarted and is ready", async () => {
    const needs = row({ state: { kind: "ready" }, installed: true, capabilities: caps, trust: { workspaceTrusted: false, needsTrust: true } });
    const m = await setup([needs]);
    expect(m.hub.view().banner).toBeDefined();
    (m.port.status as any).mockResolvedValue([row({ state: { kind: "starting" }, epoch: 2, installed: true, trust: { workspaceTrusted: true, needsTrust: false } })]);
    click(m.root, '[data-action="trust"]');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.hubPort.trustWorkspace).toHaveBeenCalledWith(true);
    expect(text(m.root, ".hub-status-text")).toBe("Restarting Java with its dependencies");
    expect(m.hub.view().banner?.restarting).toBe("Restarting Java with its dependencies");
    (m.port.status as any).mockResolvedValue([row({ state: { kind: "ready" }, epoch: 2, installed: true, capabilities: caps, trust: { workspaceTrusted: true, needsTrust: false } })]);
    await m.servers.refresh();
    expect(m.hub.view().banner).toBeUndefined();
    expect(m.root.querySelector(".hub-trust")!.textContent).toBe("Trusted folder");
  });
  it("trust: does not stay on the restarting message when nothing restarted", async () => {
    const needs = row({ state: { kind: "ready" }, installed: true, capabilities: caps, trust: { workspaceTrusted: false, needsTrust: true } });
    const m = await setup([needs], { trustWorkspace: vi.fn(async () => { throw new Error("denied"); }) });
    click(m.root, '[data-action="trust"]');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.hub.view().banner?.restarting).toBeUndefined();
    expect(m.servers.error()).toContain("denied");
  });
  it("hover hint appears only while the folder needs trust, and its action trusts", async () => {
    const needs = row({ state: { kind: "ready" }, installed: true, capabilities: caps, trust: { workspaceTrusted: false, needsTrust: true } });
    const m = await setup([needs]);
    const hint = m.hub.hoverHint("src/A.java")!;
    expect(hint.text).toBe("Library types are not loaded until this folder is trusted.");
    expect(hint.actionLabel).toBe("Trust folder");
    hint.onAction();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.hubPort.trustWorkspace).toHaveBeenCalledWith(true);
    const fine = await setup([row({ state: { kind: "ready" }, installed: true, capabilities: caps })]);
    expect(fine.hub.hoverHint("src/A.java")).toBeUndefined();
    expect(fine.hub.hoverHint("src/a.ts")).toBeUndefined();
  });
  it("dismissing hides the banner for that folder only", async () => {
    const m = await setup([row({ state: { kind: "ready" }, installed: true, capabilities: caps, trust: { workspaceTrusted: false, needsTrust: true } })]);
    m.hub.dismissBanner("/w");
    expect(m.hub.view().banner).toBeUndefined();
    expect(m.hub.view().button.badge).toBe("restricted");
  });
  it("choosing a JDK writes the user setting and restarts, and a cancelled dialog does nothing", async () => {
    const missing = row({ state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, installed: true, runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } });
    const m = await setup([missing]);
    expect(text(m.root, ".hub-status-text")).toBe("Needs JDK 25 or newer. Found JDK 21");
    click(m.root, '[data-action="chooseRuntime"]');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.hubPort.pickPath).toHaveBeenCalledWith("folder", "Choose a JDK folder");
    expect(m.setting).toHaveBeenCalledWith("languageServers.javaHome", "/jdk/25");
    expect(m.port.restart).toHaveBeenCalledWith("jdtls");
    const cancelled = await setup([missing], { pickPath: vi.fn(async () => null) });
    click(cancelled.root, '[data-action="chooseRuntime"]');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled.setting).not.toHaveBeenCalled();
    expect(cancelled.port.restart).not.toHaveBeenCalled();
  });
  it("turns a server on or off with the user setting for that server", async () => {
    const m = await setup([row({ state: { kind: "ready" }, installed: true, capabilities: caps })]);
    click(m.root, '.hub-row[data-server="jdtls"] [role=switch]');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.setting).toHaveBeenCalledWith("languageServers.enabled.jdtls", false);
  });
  it("works against rows from older bindings that lack the new fields", async () => {
    const m = await setup([{ server: "jdtls", root: "/w", state: { kind: "installing" }, installed: false, enabled: true, version: "1", epoch: 1, capabilities: null }]);
    m.listeners.progress({ server: "jdtls", version: "1", phase: "downloading", received: 10, total: 40, message: null });
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("25%");
    m.listeners.progress({ server: "jdtls", version: "1", phase: "downloading", received: 4, total: 8, message: null });
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("50%");
    m.listeners.progress({ server: "jdtls", version: "1", phase: "downloading", received: 1, total: 8, message: null });
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("50%");
  });
});
