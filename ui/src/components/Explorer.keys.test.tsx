// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import { createExplorerState } from "../lib/explorer-state";
import { explorerSystemItems } from "../lib/explorer-menu";
import { Explorer } from "./Explorer";
import type { FileEntry } from "../bindings";

// Fixture-only tests: an in-memory workbench fake, as in Explorer.test.tsx.
const dir = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: true } as FileEntry);
const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: false } as FileEntry);
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setTimeout(done, 0)); };
const tree: Record<string, FileEntry[]> = { "": [dir("src"), file("README.md")], src: [file("src/a.ts")] };

function mount() {
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({ "": tree[""] });
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([""]));
  const toggleDirectory = async (path: string) => {
    if (expanded().has(path)) setExpanded(current => { const next = new Set(current); next.delete(path); return next; });
    else { setDirectories(path, tree[path] ?? []); setExpanded(current => new Set([...current, path])); }
  };
  const workbench = { directories, expanded, loadDirectory: async (path: string) => { setDirectories(path, tree[path] ?? []); }, toggleDirectory, settings: () => ({}), discoveryRevision: () => 0, activePath: () => "", dirty: () => false, workspace: () => ({ name: "ws", root: "/ws" }), workspaceGeneration: () => 0, busy: () => false, requestWorkspace: () => {}, search: async () => {}, searching: () => false, searchResults: () => [], indexStatus: () => null, indexError: () => "", loadingDirectories: () => new Set<string>() };
  const state = createExplorerState(workbench as never);
  const duplicate = vi.fn(async () => {}); const startRename = vi.fn(async () => {});
  Object.assign(state, { duplicate, startRename });
  const navigate = vi.fn();
  const root = document.createElement("div"); document.body.append(root);
  disposers.push(render(() => <Explorer workbench={workbench as never} state={state} view="Files" onNavigate={navigate} onOpenToSide={() => {}} onEditorTarget={() => undefined} onEditorPreview={() => {}} onEditorDrop={() => {}} />, root));
  const row = (path: string) => root.querySelector<HTMLButtonElement>(`[role="treeitem"][data-path="${path}"]`)!;
  const key = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  return { root, state, row, key, duplicate, startRename, navigate, expanded, tree: () => root.querySelector<HTMLElement>(".file-tree")! };
}

describe("Explorer focus and keyboard", () => {
  it("focuses the clicked row so tree shortcuts reach it", async () => {
    const t = mount(); await tick();
    t.row("README.md").click();
    expect(document.activeElement).toBe(t.row("README.md"));
    expect(t.state.selection()).toEqual(["README.md"]);
    expect(t.navigate).toHaveBeenCalledWith("README.md");
  });
  it("focuses the tree on a background click and clears the selection", async () => {
    const t = mount(); await tick();
    t.state.selectOnly("README.md");
    t.tree().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.activeElement).toBe(t.tree());
    expect(t.state.selection()).toEqual([]);
    expect(t.tree().getAttribute("tabindex")).toBe("-1");
  });
  it("duplicates with Ctrl+D, renames with F2 and opens with Enter or Ctrl+Down", async () => {
    const t = mount(); await tick();
    t.row("README.md").click(); t.navigate.mockClear();
    t.key(t.row("README.md"), { key: "d", ctrlKey: true });
    expect(t.duplicate).toHaveBeenCalledWith("README.md");
    t.key(t.row("README.md"), { key: "F2" });
    expect(t.startRename).toHaveBeenCalledWith("README.md");
    t.key(t.row("README.md"), { key: "Enter" });
    t.key(t.row("README.md"), { key: "ArrowDown", ctrlKey: true });
    expect(t.navigate).toHaveBeenCalledTimes(2);
    expect(t.startRename).toHaveBeenCalledTimes(1);
  });
  it("expands and collapses folders with the arrow keys, also from the focused tree", async () => {
    const t = mount(); await tick();
    t.row("src").click(); await tick();
    expect(t.expanded().has("src")).toBe(true);
    t.key(t.row("src"), { key: "ArrowLeft" }); await tick();
    expect(t.expanded().has("src")).toBe(false);
    t.state.setFocus("src");
    t.key(t.tree(), { key: "ArrowRight" }); await tick();
    expect(t.expanded().has("src")).toBe(true);
  });
  it("dims cut rows and clears the cut state with Escape", async () => {
    const t = mount(); await tick();
    t.row("README.md").click();
    t.key(t.row("README.md"), { key: "x", ctrlKey: true }); await tick();
    expect(t.row("README.md").classList.contains("cut")).toBe(true);
    t.key(t.row("README.md"), { key: "Escape" }); await tick();
    expect(t.row("README.md").classList.contains("cut")).toBe(false);
    expect(t.state.clipboard()).toBeUndefined();
  });
});

describe("Explorer system menu items", () => {
  const base = { many: false, desktop: true, revealFolders: false, revealLabel: "Reveal in Finder", terminalReady: true };
  it("reveals files and opens a terminal in the folder of a file", () => {
    const onReveal = vi.fn(); const onTerminal = vi.fn();
    const items = explorerSystemItems({ ...base, path: "src/a.ts", directory: false, onReveal, onTerminal });
    expect(items.map(item => [item.id, item.label, item.icon, !!item.disabled])).toEqual([["reveal-system", "Reveal in Finder", "menu-openFolder", false], ["open-terminal", "Open in Terminal", "u-terminal", false]]);
    items[0].onSelect!(); items[1].onSelect!();
    expect(onReveal).toHaveBeenCalledWith("src/a.ts");
    expect(onTerminal).toHaveBeenCalledWith("src");
  });
  it("opens a terminal in a folder itself and explains disabled items", () => {
    const onTerminal = vi.fn();
    const folder = explorerSystemItems({ ...base, path: "src", directory: true, onReveal: () => {}, onTerminal });
    folder[1].onSelect!(); expect(onTerminal).toHaveBeenCalledWith("src");
    expect(folder[0]).toMatchObject({ disabled: true, disabledReason: "Select a file" });
    const browser = explorerSystemItems({ ...base, desktop: false, path: "src/a.ts", directory: false, onReveal: () => {}, onTerminal });
    expect(browser.every(item => item.disabled && item.disabledReason === "Requires the desktop app")).toBe(true);
    const many = explorerSystemItems({ ...base, many: true, path: "src/a.ts", directory: false, onReveal: () => {}, onTerminal });
    expect(many.every(item => item.disabledReason === "Select a single item")).toBe(true);
  });
});
