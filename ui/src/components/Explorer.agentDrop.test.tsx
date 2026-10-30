// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import { createExplorerState } from "../lib/explorer-state";
import { Explorer } from "./Explorer";
import type { FileEntry, Settings_Serialize as Settings } from "../bindings";

// Fixture: Explorer rows use pointer gestures (no HTML drag), so the agent panel is a pointer drop target.
const dir = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: true } as FileEntry);
const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: false } as FileEntry);
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return event;
}
function mount() {
  const [directories] = createStore<Record<string, FileEntry[]>>({ "": [dir("src"), file("README.md")] });
  const [expanded] = createSignal<Set<string>>(new Set([""]));
  const [generation] = createSignal(0);
  const settings = () => ({ explorer: { showHiddenFiles: true, showIgnoredFiles: false, compactFolders: true, autoReveal: true, confirmDelete: true } } as unknown as Settings);
  const workbench = { directories, expanded, settings, discoveryRevision: () => 0, loadDirectory: async () => {}, toggleDirectory: async () => {}, activePath: () => "", dirty: () => false, workspace: () => ({ name: "ws", root: "/ws" }), workspaceGeneration: generation, busy: () => false, requestWorkspace: () => {}, search: async () => {}, searching: () => false, searchResults: () => [], indexStatus: () => null, indexError: () => "", loadingDirectories: () => new Set<string>() };
  const root = document.createElement("div"); document.body.append(root);
  const state = createExplorerState(workbench as never);
  const onAgentDrop = vi.fn(); const onAgentPreview = vi.fn(); const onEditorDrop = vi.fn();
  // The agent panel covers CSS x >= 1000.
  disposers.push(render(() => <Explorer workbench={workbench as never} state={state} view="Files" onNavigate={() => {}} onOpenToSide={() => {}} onEditorTarget={() => undefined} onEditorPreview={() => {}} onEditorDrop={onEditorDrop} onAgentTarget={x => x >= 1000} onAgentPreview={onAgentPreview} onAgentDrop={onAgentDrop} />, root));
  const row = (path: string) => root.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
  for (const element of root.querySelectorAll<HTMLElement>('[role="treeitem"]')) { element.setPointerCapture = vi.fn(); element.hasPointerCapture = vi.fn(() => false); element.releasePointerCapture = vi.fn(); }
  return { root, row, onAgentDrop, onAgentPreview, onEditorDrop };
}
describe("Explorer rows dropped on the agent panel (fixture)", () => {
  it("publishes the hover and attaches files and folders on release", () => {
    const view = mount();
    view.row("README.md").dispatchEvent(pointer("pointerdown", 40, 40));
    window.dispatchEvent(pointer("pointermove", 1100, 200));
    expect(view.onAgentPreview).toHaveBeenLastCalledWith(true);
    expect(view.root.querySelector(".explorer-drag-pill")?.textContent).toContain("attach to AI");
    window.dispatchEvent(pointer("pointerup", 1100, 200));
    expect(view.onAgentDrop).toHaveBeenCalledWith([{ path: "README.md", isDir: false }]);
    expect(view.onAgentPreview).toHaveBeenLastCalledWith(false);
    view.row("src").dispatchEvent(pointer("pointerdown", 40, 20));
    window.dispatchEvent(pointer("pointermove", 1200, 200));
    window.dispatchEvent(pointer("pointerup", 1200, 200));
    expect(view.onAgentDrop).toHaveBeenLastCalledWith([{ path: "src", isDir: true }]);
    expect(view.onEditorDrop).not.toHaveBeenCalled();
  });
});
