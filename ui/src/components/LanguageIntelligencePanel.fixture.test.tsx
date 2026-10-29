// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageIntelligencePanel } from "./LanguageIntelligencePanel";
import { allCapabilities, javaInstalling, makeServer, viewOf } from "../stores/language-intelligence.testkit";
import type { HubView } from "../stores/language-intelligence";
import { serverOrder } from "../lib/language-intelligence-copy";

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
const ready = () => viewOf(java({ kind: "ready", server: "jdtls" }));
const text = (root: HTMLElement, selector: string) => root.querySelector(selector)?.textContent ?? null;
const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

describe("fixture: language server popover", () => {
  it("is a labelled dialog: header with logo, name, server and version, a state pill, chips, trust line, list and footer", () => {
    const m = mount(ready(), { fileLanguage: "java" });
    expect(m.panel.getAttribute("role")).toBe("dialog");
    expect(m.panel.getAttribute("aria-label")).toBe("Language intelligence");
    expect(m.root.querySelector(".hub-head .language-icon")!.getAttribute("data-language")).toBe("java");
    expect(text(m.root, ".hub-name strong")).toBe("Java");
    expect(text(m.root, ".hub-name small")).toBe("Eclipse JDT LS 1.62");
    expect(text(m.root, ".hub-pill")).toBe("Ready");
    expect(m.root.querySelector(".hub-pill")!.getAttribute("data-state")).toBe("ready");
    expect([...m.panel.children].map(child => child.className.split(" ")[0])).toEqual(["hub-head", "hub-chips", "hub-trust-block", "hub-list", "hub-foot"]);
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(serverOrder.length);
    expect(text(m.root, ".hub-settings-link")).toBe("Language server settings");
    expect(m.root.textContent).not.toContain("All languages");
  });
  it("shows all seven capabilities as chips and dims the unsupported ones with a spoken note", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { capabilities: { ...allCapabilities, rename: false } })));
    const chips = [...m.root.querySelectorAll<HTMLElement>(".hub-chip")];
    expect(m.root.querySelector(".hub-chips")!.getAttribute("aria-label")).toBe("Capabilities");
    expect(chips.map(chip => chip.firstChild!.textContent)).toEqual(["Completions", "Diagnostics", "Hover", "Definition", "References", "Rename", "Format"]);
    const rename = chips.find(chip => chip.textContent!.startsWith("Rename"))!;
    expect(rename.dataset.on).toBe("false");
    expect(rename.querySelector(".sr-only")!.textContent).toBe(", not supported");
    expect(chips.filter(chip => chip.dataset.on === "true")).toHaveLength(6);
  });
  it("names the file's own language in the header, for example JavaScript on the TypeScript server", () => {
    const m = mount(viewOf(makeServer("vtsls", { kind: "ready", server: "vtsls" }, { state: { kind: "ready" }, version: "0.3.0" })), { fileLanguage: "javascript" });
    expect(text(m.root, ".hub-name strong")).toBe("JavaScript");
    expect(m.root.querySelector(".hub-head .language-icon")!.getAttribute("data-language")).toBe("javascript");
    expect(text(m.root, ".hub-name small")).toBe("vtsls 0.3");
  });
  it("keeps Restart, Stop and Copy details in an overflow menu driven by the keyboard", () => {
    const m = mount(ready());
    expect(m.root.querySelector(".hub-actions")).toBeNull();
    const trigger = m.root.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("More actions");
    trigger.click();
    const menu = m.root.querySelector<HTMLElement>("[role=menu]")!;
    expect([...menu.querySelectorAll("[role=menuitem]")].map(item => item.textContent)).toEqual(["Restart", "Stop"]);
    return Promise.resolve().then(() => {
      expect(document.activeElement!.textContent).toBe("Restart");
      key(menu, "ArrowDown");
      expect(document.activeElement!.textContent).toBe("Stop");
      key(menu, "Escape");
      expect(m.root.querySelector("[role=menu]")).toBeNull();
      expect(m.onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      trigger.click();
      (m.root.querySelector<HTMLElement>('[role=menuitem][data-action="stop"]')!).click();
      expect(m.onAction).toHaveBeenCalledWith("stop", "jdtls");
      trigger.click();
      (m.root.querySelector<HTMLElement>('[role=menuitem][data-action="restart"]')!).click();
      expect(m.onAction).toHaveBeenCalledWith("restart", "jdtls");
    });
  });
  it("needs install: the sentence, the size and an Install button", () => {
    const view = viewOf(makeServer("jdtls", { kind: "needs-install", server: "jdtls", version: "1.62.0", sizeHint: 120 * MB }, { state: { kind: "needsInstall", version: "1" }, installed: false }), { autoInstall: false });
    const m = mount(view);
    expect(text(m.root, ".hub-pill")).toBe("Not installed");
    expect(text(m.root, ".hub-status-text")).toBe("Install for completions and errors (about 120 MB)");
    expect(m.root.querySelector(".hub-status")!.getAttribute("data-tip")).toContain("Automatic install is off");
    button(m.root, "Install").click();
    expect(m.onAction).toHaveBeenCalledWith("install", "jdtls");
  });
  it("installing: one progress bar with its value, the phase line, the percent and Cancel", () => {
    const m = mount(viewOf(javaInstalling(42, 134 * MB, 320 * MB)));
    const bars = m.root.querySelectorAll("[role=progressbar]");
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-valuenow")).toBe("42");
    expect(bars[0].getAttribute("aria-label")).toBe("Installing Java");
    expect((bars[0].querySelector("i") as HTMLElement).style.width).toBe("42%");
    expect(text(m.root, ".hub-status-text")).toBe("Downloading 134 of 320 MB");
    expect(text(m.root, ".hub-pill")).toBe("Installing");
    expect(m.root.querySelector(".hub-pill")!.getAttribute("data-state")).toBe("starting");
    expect(text(m.root, "[data-testid=hub-percent]")).toBe("42%");
    button(m.root, "Cancel").click();
    expect(m.onAction).toHaveBeenCalledWith("cancel", "jdtls");
  });
  it("has no progress bar and no status line when the server is ready", () => {
    const m = mount(ready());
    expect(m.root.querySelector(".hub-progress")).toBeNull();
    expect(m.root.querySelector(".hub-status")).toBeNull();
  });
  it("starting and indexing", () => {
    expect(text(mount(viewOf(java({ kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }))).root, ".hub-status-text")).toBe("The first start can take a minute");
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, {}, [{ title: "Indexing project", message: "Reading classes", percentage: 35 }])));
    expect(text(m.root, ".hub-pill")).toBe("Indexing");
    expect(text(m.root, ".hub-status-text")).toBe("Reading classes");
    expect(m.root.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("35");
  });
  it("runtime missing: states what was found and offers to choose or check again", () => {
    const m = mount(viewOf(java({ kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["21"] }, { state: { kind: "runtimeMissing", runtime: "Java", requiredVersion: 25, found: ["21"] }, hub: { runtime: { name: "JDK", requiredVersion: 25, foundVersion: "21", foundPath: "/jdks/21" } } })));
    expect(text(m.root, ".hub-status-text")).toBe("Needs JDK 25 or newer. Found JDK 21");
    expect(m.root.querySelector(".hub-pill")!.getAttribute("data-state")).toBe("error");
    button(m.root, "Choose JDK").click();
    button(m.root, "Check again").click();
    expect(m.onAction.mock.calls.map(call => call[0])).toEqual(["chooseRuntime", "checkAgain"]);
  });
  it("errors: the real message and details on screen, Retry, and details that can be copied", async () => {
    const m = mount(viewOf(java({ kind: "install-failed", server: "jdtls", reason: "raw", retryable: true }, { state: { kind: "installFailed", reason: "raw", retryable: true }, hub: { failureReason: "Could not download Java support.", failureDetails: "GET https://x: reset" } })));
    expect(text(m.root, ".hub-pill")).toBe("Install failed");
    const alert = m.root.querySelector("[role=alert]")!;
    expect(text(alert as HTMLElement, ".hub-error-reason")).toBe("Could not download Java support.");
    expect(text(alert as HTMLElement, ".hub-error-details")).toBe("GET https://x: reset");
    button(m.root, "Retry").click();
    expect(m.onAction).toHaveBeenCalledWith("retry", "jdtls");
    button(m.root, "Copy details").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(m.onCopy).toHaveBeenCalledWith("GET https://x: reset");
    expect(button(m.root, "Copied")).toBeDefined();
  });
  it("crashed, disabled and unavailable each keep their action", () => {
    const crashed = mount(viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })));
    expect(text(crashed.root, ".hub-status-text")).toBe("Stopped unexpectedly");
    button(crashed.root, "Restart").click();
    expect(crashed.onAction).toHaveBeenCalledWith("restart", "jdtls");
    const off = mount(viewOf(java({ kind: "disabled", server: "jdtls" }, { state: { kind: "disabled" }, enabled: false })));
    expect(text(off.root, ".hub-pill")).toBe("Off");
    expect(off.root.querySelector(".hub-pill")!.getAttribute("data-state")).toBe("off");
    button(off.root, "Turn on").click();
    expect(off.onAction).toHaveBeenCalledWith("turnOn", "jdtls");
    const down = mount(viewOf(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), { statusError: "Could not read language server status: boom" }));
    expect(text(down.root, ".hub-status-text")).toBe("Status unavailable. Try again.");
    button(down.root, "Retry").click();
    expect(down.onAction).toHaveBeenCalledWith("refresh", "vtsls");
  });
  it("trust: one compact line with one action, and the short explanation only when untrusted", () => {
    const restricted = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { hub: { trust: { workspaceTrusted: false, needsTrust: true } } })));
    expect(text(restricted.root, ".hub-pill")).toBe("Needs trust");
    expect(restricted.root.querySelector(".hub-pill")!.getAttribute("data-state")).toBe("needs-trust");
    expect(text(restricted.root, ".hub-trust")).toBe("Untrusted folder");
    expect(text(restricted.root, ".hub-trust-why")).toContain("Trust only folders you know.");
    expect(restricted.root.querySelectorAll(".hub-trust-block button")).toHaveLength(1);
    expect(restricted.root.querySelector(".hub-actions [data-action=trust]")).toBeNull();
    button(restricted.root, "Trust").click();
    expect(restricted.onAction).toHaveBeenCalledWith("trust", "jdtls");
    const trusted = mount(ready());
    expect(text(trusted.root, ".hub-trust")).toBe("Trusted folder");
    expect(trusted.root.querySelector(".hub-trust-why")).toBeNull();
    button(trusted.root, "Stop trusting").click();
    expect(trusted.onAction).toHaveBeenCalledWith("stopTrusting", "jdtls");
  });
  it("explains what is missing for a file whose language has no server", () => {
    const m = mount(viewOf(undefined), { fileLanguage: "markdown" });
    expect(text(m.root, ".hub-name strong")).toBe("Markdown");
    expect(text(m.root, ".hub-name small")).toBe("No language support");
    expect(m.root.querySelector(".hub-head .language-icon")!.getAttribute("data-language")).toBe("markdown");
    expect(m.root.querySelector(".hub-pill")).toBeNull();
    expect(text(m.root, ".hub-status-text")).toBe("No completions or error checking for Markdown. Editing works as usual.");
    expect(m.root.querySelector(".hub-chips")).toBeNull();
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(serverOrder.length);
    const plain = mount(viewOf(undefined), { fileLanguage: "text" });
    expect(text(plain.root, ".hub-status-text")).toBe("No language support for this file type.");
    expect(plain.root.querySelector(".hub-head .language-icon")!.getAttribute("data-language")).toBe("unknown");
  });
  it("rows: logo, name, server, state dot or spinner, and a switch; the row action still acts", () => {
    const view = viewOf(java({ kind: "ready", server: "jdtls" }), { servers: [java({ kind: "ready", server: "jdtls" }), makeServer("html", { kind: "needs-install", server: "html", version: "1" }, { state: { kind: "needsInstall", version: "1" }, installed: false }), makeServer("css", { kind: "starting", server: "css" }, { state: { kind: "starting" } })] });
    const m = mount(view);
    const row = (id: string) => m.root.querySelector<HTMLElement>(`.hub-row[data-server="${id}"]`)!;
    expect(row("jdtls").classList.contains("current")).toBe(true);
    expect(row("jdtls").querySelector(".language-icon")!.getAttribute("data-language")).toBe("java");
    expect(text(row("jdtls"), ".hub-row-server")).toBe("Eclipse JDT LS");
    expect(row("jdtls").querySelector(".lsp-dot")!.getAttribute("aria-label")).toBe("Ready");
    expect(row("css").querySelector(".hub-spinner")!.getAttribute("aria-label")).toBe("Starting");
    expect(row("css").querySelector(".lsp-dot")).toBeNull();
    expect(text(row("html"), ".hub-row-word")).toBe("Not installed");
    row("html").querySelector<HTMLElement>("[role=switch]")!.click();
    expect(m.onToggleServer).toHaveBeenCalledWith("html", false);
    row("html").querySelector<HTMLElement>(".hub-row-action")!.click();
    expect(m.onAction).toHaveBeenCalledWith("install", "html");
    expect(row("jdtls").querySelector("[role=switch]")!.getAttribute("aria-label")).toBe("Java language support");
  });
  it("arrow keys move between rows, Home and End jump, and Space on a switch toggles it", () => {
    const m = mount(ready());
    const switches = [...m.root.querySelectorAll<HTMLButtonElement>(".hub-row [role=switch]")];
    switches[0].focus();
    key(switches[0], "ArrowDown");
    expect(document.activeElement).toBe(switches[1]);
    key(switches[1], "ArrowUp");
    expect(document.activeElement).toBe(switches[0]);
    key(switches[0], "End");
    expect(document.activeElement).toBe(switches.at(-1));
    key(switches.at(-1)!, "Home");
    expect(document.activeElement).toBe(switches[0]);
    expect(switches[0].tagName).toBe("BUTTON");
  });
  it("shows the All / Active filter only when it filters, and it really filters", () => {
    expect(mount(ready()).root.querySelector("[role=radiogroup]")).toBeNull();
    const view = viewOf(java({ kind: "ready", server: "jdtls" }), { servers: [java({ kind: "ready", server: "jdtls" }), makeServer("html", { kind: "disabled", server: "html" }, { state: { kind: "disabled" }, enabled: false })] });
    const m = mount(view);
    const group = m.root.querySelector("[role=radiogroup]")!;
    expect(group.getAttribute("aria-label")).toBe("Show languages");
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(2);
    button(m.root, "Active").click();
    expect([...m.root.querySelectorAll<HTMLElement>(".hub-row")].map(row => row.dataset.server)).toEqual(["jdtls"]);
    expect(button(m.root, "Active").getAttribute("aria-checked")).toBe("true");
    key(button(m.root, "Active"), "ArrowLeft");
    expect(m.root.querySelectorAll(".hub-row")).toHaveLength(2);
    expect(m.root.querySelector(".hub-search")).toBeNull();
  });
  it("closes on Escape and an outside click and from the settings link; embedded is a region without the link", () => {
    const m = mount(ready());
    key(m.panel, "Escape");
    expect(m.onClose).toHaveBeenLastCalledWith(true);
    button(m.root, "Language server settings").click();
    expect(m.onOpenSettings).toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(m.onClose).toHaveBeenLastCalledWith(false);
    const embedded = mount(ready(), { embedded: true });
    expect(embedded.panel.getAttribute("role")).toBe("region");
    expect(embedded.root.textContent).not.toContain("Language server settings");
    expect(embedded.root.querySelectorAll(".hub-row")).toHaveLength(serverOrder.length);
  });
  it("opens above the status bar when asked, and under the top bar by default", () => {
    expect(mount(ready()).panel.dataset.placement).toBe("top");
    expect(mount(ready(), { placement: "bottom" }).panel.dataset.placement).toBe("bottom");
  });
  it("moves focus into the popover and tags the preview fixture", () => {
    const m = mount({ ...ready(), preview: true });
    expect(text(m.root, ".hub-name small")).toBe("Eclipse JDT LS 1.62 · preview");
    return Promise.resolve().then(() => expect(m.panel.contains(document.activeElement)).toBe(true));
  });
  it("has no title attribute and no em dash anywhere", () => {
    for (const view of [ready(), viewOf(java({ kind: "crashed", server: "jdtls" }, { state: { kind: "crashed" } })), viewOf(undefined)]) {
      const m = mount(view, { fileLanguage: "rust" });
      expect(m.root.querySelector("[title]")).toBeNull();
      expect(m.root.textContent).not.toContain("\u2014");
    }
  });
});
