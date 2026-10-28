// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ToolsSettings, type ToolsSettingsProps } from "./ToolsSettings";
import { BrandIcon } from "./BrandIcon";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
function mount(overrides: Partial<ToolsSettingsProps> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const onRefresh = vi.fn(async () => {});
  disposers.push(render(() => <ToolsSettings desktop tools={[
    { id: "codex", name: "Codex", program: "codex", path: "/test/bin/codex", version: "1.2.3", available: true, kind: "Agent CLI" },
    { id: "gemini", name: "Gemini CLI", program: "gemini", path: null, version: null, available: false, kind: "Agent CLI" },
  ]} loaded onRefresh={onRefresh} {...overrides} />, root));
  return { root, onRefresh };
}
describe("tools settings", () => {
  it("does no discovery on mount and refreshes explicitly", () => {
    const { root, onRefresh } = mount();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(root.textContent).toContain("1 available tool");
    expect(root.textContent).not.toContain("Gemini CLI");
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it("shows unavailable tools only when requested without an installed badge", () => {
    const { root } = mount();
    const checkbox = root.querySelector<HTMLInputElement>('[type="checkbox"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.textContent).toContain("Gemini CLI");
    expect(root.textContent).toContain("Unavailable");
    expect(root.textContent).not.toContain("Installed");
  });
  it("makes browser limitations clear and never claims device tools", () => {
    const { root, onRefresh } = mount({ desktop: false });
    expect(root.textContent).toContain("browser preview cannot read installed programs");
    expect(root.querySelector(".tools-list")).toBeNull();
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it("falls back to a neutral supplied icon if a brand asset fails", () => {
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <BrandIcon id="codex" />, root));
    expect(root.querySelector("img")?.getAttribute("src")).toContain("codex-light.svg");
    root.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".icon")?.getAttribute("style")).toContain("collaborators.svg");
  });
});
