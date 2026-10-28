// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageIntelligenceButton } from "./LanguageIntelligenceButton";
import { LanguageServerStatus } from "./LanguageServerStatus";
import { javaInstalling, makeServer, viewOf } from "../stores/language-intelligence.testkit";
import type { HubView } from "../stores/language-intelligence";

// Fixture tests: static views are passed in.
const MB = 1024 * 1024;
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
function mount(view: HubView, open = false) {
  const root = document.createElement("div"); document.body.append(root);
  const onToggle = vi.fn();
  disposers.push(render(() => <><LanguageIntelligenceButton view={view} open={open} onToggle={onToggle} /><LanguageServerStatus view={view} open={open} onToggle={onToggle} /></>, root));
  return { root, onToggle, button: root.querySelector<HTMLButtonElement>(".hub-button")!, status: root.querySelector<HTMLButtonElement>(".lsp-status-button") };
}
const java = (state: any, entry: any = {}, activity: any[] = []) => makeServer("jdtls", state, { state: { kind: "ready" }, ...entry }, activity);

describe("fixture: top bar button and status bar item", () => {
  it("is neutral for a file without a language server and the status bar item is absent", () => {
    const m = mount(viewOf(undefined));
    expect(m.button.dataset.tone).toBe("off");
    expect(m.button.dataset.ring).toBe("none");
    expect(m.button.querySelector(".hub-badge")).toBeNull();
    expect(m.button.getAttribute("aria-label")).toBe("Language intelligence. No language support for this file.");
    expect(m.status).toBeNull();
  });
  it("shows a determinate ring with the real percent while installing", () => {
    const m = mount(viewOf(javaInstalling(42, 134 * MB, 320 * MB)));
    expect(m.button.dataset.ring).toBe("determinate");
    expect(m.button.dataset.percent).toBe("42");
    const dash = m.button.querySelector(".hub-ring-bar")!.getAttribute("stroke-dasharray")!;
    expect(parseFloat(dash)).toBeCloseTo(2 * Math.PI * 12 * 0.42, 1);
    expect(m.button.getAttribute("aria-label")).toBe("Language intelligence. Installing Java (42%).");
    expect(m.status!.textContent).toBe("Java 42%");
    expect(m.status!.getAttribute("aria-label")).toBe(m.button.getAttribute("aria-label"));
  });
  it("shows a spinning ring while starting and a determinate one while indexing", () => {
    expect(mount(viewOf(java({ kind: "starting", server: "jdtls" }, { state: { kind: "starting" } }))).button.querySelector(".hub-ring-bar")!.classList.contains("spin")).toBe(true);
    expect(mount(viewOf(java({ kind: "ready", server: "jdtls" }, {}, [{ percentage: 35 }]))).button.dataset.percent).toBe("35");
  });
  it("is the blue bolt with no badge and no check when ready, and the status bar item is just the language", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    expect(m.button.dataset.tone).toBe("ok");
    expect(m.button.classList.contains("blue")).toBe(true);
    expect(m.button.querySelector(".hub-badge")).toBeNull();
    expect(m.button.hasAttribute("data-check")).toBe(false);
    expect(m.status!.textContent).toBe("Java");
  });
  it("shows an attention badge for needs install, runtime missing, failed and crashed", () => {
    const cases: [any, string][] = [
      [{ kind: "needs-install", server: "jdtls", version: "1" }, "Language intelligence. Java is not installed."],
      [{ kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: [] }, "Language intelligence. Java needs JDK."],
      [{ kind: "install-failed", server: "jdtls", reason: "x", retryable: true }, "Language intelligence. Java did not install."],
      [{ kind: "crashed", server: "jdtls" }, "Language intelligence. Java stopped unexpectedly."],
    ];
    for (const [state, label] of cases) {
      const m = mount(viewOf(java(state, { state: { kind: "ready" } })));
      expect(m.button.dataset.badge).toBe("attention");
      expect(m.button.querySelector(".hub-badge.dot")).not.toBeNull();
      expect(m.button.getAttribute("aria-label")).toBe(label);
      disposers.splice(0).forEach(d => d()); document.body.replaceChildren();
    }
  });
  it("shows a Restricted badge for a folder that needs trust", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" }, { hub: { trust: { workspaceTrusted: false, needsTrust: true } } })));
    expect(m.button.dataset.badge).toBe("restricted");
    expect(m.button.getAttribute("aria-label")).toBe("Language intelligence. Java is ready, folder not trusted.");
    expect(m.status!.textContent).toBe("Java \u00b7 Trust");
    expect(m.button.querySelector(".hub-badge.dot")).not.toBeNull();
  });
  it("has no title attribute, a tooltip that reads the same summary, and none while the panel is open", () => {
    const view = viewOf(javaInstalling(42, 134 * MB, 320 * MB));
    const m = mount(view);
    expect(m.root.querySelector("[title]")).toBeNull();
    m.button.dispatchEvent(new PointerEvent("pointerenter"));
    expect(m.root.querySelector("[role=tooltip]")!.textContent).toBe("Installing Java (42%)");
    m.button.dispatchEvent(new PointerEvent("pointerleave"));
    expect(m.root.querySelector("[role=tooltip]")).toBeNull();
    const open = mount(view, true);
    open.button.dispatchEvent(new FocusEvent("focus"));
    expect(open.root.querySelector("[role=tooltip]")).toBeNull();
    expect(open.button.getAttribute("aria-expanded")).toBe("true");
    expect(open.button.getAttribute("aria-haspopup")).toBe("dialog");
  });
  it("passes its own element to the toggle so focus can return to it", () => {
    const m = mount(viewOf(java({ kind: "ready", server: "jdtls" })));
    m.button.click(); m.status!.click();
    expect(m.onToggle.mock.calls[0][0]).toBe(m.button);
    expect(m.onToggle.mock.calls[1][0]).toBe(m.status);
  });
});
