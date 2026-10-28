// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TrustBanner } from "./TrustBanner";
import { makeServer, viewOf } from "../stores/language-intelligence.testkit";

// Fixture tests: the prompt view comes from the pure view model.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
const banner = (restarting = false) => viewOf(makeServer("jdtls", { kind: "ready", server: "jdtls" }, { state: { kind: "ready" }, hub: { trust: { workspaceTrusted: false, needsTrust: true } } }), { trustRestarting: restarting }).banner!;
function mount(view = banner()) {
  const root = document.createElement("div"); document.body.append(root);
  const onTrust = vi.fn(); const onDismiss = vi.fn();
  disposers.push(render(() => <TrustBanner banner={view} onTrust={onTrust} onDismiss={onDismiss} />, root));
  return { root, onTrust, onDismiss };
}
const named = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find(item => item.textContent!.startsWith(label) || item.getAttribute("aria-label") === label)!;

describe("fixture: folder trust prompt", () => {
  it("asks one short question and has Trust folder, Not now and a close button", () => {
    const m = mount();
    expect(m.root.querySelector("p")!.textContent).toBe("Trust this folder to load its dependencies?");
    expect(m.root.querySelector("section")!.getAttribute("aria-label")).toBe("Folder trust");
    expect(m.root.querySelectorAll("p")).toHaveLength(1);
    named(m.root, "Trust folder").click();
    expect(m.onTrust).toHaveBeenCalled();
    named(m.root, "Not now").click();
    named(m.root, "Dismiss").click();
    expect(m.onDismiss).toHaveBeenCalledTimes(2);
  });
  it("has no Learn more: the long explanation lives in the panel footer tooltip", () => {
    const m = mount();
    expect(m.root.textContent).not.toMatch(/learn more|build tool/i);
    expect(banner().explain).toContain("Only trust folders from a source you trust.");
  });
  it("shows only the restarting message while restarting", () => {
    const m = mount(banner(true));
    expect(m.root.querySelector("[role=status]")!.textContent).toBe("Restarting Java with its dependencies");
    expect(m.root.querySelectorAll("button")).toHaveLength(0);
  });
  it("is out of the layout flow, so showing it moves nothing", () => {
    const css = readFileSync(resolve(__dirname, "../styles/language-servers.css"), "utf8");
    const rule = /\.trust-banner\{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain("position:absolute");
    expect(rule).toMatch(/z-index:\d+/);
    expect(Number(/z-index:(\d+)/.exec(rule)![1])).toBeLessThan(100);
  });
});
