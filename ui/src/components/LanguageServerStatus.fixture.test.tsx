// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageServerStatus } from "./LanguageServerStatus";
import { makeServer, viewOf } from "../stores/language-intelligence.testkit";

// Fixture tests: the status bar item is a short summary that opens the hub panel. The panel itself is
// covered by LanguageIntelligencePanel.fixture.test.tsx and the button by LanguageIntelligenceButton.fixture.test.tsx.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
function mount(server: Parameters<typeof viewOf>[0], open = false, over: Parameters<typeof viewOf>[1] = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const onToggle = vi.fn();
  disposers.push(render(() => <LanguageServerStatus view={viewOf(server, over)} open={open} onToggle={onToggle} />, root));
  return { root, onToggle };
}

describe("fixture: language server status item", () => {
  it("renders nothing for files without a language server", () => expect(mount(undefined).root.querySelector(".lsp-status")).toBeNull());
  it("is a short summary with a label from the shared view and no title attribute", () => {
    const m = mount(makeServer("vtsls", { kind: "needs-install", server: "vtsls", version: "0.3" }, { state: { kind: "needsInstall", version: "0.3" }, installed: false }));
    const button = m.root.querySelector(".lsp-status-button")!;
    expect(button.textContent).toBe("TypeScript: not installed");
    expect(button.getAttribute("aria-label")).toBe("Language intelligence. TypeScript and JavaScript support is not installed.");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.hasAttribute("title")).toBe(false);
    expect(m.root.querySelector(".lsp-status")!.getAttribute("data-tone")).toBe("warn");
  });
  it("opens the panel when clicked and reports being open", () => {
    const m = mount(makeServer("html", { kind: "ready", server: "html" }, { state: { kind: "ready" } }), true);
    const button = m.root.querySelector<HTMLButtonElement>(".lsp-status-button")!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();
    expect(m.onToggle).toHaveBeenCalledWith(button);
  });
  it("shows a failed status read as unavailable instead of checking forever", () => {
    const m = mount(makeServer("vtsls", { kind: "unknown", server: "vtsls" }), false, { statusError: "Could not read language server status: boom" });
    expect(m.root.querySelector(".lsp-status")!.getAttribute("data-tone")).toBe("bad");
    expect(m.root.querySelector(".lsp-status-button")!.textContent).toContain("status unavailable");
  });
});
