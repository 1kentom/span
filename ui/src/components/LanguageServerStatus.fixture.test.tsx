// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { LanguageServerStatus } from "./LanguageServerStatus";
import { makeServer, viewOf } from "../stores/language-intelligence.testkit";
import { SETTLE_MS } from "../lib/language-status";
import type { HubView } from "../stores/language-intelligence";

// Fixture tests: the merged status bar item. It replaces the old status text and the separate language label.
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); vi.useRealTimers(); });
function mount(server: Parameters<typeof viewOf>[0], language: string | undefined, open = false, over: Parameters<typeof viewOf>[1] = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const onToggle = vi.fn();
  disposers.push(render(() => <LanguageServerStatus view={viewOf(server, over)} language={language} open={open} onToggle={onToggle} />, root));
  return { root, onToggle, button: root.querySelector<HTMLButtonElement>(".lsp-status-button")! };
}
const rust = (state: any, entry: any = {}) => makeServer("rust-analyzer", state, { state: { kind: "ready" }, version: "2026-10-12", ...entry });

describe("fixture: merged language status item", () => {
  it("is one icon button: the language logo, no name, and a state dot", () => {
    const m = mount(rust({ kind: "ready", server: "rust-analyzer" }), "rust");
    expect(m.root.querySelectorAll("button")).toHaveLength(1);
    expect(m.button.querySelector(".language-icon")!.getAttribute("data-language")).toBe("rust");
    expect(m.button.textContent).toBe("");
    expect(m.root.querySelector(".lsp-status")!.getAttribute("data-state")).toBe("ready");
    expect(m.button.querySelector(".lsp-status-dot")).not.toBeNull();
  });
  it("labels and tooltips with name, server, version and state, never with a title attribute", () => {
    const m = mount(rust({ kind: "ready", server: "rust-analyzer" }), "rust");
    expect(m.button.getAttribute("aria-label")).toBe("Rust, rust-analyzer 2026-10-12, ready. Show language support");
    expect(m.button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(m.button.hasAttribute("title")).toBe(false);
    m.button.dispatchEvent(new PointerEvent("pointerenter"));
    expect(m.root.querySelector("[role=tooltip]")!.textContent).toBe("Rust, rust-analyzer 2026-10-12, ready");
    m.button.dispatchEvent(new PointerEvent("pointerleave"));
    expect(m.root.querySelector("[role=tooltip]")).toBeNull();
  });
  it("maps each server state to its dot", () => {
    const cases: [any, any, string][] = [
      [{ kind: "start-failed", server: "rust-analyzer", reason: "x" }, { state: { kind: "startFailed", reason: "x" } }, "error"],
      [{ kind: "disabled", server: "rust-analyzer" }, { state: { kind: "disabled" }, enabled: false }, "off"],
      [{ kind: "ready", server: "rust-analyzer" }, { hub: { trust: { workspaceTrusted: false, needsTrust: true } } }, "needs-trust"],
      [{ kind: "starting", server: "rust-analyzer" }, { state: { kind: "starting" } }, "starting"],
    ];
    for (const [state, entry, expected] of cases) {
      const m = mount(rust(state, entry), "rust");
      expect(m.root.querySelector(".lsp-status")!.getAttribute("data-state"), expected).toBe(expected);
    }
  });
  it("shows the file's language without a dot when there is no server, and nothing without a file", () => {
    const m = mount(undefined, "markdown");
    expect(m.button.querySelector(".language-icon")!.getAttribute("data-language")).toBe("markdown");
    expect(m.button.querySelector(".lsp-status-dot")).toBeNull();
    expect(m.button.getAttribute("aria-label")).toBe("Markdown, no language support. Show language support");
    expect(mount(undefined, undefined).root.querySelector(".lsp-status")).toBeNull();
  });
  it("opens the panel and reports being open", () => {
    const m = mount(rust({ kind: "ready", server: "rust-analyzer" }), "rust", true);
    expect(m.button.getAttribute("aria-expanded")).toBe("true");
    expect(m.button.getAttribute("aria-controls")).toBe("language-intelligence-panel");
    m.button.click();
    expect(m.onToggle).toHaveBeenCalledWith(m.button);
  });
  it("does not flicker on a short indexing burst, but shows a longer one and every return to ready at once", () => {
    vi.useFakeTimers();
    const readyView = viewOf(rust({ kind: "ready", server: "rust-analyzer" }));
    const busyView = viewOf(rust({ kind: "ready", server: "rust-analyzer" }), {});
    const busy: HubView = { ...busyView, statusBar: { ...busyView.statusBar, state: "starting", pill: "Indexing" } };
    const [view, setView] = createSignal<HubView>(readyView);
    const root = document.createElement("div"); document.body.append(root);
    disposers.push(render(() => <LanguageServerStatus view={view()} language="rust" open={false} onToggle={() => undefined} />, root));
    const state = () => root.querySelector(".lsp-status")!.getAttribute("data-state");
    setView(busy);
    expect(state()).toBe("ready");
    setView(readyView);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(state()).toBe("ready");
    setView(busy);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(state()).toBe("starting");
    setView(readyView);
    expect(state()).toBe("ready");
  });
});
