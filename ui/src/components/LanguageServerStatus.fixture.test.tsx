// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { LanguageServerStatus, type LanguageServerStatusProps } from "./LanguageServerStatus";

// Fixture tests: static states are passed in, no store or server is running.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
function mount(state: LanguageServerStatusProps["state"], autoInstall = true) {
  const root = document.createElement("div"); document.body.append(root);
  const fns = { onInstall: vi.fn(), onRestart: vi.fn(), onRetry: vi.fn(), onOpenSettings: vi.fn() };
  disposers.push(render(() => <LanguageServerStatus state={state} autoInstall={autoInstall} {...fns} />, root));
  return { root, ...fns };
}
const open = (root: HTMLElement) => { root.querySelector<HTMLButtonElement>(".lsp-status-button")!.click(); return root.querySelector(".lsp-popover")!; };

describe("fixture: language server status", () => {
  it("renders nothing for unsupported files", () => expect(mount({ kind: "unsupported" }).root.querySelector(".lsp-status")).toBeNull());
  it("labels the button and offers install with a size hint", () => {
    const m = mount({ kind: "needs-install", server: "vtsls", version: "0.3", sizeHint: 12 * 1024 * 1024 }, false);
    const button = m.root.querySelector(".lsp-status-button")!;
    expect(button.getAttribute("aria-label")).toBe("Language server. vtsls: Not installed");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const pop = open(m.root);
    const install = [...pop.querySelectorAll("button")].find(b => b.textContent!.startsWith("Install vtsls"))!;
    expect(install.textContent).toBe("Install vtsls (about 12 MB)");
    expect(pop.textContent).toContain("Automatic install is off");
    install.click();
    expect(m.onInstall).toHaveBeenCalledWith("vtsls");
  });
  it("retries retryable install failures and restarts crashes", () => {
    const a = mount({ kind: "install-failed", server: "html", reason: "net", retryable: true });
    [...open(a.root).querySelectorAll("button")].find(b => b.textContent === "Retry install")!.click();
    expect(a.onRetry).toHaveBeenCalledWith("html");
    const b = mount({ kind: "crashed", server: "css" });
    [...open(b.root).querySelectorAll("button")].find(x => x.textContent!.startsWith("Restart"))!.click();
    expect(b.onRestart).toHaveBeenCalledWith("css");
  });
  it("explains a missing runtime and links to settings", () => {
    const m = mount({ kind: "runtime-missing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["17"] });
    const pop = open(m.root);
    expect(pop.textContent).toContain("JDT LS needs JDK 25 or newer, found: 17");
    [...pop.querySelectorAll("button")].find(b => b.textContent!.startsWith("Open language server settings"))!.click();
    expect(m.onOpenSettings).toHaveBeenCalled();
  });
  it("shows install progress and closes on Escape", () => {
    const m = mount({ kind: "installing", server: "vtsls", received: 1, total: 4 });
    const pop = open(m.root);
    expect(pop.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("25");
    m.root.querySelector(".lsp-status")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(m.root.querySelector(".lsp-popover")).toBeNull();
  });
});
