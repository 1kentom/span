// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageServerSettings } from "./LanguageServerSettings";

// Fixture tests: the settings write callback is a spy. They prove which key and scope each control writes.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
const value = { autoInstall: true, enabled: {}, javaHome: "/jdk", nodePath: null, runProjectCode: false };
function mount() {
  const root = document.createElement("div"); document.body.append(root);
  const onChange = vi.fn(async () => undefined);
  disposers.push(render(() => <LanguageServerSettings value={{ ...value, javaHome: null }} userValue={value} onChange={onChange} />, root));
  return { root, onChange };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("fixture: language server settings writes", () => {
  it("writes only the flipped server key in the current scope", async () => {
    const m = mount();
    m.root.querySelector<HTMLButtonElement>('[aria-label="Enable vtsls"]')!.click();
    await settle();
    expect(m.onChange).toHaveBeenCalledWith("languageServers.enabled.vtsls", false, "current");
    expect(m.onChange).toHaveBeenCalledTimes(1);
  });
  it("writes the user only keys to the user scope and labels them", async () => {
    const m = mount();
    expect(m.root.textContent).toContain("User setting");
    expect((m.root.querySelector("#sp-lsp-java") as HTMLInputElement).value).toBe("/jdk");
    m.root.querySelector<HTMLButtonElement>("#sp-lsp-auto-install")!.click();
    await settle();
    expect(m.onChange).toHaveBeenLastCalledWith("languageServers.autoInstall", false, "user");
    const node = m.root.querySelector<HTMLInputElement>("#sp-lsp-node")!;
    node.value = " /usr/bin/node "; node.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(m.onChange).toHaveBeenLastCalledWith("languageServers.nodePath", "/usr/bin/node", "user");
    node.value = ""; node.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(m.onChange).toHaveBeenLastCalledWith("languageServers.nodePath", null, "user");
  });
  it("writes the project code switch to the user scope with a warning", async () => {
    const m = mount();
    const toggle = m.root.querySelector<HTMLButtonElement>("#sp-lsp-run-project-code")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(m.root.textContent).toContain("Run project build code (build.rs, proc macros, Gradle and Maven import)");
    expect(m.root.textContent).toContain("untrusted project");
    toggle.click();
    await settle();
    expect(m.onChange).toHaveBeenLastCalledWith("languageServers.runProjectCode", true, "user");
  });
  it("shows a rejected write instead of leaving it unhandled", async () => {
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <LanguageServerSettings value={value} onChange={async () => { throw new Error("rejected"); }} />, root));
    root.querySelector<HTMLButtonElement>('[aria-label="Enable html language server"], [aria-label="Enable HTML language server"]')!.click();
    await settle();
    expect(root.querySelector("[role=alert]")!.textContent).toBe("rejected");
  });
});
