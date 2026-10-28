// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageIntelligencePanel } from "./LanguageIntelligencePanel";
import { allCapabilities, javaInstalling, makeServer, viewOf } from "../stores/language-intelligence.testkit";
import type { HubView } from "../stores/language-intelligence";

// Fixture tests: static views are passed in, no store or server is running.
const MB = 1024 * 1024;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
function mount(view: HubView, extra: Partial<Parameters<typeof LanguageIntelligencePanel>[0]> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const fns = { onAction: vi.fn(), onToggleServer: vi.fn(), onClose: vi.fn(), onOpenSettings: vi.fn(), onCopy: vi.fn(async () => undefined) };
  disposers.push(render(() => <LanguageIntelligencePanel view={view} {...fns} {...extra} />, root));
  return { root, ...fns, panel: root.querySelector<HTMLElement>(".hub-panel")! };
}
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find(item => item.textContent === label)!;
const java = (state: any, entry: any = {}, activity: any[] = []) => makeServer("jdtls", state, { state: { kind: "ready" }, ...entry }, activity);

describe("fixture: hub panel", () => {
  it("is a labelled dialog with the one sentence, a card for this file and every language", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(m.panel.getAttribute("role")).toBe("dialog");
    const heading = m.root.querySelector("h2")!;
    expect(m.panel.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.textContent).toBe("Language intelligence");
    expect(m.root.querySelector(".hub-header p")!.textContent).toBe("Completions, error checking, hover info and go to definition for your code.");
    expect(m.root.querySelector(".hub-card-name strong")!.textContent).toBe("Java");
    expect(m.root.querySelector(".hub-card-name small")!.textContent).toBe("Eclipse JDT LS 1.62.0");
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(7);
    expect(m.root.querySelectorAll(".hub-chip")).toHaveLength(7);
    expect(m.root.textContent).toContain("Language server settings");
  });
  it("needs install: explains, installs, and says when automatic install is off", () => {
    const view = viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1.62.0", sizeHint: 120 * MB }, { state: { kind: "needsInstall", version: "1" }, installed: false }), { autoInstall: false });
    const m = mount(view);
    expect(m.root.querySelector(".hub-detail")!.textContent).toContain("Java support is not installed. Install it to get completions, error checking and go to definition. About 120 MB. You can keep editing while it downloads.");
    expect(m.root.querySelector(".hub-detail")!.textContent).toContain("Automatic install is off");
    button(m.root, "Install Java support").click();
    expect(m.onAction).toHaveBeenCalledWith("install", "jdtls");
  });
  it("installing: a single progress bar with the value, the phase line, the keep editing note and Cancel", () => {
    const m = mount(viewOf(javaInstalling(42, 134 * MB, 320 * MB)));
    const bars = m.root.querySelectorAll("[role=progressbar]");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-valuenow")).toBe("42");
    expect(bars[0].getAttribute("aria-valuemin")).toBe("0");
    expect(bars[0].getAttribute("aria-valuemax")).toBe("100");
    expect(bars[0].getAttribute("aria-label")).toBe("Installing Java support");
    expect(m.root.querySelector(".hub-headline")!.textContent).toBe("Downloading… 134 MB of 320 MB");
    expect(m.root.querySelector(".hub-detail")!.textContent).toContain("You can keep editing.");
    button(m.root, "Cancel").click();
    expect(m.onAction).toHaveBeenCalledWith("cancel", "jdtls");
  });
  it("installing with an unknown total shows an indeterminate bar without a value", () => {
    const m = mount(viewOf(makeServer("jdtls", { kind: "installing", server: "jdtls", phase: "downloading", overallReceived: 3 * MB, overallTotal: null }, { state: { kind: "installing" } })));
    const bar = m.root.querySelector("[role=progressbar]")!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.querySelector("i")!.classList.contains("indeterminate")).toBe(true);
    expect(m.root.querySelector("[data-testid=hub-percent]")!.textContent).toBe("");
  });
  it("starting and indexing", () => {
    expect(mount(viewOf(java({ kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }))).root.textContent).toContain("Starting Java support. The first start can take a minute while it reads your project.");
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, {}, [{ title: "Indexing project", message: "Reading classes", percentage: 35 }])));
    expect(m.root.querySelector(".hub-headline")!.textContent).toBe("Indexing your project… 35%");
    expect(m.root.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("35");
  });
  it("ready: chips show on and off from the flags with tooltips, and Restart and Settings work", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { capabilities: { ...allCapabilities, rename: false } })));
    expect(m.root.querySelector(".hub-detail")!.textContent).toBe("Ready. Completions, errors, hover and go to definition are on for this file.");
    const rename = m.root.querySelector<HTMLElement>('[data-chip="rename"]')!;
    expect(rename.getAttribute("data-on")).toBe("false");
    expect(rename.getAttribute("aria-label")).toBe("Rename: off. Renaming across files is not available for this file.");
    expect(m.root.querySelector('[data-chip="hover"]')!.getAttribute("aria-label")).toContain("Hover: on.");
    expect(m.root.querySelector('[data-chip="hover"] [role=tooltip]')!.textContent).toBe("Hover a name to see its type and documentation.");
    button(m.root, "Restart").click();
    expect(m.onAction).toHaveBeenCalledWith("restart", "jdtls");
    button(m.root, "Settings").click();
    expect(m.onAction).toHaveBeenCalledWith("settings", "jdtls");
  });
  it("runtime missing: states what was found and offers to choose or check again", () => {
    const m = mount(viewOf(java({ kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["21"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, hub: { runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } } })));
    expect(m.root.querySelector(".hub-detail")!.textContent).toBe("Java support needs JDK 25 or newer. Found: JDK 21 at /jdks/21. Install a newer JDK, or choose one.");
    button(m.root, "Choose JDK folder…").click();
    button(m.root, "Check again").click();
    expect(m.onAction.mock.calls.map(call => call[0])).toEqual(["chooseRuntime", "checkAgain"]);
  });
  it("failed: plain reason, Retry, and technical details that start closed and can be copied", async () => {
    const m = mount(viewOf(java({ kind: "install-failed", server: "jdtls", reason: "raw", retryable: true }, { state: { kind: "installFailed", reason: "raw", retryable: true }, hub: { failureReason: "Could not download Java support.", failureDetails: "GET https://x: reset" } })));
    expect(m.root.querySelector(".hub-detail")!.textContent).toBe("Could not download Java support.");
    const details = m.root.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Technical details");
    expect(details.querySelector("pre")!.textContent).toBe("GET https://x: reset");
    button(m.root, "Retry").click();
    expect(m.onAction).toHaveBeenCalledWith("retry", "jdtls");
    button(m.root, "Copy details").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.onCopy).toHaveBeenCalledWith("GET https://x: reset");
    expect(button(m.root, "Copied")).toBeDefined();
  });
  it("crashed, disabled and unavailable each have their one action", () => {
    const crashed = mount(viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })));
    expect(crashed.root.querySelector(".hub-detail")!.textContent).toBe("Java support stopped unexpectedly.");
    button(crashed.root, "Restart").click();
    const off = mount(viewOf(java({ kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false })));
    expect(off.root.querySelector(".hub-detail")!.textContent).toBe("Java support is turned off.");
    button(off.root, "Turn on").click();
    expect(off.onAction).toHaveBeenCalledWith("turnOn", "jdtls");
    const down = mount(viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), { statusError: "Could not read language server status: boom" }));
    expect(down.root.textContent).toContain("Could not read language server status: boom");
    button(down.root, "Retry").click();
    expect(down.onAction).toHaveBeenCalledWith("refresh", "vtsls");
  });
  it("restricted folder: explains, offers Trust this folder; trusted folder offers Stop trusting", () => {
    const restricted = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { hub: { trust: { workspaceTrusted: false, needsTrust: true } } })));
    expect(restricted.root.querySelector(".hub-trust")!.textContent).toContain("Only trust projects you got from a source you trust.");
    button(restricted.root, "Trust this folder").click();
    expect(restricted.onAction).toHaveBeenCalledWith("trust", "jdtls");
    const trusted = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    button(trusted.root, "Stop trusting").click();
    expect(trusted.onAction).toHaveBeenCalledWith("stopTrusting", "jdtls");
  });
  it("shows an empty note for a file without a language server", () => {
    const m = mount(viewOf(undefined));
    expect(m.root.querySelector(".hub-card")).toBeNull();
    expect(m.root.querySelector(".hub-empty")!.textContent).toContain("No language support is available for this file type");
  });
  it("all languages: switches write through and row actions act", () => {
    const view = viewOf(java({ kind: "ready", server: "jdtls" }), { servers: [java({ kind: "ready", server: "jdtls" }), makeServer("html", { kind: "needs-install", server: "html", version: "1" }, { state: { kind: "needsInstall", version: "1" }, installed: false })] });
    const m = mount(view);
    m.root.querySelector<HTMLElement>('.hub-row[data-server="html"] [role=switch]')!.click();
    expect(m.onToggleServer).toHaveBeenCalledWith("html", false);
    m.root.querySelector<HTMLElement>('.hub-row[data-server="html"] .hub-row-action')!.click();
    expect(m.onAction).toHaveBeenCalledWith("install", "html");
    expect(m.root.querySelector('.hub-row[data-server="html"] small')!.textContent).toContain("Not installed");
  });
  it("closes on Escape, on the close button and from the settings link; embedded has neither", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    m.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(m.onClose).toHaveBeenLastCalledWith(true);
    m.root.querySelector<HTMLElement>(".close-button")!.click();
    expect(m.onClose).toHaveBeenCalledTimes(2);
    button(m.root, "Language server settings").click();
    expect(m.onOpenSettings).toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(m.onClose).toHaveBeenLastCalledWith(false);
    const embedded = mount(viewOf(java({ kind: "ready", server: "jdtls" })), { embedded: true });
    expect(embedded.panel.getAttribute("role")).toBe("region");
    expect(embedded.root.querySelector(".close-button")).toBeNull();
    expect(embedded.root.textContent).not.toContain("Language server settings");
  });
  it("moves focus into the popover and labels the preview fixture", () => {
    const m = mount({ ...viewOf(java({ kind: "ready", server: "jdtls" })), preview: true });
    expect(m.root.querySelector(".hub-preview-note")!.textContent).toBe("Preview fixture, not a real language server");
    return Promise.resolve().then(() => expect(m.panel.contains(document.activeElement)).toBe(true));
  });
});
