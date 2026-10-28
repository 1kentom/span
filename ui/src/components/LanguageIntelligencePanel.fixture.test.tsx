// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageIntelligencePanel } from "./LanguageIntelligencePanel";
import { allLanguagesOpen, setAllLanguagesOpen } from "../lib/hub-prefs";
import { allCapabilities, javaInstalling, makeServer, viewOf } from "../stores/language-intelligence.testkit";
import type { HubView } from "../stores/language-intelligence";

// Fixture tests: static views are passed in, no store or server is running.
const MB = 1024 * 1024;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
beforeEach(() => { try { window.localStorage.clear(); } catch { /* jsdom storage */ } setAllLanguagesOpen(false); });
function mount(view: HubView, extra: Partial<Parameters<typeof LanguageIntelligencePanel>[0]> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const fns = { onAction: vi.fn(), onToggleServer: vi.fn(), onClose: vi.fn(), onOpenSettings: vi.fn(), onCopy: vi.fn(async () => undefined) };
  disposers.push(render(() => <LanguageIntelligencePanel view={view} {...fns} {...extra} />, root));
  return { root, ...fns, panel: root.querySelector<HTMLElement>(".hub-panel")! };
}
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find(item => item.textContent === label)!;
const java = (state: any, entry: any = {}, activity: any[] = []) => makeServer("jdtls", state, { state: { kind: "ready" }, ...entry }, activity);

const status = (root: HTMLElement) => root.querySelector(".hub-status-text")!.textContent;

describe("fixture: hub panel", () => {
  it("is a labelled dialog with the language, a short technical line and one status line", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(m.panel.getAttribute("role")).toBe("dialog");
    expect(m.panel.getAttribute("aria-label")).toBe("Language intelligence");
    expect(m.root.querySelector(".hub-name strong")!.textContent).toBe("Java");
    expect(m.root.querySelector(".hub-name small")!.textContent).toBe("Eclipse JDT LS 1.62");
    expect(status(m.root)).toBe("Completions, errors, hover, go to definition, references, rename, format");
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(7);
    expect(m.root.querySelector(".hub-chip")).toBeNull();
    expect(m.root.textContent).toContain("Language server settings");
  });
  it("shows Ready as a dot with a label and no word, and never says Ready twice", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(m.root.querySelector(".hub-state-word")!.textContent).toBe("");
    expect(m.root.querySelector(".hub-state .lsp-dot")!.getAttribute("aria-label")).toBe("Ready");
    expect(m.root.querySelector(".hub-state")!.getAttribute("data-tip")).toBe("Ready");
    expect((m.root.textContent!.match(/Ready/g) ?? []).length).toBe(0);
  });
  it("has the same zones in every state: header, status, progress track, action row and footer", () => {
    const states = [
      viewOf(java({ kind: "ready", server: "jdtls" })), viewOf(javaInstalling(42, 134 * MB, 320 * MB)),
      viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })), viewOf(undefined),
    ];
    for (const view of states) {
      const m = mount(view);
      expect([...m.panel.children].map(child => child.className.split(" ")[0])).toEqual(["hub-head", "hub-status", "hub-progress", "hub-actions", "hub-foot", "hub-rows"]);
      disposers.splice(0).forEach(d => d()); document.body.replaceChildren();
    }
  });
  it("needs install: one sentence, the size, and an Install button", () => {
    const view = viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1.62.0", sizeHint: 120 * MB }, { state: { kind: "needsInstall", version: "1" }, installed: false }), { autoInstall: false });
    const m = mount(view);
    expect(status(m.root)).toBe("Install for completions and errors (about 120 MB)");
    expect(m.root.querySelector(".hub-status")!.getAttribute("data-tip")).toContain("Automatic install is off");
    button(m.root, "Install").click();
    expect(m.onAction).toHaveBeenCalledWith("install", "jdtls");
  });
  it("installing: a single progress bar with the value, the phase line, a fixed percent slot and Cancel", () => {
    const m = mount(viewOf(javaInstalling(42, 134 * MB, 320 * MB)));
    const bars = m.root.querySelectorAll("[role=progressbar]");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-valuenow")).toBe("42");
    expect(bars[0].getAttribute("aria-valuemin")).toBe("0");
    expect(bars[0].getAttribute("aria-valuemax")).toBe("100");
    expect(bars[0].getAttribute("aria-label")).toBe("Installing Java");
    expect((bars[0].querySelector("i") as HTMLElement).style.width).toBe("42%");
    expect(status(m.root)).toBe("Downloading 134 of 320 MB");
    expect(m.root.querySelector(".hub-state-word")!.textContent).toBe("Installing");
    expect(m.root.querySelector("[data-testid=hub-percent]")!.textContent).toBe("42%");
    button(m.root, "Cancel").click();
    expect(m.onAction).toHaveBeenCalledWith("cancel", "jdtls");
  });
  it("keeps an idle track in the layout when nothing runs", () => {
    const track = mount(viewOf(java({ kind: "ready", server: "jdtls" }))).root.querySelector(".hub-progress")!;
    expect(track.classList.contains("idle")).toBe(true);
    expect(track.hasAttribute("role")).toBe(false);
    expect(track.getAttribute("aria-hidden")).toBe("true");
  });
  it("installing with an unknown total shows an indeterminate bar without a value", () => {
    const m = mount(viewOf(makeServer("jdtls", { kind: "installing", server: "jdtls", phase: "downloading", overallReceived: 3 * MB, overallTotal: null }, { state: { kind: "installing" } })));
    const bar = m.root.querySelector("[role=progressbar]")!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.querySelector("i")!.classList.contains("indeterminate")).toBe(true);
    expect(m.root.querySelector("[data-testid=hub-percent]")!.textContent).toBe("");
  });
  it("starting and indexing", () => {
    expect(status(mount(viewOf(java({ kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }))).root)).toBe("The first start can take a minute");
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, {}, [{ title: "Indexing project", message: "Reading classes", percentage: 35 }])));
    expect(m.root.querySelector(".hub-state-word")!.textContent).toBe("Indexing");
    expect(status(m.root)).toBe("Reading classes");
    expect(m.root.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("35");
    expect(m.root.querySelector("[data-testid=hub-percent]")!.textContent).toBe("35%");
  });
  it("ready: lists only what is on, with no off features, and Restart works", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { capabilities: { ...allCapabilities, rename: false } })));
    expect(status(m.root)).toBe("Completions, errors, hover, go to definition, references, format");
    expect(m.root.querySelector(".hub-status")!.textContent).not.toMatch(/rename/i);
    button(m.root, "Restart").click();
    expect(m.onAction).toHaveBeenCalledWith("restart", "jdtls");
    expect(m.root.querySelectorAll(".hub-actions button")).toHaveLength(1);
  });
  it("runtime missing: states what was found and offers to choose or check again", () => {
    const m = mount(viewOf(java({ kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["21"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, hub: { runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } } })));
    expect(status(m.root)).toBe("Needs JDK 25 or newer. Found JDK 21");
    expect(m.root.querySelector(".hub-status")!.getAttribute("data-tip")).toBe("Found at /jdks/21. Install a newer JDK, or choose one.");
    button(m.root, "Choose JDK").click();
    button(m.root, "Check again").click();
    expect(m.onAction.mock.calls.map(call => call[0])).toEqual(["chooseRuntime", "checkAgain"]);
  });
  it("failed: a short line, the reason and details in the tooltip, Retry, and details that can be copied", async () => {
    const m = mount(viewOf(java({ kind: "install-failed", server: "jdtls", reason: "raw", retryable: true }, { state: { kind: "installFailed", reason: "raw", retryable: true }, hub: { failureReason: "Could not download Java support.", failureDetails: "GET https://x: reset" } })));
    expect(status(m.root)).toBe("Couldn't install. Check your connection");
    expect(m.root.querySelector(".hub-status")!.getAttribute("data-tip")).toBe("Could not download Java support. GET https://x: reset");
    expect(m.root.querySelector("details")).toBeNull();
    button(m.root, "Retry").click();
    expect(m.onAction).toHaveBeenCalledWith("retry", "jdtls");
    button(m.root, "Copy details").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.onCopy).toHaveBeenCalledWith("GET https://x: reset");
    expect(m.onAction).toHaveBeenCalledTimes(1);
    expect(button(m.root, "Copied")).toBeDefined();
  });
  it("crashed, disabled and unavailable each have their one action", () => {
    const crashed = mount(viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })));
    expect(status(crashed.root)).toBe("Stopped unexpectedly");
    button(crashed.root, "Restart").click();
    const off = mount(viewOf(java({ kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false })));
    expect(status(off.root)).toBe("Turn on for completions and errors");
    expect(off.root.querySelector(".hub-state-word")!.textContent).toBe("Off");
    button(off.root, "Turn on").click();
    expect(off.onAction).toHaveBeenCalledWith("turnOn", "jdtls");
    const down = mount(viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), { statusError: "Could not read language server status: boom" }));
    expect(status(down.root)).toBe("Status unavailable. Try again.");
    expect(down.root.querySelector(".hub-status")!.getAttribute("data-tip")).toBe("Could not read language server status: boom");
    button(down.root, "Retry").click();
    expect(down.onAction).toHaveBeenCalledWith("refresh", "vtsls");
  });
  it("trust: a footer line with a tooltip, Trust folder when untrusted, Stop trusting when trusted", () => {
    const restricted = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { hub: { trust: { workspaceTrusted: false, needsTrust: true } } })));
    const line = restricted.root.querySelector(".hub-trust")!;
    expect(line.textContent).toBe("Untrusted folderWhy?");
    expect(line.getAttribute("data-tip")).toContain("Only trust folders from a source you trust.");
    expect(restricted.root.textContent).not.toContain("Stop trusting");
    button(restricted.root, "Trust folder").click();
    expect(restricted.onAction).toHaveBeenCalledWith("trust", "jdtls");
    const trusted = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(trusted.root.querySelector(".hub-trust")!.textContent).toBe("Trusted folder");
    button(trusted.root, "Stop trusting").click();
    expect(trusted.onAction).toHaveBeenCalledWith("stopTrusting", "jdtls");
  });
  it("shows the plain sentence and no card for a file without a language server", () => {
    const m = mount(viewOf(undefined));
    expect(m.root.querySelector(".hub-state")).toBeNull();
    expect(m.root.querySelector(".hub-name strong")!.textContent).toBe("Language intelligence");
    expect(status(m.root)).toBe("No language support for this file type.");
    expect(m.root.querySelectorAll(".hub-actions button")).toHaveLength(0);
  });
  it("all languages: collapsed by default, remembered when opened, and the only thing the list changes", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    const toggle = button(m.root, "All languages");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(m.root.querySelector<HTMLElement>(".hub-rows")!.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(m.root.querySelector<HTMLElement>(".hub-rows")!.hidden).toBe(false);
    expect(allLanguagesOpen()).toBe(true);
    expect(window.localStorage.getItem("span.languageIntelligence.allLanguagesOpen")).toBe("true");
    const again = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(again.root.querySelector<HTMLElement>(".hub-rows")!.hidden).toBe(false);
  });
  it("all languages: switches write through, row actions act, and only a word for a language that is not ready", () => {
    setAllLanguagesOpen(true);
    const view = viewOf(java({ kind: "ready", server: "jdtls" }), { servers: [java({ kind: "ready", server: "jdtls" }), makeServer("html", { kind: "needs-install", server: "html", version: "1" }, { state: { kind: "needsInstall", version: "1" }, installed: false })] });
    const m = mount(view);
    m.root.querySelector<HTMLElement>('.hub-row[data-server="html"] [role=switch]')!.click();
    expect(m.onToggleServer).toHaveBeenCalledWith("html", false);
    m.root.querySelector<HTMLElement>('.hub-row[data-server="html"] .hub-row-action')!.click();
    expect(m.onAction).toHaveBeenCalledWith("install", "html");
    expect(m.root.querySelector('.hub-row[data-server="html"] .hub-row-word')!.textContent).toBe("Not installed");
    expect(m.root.querySelector('.hub-row[data-server="jdtls"] .hub-row-word')!.textContent).toBe("");
    expect(m.root.querySelector('.hub-row[data-server="jdtls"] .hub-row-action')).toBeNull();
  });
  it("closes on Escape and an outside click and from the settings link; embedded has no link and the list stays open", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    m.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(m.onClose).toHaveBeenLastCalledWith(true);
    button(m.root, "Language server settings").click();
    expect(m.onOpenSettings).toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(m.onClose).toHaveBeenLastCalledWith(false);
    expect(m.root.querySelector(".close-button")).toBeNull();
    const embedded = mount(viewOf(java({ kind: "ready", server: "jdtls" })), { embedded: true });
    expect(embedded.panel.getAttribute("role")).toBe("region");
    expect(embedded.root.textContent).not.toContain("Language server settings");
    expect(embedded.root.querySelector<HTMLElement>(".hub-rows")!.hidden).toBe(false);
  });
  it("moves focus into the popover and labels the preview fixture in the technical line", () => {
    const m = mount({ ...viewOf(java({ kind: "ready", server: "jdtls" })), preview: true });
    expect(m.root.querySelector(".hub-name small")!.textContent).toBe("Eclipse JDT LS 1.62 \u00b7 preview");
    return Promise.resolve().then(() => expect(m.panel.contains(document.activeElement)).toBe(true));
  });
  it("has no title attribute anywhere: tooltips come from the view", () => {
    const m = mount(viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })));
    expect(m.root.querySelector("[title]")).toBeNull();
  });
});
