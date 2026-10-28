// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { TrustBanner } from "./TrustBanner";
import { makeServer, viewOf } from "../stores/language-intelligence.testkit";

// Fixture tests: the banner view comes from the pure view model.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
const banner = (restarting = false) => viewOf(makeServer("jdtls", { kind: "ready", server: "jdtls" }, { state: { kind: "ready" }, hub: { trust: { workspaceTrusted: false, needsTrust: true } } }), { trustRestarting: restarting }).banner!;
function mount(view = banner()) {
  const root = document.createElement("div"); document.body.append(root);
  const onTrust = vi.fn(); const onDismiss = vi.fn();
  disposers.push(render(() => <TrustBanner banner={view} onTrust={onTrust} onDismiss={onDismiss} />, root));
  return { root, onTrust, onDismiss };
}
const named = (root: HTMLElement, label: string) => [...root.querySelectorAll("button")].find(item => item.textContent!.startsWith(label))!;

describe("fixture: folder trust banner", () => {
  it("asks the question, explains, and has the three choices", () => {
    const m = mount();
    expect(m.root.querySelector("strong")!.textContent).toBe("Trust this folder to load project dependencies?");
    expect(m.root.textContent).toContain("Language support needs to run this project's build tool (Maven, Gradle or Cargo) to understand its libraries. Only trust projects you got from a source you trust.");
    expect(m.root.querySelector("section")!.getAttribute("aria-label")).toBe("Folder trust");
    named(m.root, "Trust folder").click();
    expect(m.onTrust).toHaveBeenCalled();
    named(m.root, "Not now").click();
    expect(m.onDismiss).toHaveBeenCalled();
  });
  it("Learn more expands and collapses an inline explanation", () => {
    const m = mount();
    const more = named(m.root, "Learn more");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(m.root.querySelector(".trust-banner-more")).toBeNull();
    more.click();
    expect(m.root.querySelector(".trust-banner-more")!.textContent).toContain("restricted mode");
    expect(named(m.root, "Hide details").getAttribute("aria-expanded")).toBe("true");
    named(m.root, "Hide details").click();
    expect(m.root.querySelector(".trust-banner-more")).toBeNull();
  });
  it("shows only the restarting message while restarting", () => {
    const m = mount(banner(true));
    expect(m.root.querySelector("[role=status]")!.textContent).toBe("Restarting Java support with project dependencies…");
    expect(m.root.querySelectorAll("button")).toHaveLength(0);
  });
});
