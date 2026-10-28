// @vitest-environment jsdom
// Fixture tests for the symbol breadcrumbs and the symbol modes of the Goto dialog.
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SymbolDto_Serialize } from "../../bindings";
import { symbolPathAt } from "../../lib/lsp-navigation";
import { setShowSymbolPath, setSymbolSortOrder } from "../../lib/navigation-prefs";
import type { SymbolItem, SymbolSource } from "../../stores/navigation";
import { Breadcrumbs } from "../Breadcrumbs";
import { Goto } from "../Goto";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); setShowSymbolPath(true); setSymbolSortOrder("position"); });
const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 15)); for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const sym = (name: string, kind: SymbolDto_Serialize["kind"], line: number, children: SymbolDto_Serialize[] = []): SymbolDto_Serialize =>
  ({ name, kind, detail: null, range: { start: { line, character: 0 }, end: { line: line + 3, character: 0 } }, selectionRange: { start: { line, character: 2 }, end: { line, character: 2 + name.length } }, children });
const tree = [sym("Zed", "class", 0, [sym("beta", "method", 1), sym("alpha", "property", 5)])];

function bar(extra: Partial<Parameters<typeof Breadcrumbs>[0]> = {}) {
  const root = document.createElement("div"); document.body.append(root);
  const onSymbol = vi.fn();
  disposers.push(render(() => <Breadcrumbs path="src/a.ts" listDirectory={vi.fn()} onOpen={vi.fn()} symbols={symbolPathAt(tree, { line: 1, character: 3 })} onSymbol={onSymbol} {...extra} />, root));
  return { root, onSymbol };
}

describe("symbol breadcrumbs (fixture)", () => {
  it("appends the symbol path after the file path and lists siblings in source order by default", async () => {
    const { root, onSymbol } = bar();
    const parts = [...root.querySelectorAll<HTMLElement>(".breadcrumb-part")].map(part => part.textContent);
    expect(parts).toEqual(["src", "a.ts", "Zed", "beta"]);
    root.querySelectorAll<HTMLButtonElement>(".breadcrumb-symbol")[1].click(); await settle();
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(item => item.textContent)).toEqual(["beta", "alpha"]);
    (items[1] as HTMLElement).click();
    expect(onSymbol.mock.calls[0][0].name).toBe("alpha");
  });
  it("sorts siblings by name or type and hides the path when the preference is off", async () => {
    setSymbolSortOrder("name");
    const { root } = bar();
    root.querySelectorAll<HTMLButtonElement>(".breadcrumb-symbol")[1].click(); await settle();
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(["alpha", "beta"]);
    document.body.replaceChildren(); disposers.splice(0).forEach(dispose => dispose());
    setShowSymbolPath(false);
    expect(bar().root.querySelectorAll(".breadcrumb-symbol")).toHaveLength(0);
  });
  it("shows no symbol segments without symbols (unsupported file)", () => {
    expect(bar({ symbols: [] }).root.querySelectorAll(".breadcrumb-symbol")).toHaveLength(0);
  });
});

const item = (name: string, kind: SymbolItem["kind"], depth: number, container = "", line = 1): SymbolItem => ({ id: `${name}${line}`, name, kind, container, depth, path: "src/a.ts", line, column: 1 });
function gotoWith(symbols: SymbolSource, initialQuery: string) {
  const root = document.createElement("div"); document.body.append(root);
  const onOpen = vi.fn();
  disposers.push(render(() => <Goto files={[]} symbols={symbols} initialQuery={initialQuery} onOpen={onOpen} onClose={vi.fn()} onOpenFolder={vi.fn()} />, root));
  return { root, onOpen };
}

describe("Goto symbol modes (fixture)", () => {
  const fileSymbols = [item("Zed", "class", 0), item("beta", "method", 1, "Zed", 2), item("alpha", "property", 1, "Zed", 6)];
  const source = (overrides: Partial<SymbolSource> = {}): SymbolSource => ({ fileSymbols: async () => ({ items: fileSymbols }), workspaceSymbols: async () => ({ items: [] }), open: vi.fn(), ...overrides });
  it("lists file symbols hierarchically for @ and filters fuzzily", async () => {
    const { root } = gotoWith(source(), "@"); await settle();
    const rows = () => [...root.querySelectorAll<HTMLElement>('[role="option"] .goto-name')].map(row => row.textContent);
    expect(rows()).toEqual(["Zed", "beta", "alpha"]);
    expect(root.querySelectorAll<HTMLElement>(".goto-symbol-icon")[1].style.marginLeft).toBe("14px");
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.value = "@bt"; input.dispatchEvent(new InputEvent("input", { bubbles: true })); await settle();
    expect(rows()).toEqual(["beta"]);
  });
  it("groups by kind for @: and opens the highlighted symbol with Enter", async () => {
    const symbols = source(); const { root } = gotoWith(symbols, "@:"); await settle();
    expect([...root.querySelectorAll(".goto-section")].map(row => row.textContent)).toContain("properties");
    const input = root.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await settle();
    expect(symbols.open).toHaveBeenCalledOnce();
  });
  it("debounces workspace queries for # and shows the unsupported message", async () => {
    vi.useFakeTimers();
    try {
      const workspaceSymbols = vi.fn(async (query: string) => ({ items: [item(query || "x", "function", 0, "pkg")] }));
      const { root } = gotoWith(source({ workspaceSymbols }), "#");
      const input = root.querySelector<HTMLInputElement>("input")!;
      for (const value of ["#a", "#ab", "#abc"]) { input.value = value; input.dispatchEvent(new InputEvent("input", { bubbles: true })); await vi.advanceTimersByTimeAsync(50); }
      await vi.advanceTimersByTimeAsync(200);
      expect(workspaceSymbols).toHaveBeenCalledWith("abc");
      expect(workspaceSymbols).not.toHaveBeenCalledWith("a"); expect(workspaceSymbols).not.toHaveBeenCalledWith("ab");
    } finally { vi.useRealTimers(); }
    document.body.replaceChildren(); disposers.splice(0).forEach(dispose => dispose());
    const { root } = gotoWith(source({ fileSymbols: async () => ({ items: [], message: "rust-analyzer does not provide document symbols for this file" }) }), "@"); await settle();
    expect(root.querySelector(".goto-empty")?.textContent).toContain("does not provide document symbols");
  });
});
