// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import type { FileEntry } from "../bindings";
import type { NativeDrop } from "../lib/native-drop";

// Fixture-only: native drops and the desktop transfer commands are fakes.
const native = vi.hoisted(() => ({ handler: undefined as undefined | ((drop: NativeDrop) => void) }));
vi.mock("../lib/native-drop", async original => ({ ...(await original<typeof import("../lib/native-drop")>()), listenNativeDrops: vi.fn(async (handler: (drop: NativeDrop) => void) => { native.handler = handler; return () => { native.handler = undefined; }; }) }));
const notices = vi.hoisted(() => [] as { message: string }[]);
vi.mock("../stores/notifications", () => ({ notify: (input: { message: string }) => { notices.push(input); return 1; } }));

import { createExplorerState } from "../lib/explorer-state";
import { explorerDropFolder, importSummary, pastedName, sameEntries, type ExplorerTransfer, type ImportItems } from "../lib/explorer-transfer";
import { Explorer } from "./Explorer";

const dir = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: true } as FileEntry);
const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: false } as FileEntry);
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); notices.length = 0; vi.restoreAllMocks(); });
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(done => setTimeout(done, 0)); };
const report = (created: string[], extra: object = {}) => ({ created, replaced: [], skipped: [], skippedLinks: 0, entries: created.length, bytes: 0, cancelled: false, error: null, ...extra });

function mount(transferOverrides: Partial<ExplorerTransfer> = {}) {
  const tree: Record<string, FileEntry[]> = { "": [dir("src"), file("README.md")], src: [file("src/a.txt")] };
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({ "": tree[""], src: tree.src });
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["", "src"]));
  const trashPath = vi.fn(async () => {}); const duplicatePath = vi.fn(async () => {}); const renamePath = vi.fn(async () => {}); const setError = vi.fn();
  const workbench = { directories, expanded, loadDirectory: async (path: string) => { setDirectories(path, tree[path] ?? []); }, toggleDirectory: async (path: string) => { setExpanded(current => new Set([...current, path])); }, refreshFiles: async () => {}, trashPath, duplicatePath, renamePath, setError, settings: () => ({}), discoveryRevision: () => 0, activePath: () => "", dirty: () => false, workspace: () => ({ name: "ws", root: "/ws" }), workspaceGeneration: () => 0, busy: () => false, requestWorkspace: () => {}, search: async () => {}, searching: () => false, searchResults: () => [], indexStatus: () => null, indexError: () => "", loadingDirectories: () => new Set<string>() };
  const transfer: ExplorerTransfer = {
    pathInfo: vi.fn(async (path: string) => ({ path, name: path.split("/").pop()!, isDir: false, size: 1 })),
    importPaths: vi.fn(async (target: string, items: ImportItems) => report(items.map(item => `${target ? `${target}/` : ""}${item.source.split("/").pop()}`)) as never),
    progress: vi.fn(async () => null), cancel: vi.fn(async () => {}),
    readClipboard: vi.fn(async () => ({ files: [], hasImage: false, hasText: false })),
    writeClipboard: vi.fn(async () => {}), pasteFile: vi.fn(async (path: string) => ({ path })),
    ...transferOverrides,
  };
  const state = createExplorerState(workbench as never, transfer);
  const root = document.createElement("div"); root.className = "explorer-panel"; document.body.append(root);
  disposers.push(render(() => <Explorer workbench={workbench as never} state={state} view="Files" nativeDrops onNavigate={() => {}} onOpenToSide={() => {}} onEditorTarget={() => undefined} onEditorPreview={() => {}} onEditorDrop={() => {}} />, root));
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 300, bottom: 600, width: 300, height: 600 } as DOMRect);
  const row = (path: string) => root.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`)!;
  const pointAt = (element: Element) => { document.elementFromPoint = () => element; };
  return { root, state, transfer, row, pointAt, trashPath, duplicatePath, renamePath, expanded };
}

describe("Explorer native drop target", () => {
  it("highlights the hovered folder, the folder of a file and the root, and clears on leave", async () => {
    const t = mount(); await tick();
    t.pointAt(t.row("src")); native.handler!({ kind: "hover", point: { x: 10, y: 10 } }); await tick();
    expect(t.row("src").classList.contains("droptgt")).toBe(true);
    t.pointAt(t.row("src/a.txt")); native.handler!({ kind: "hover", point: { x: 10, y: 30 } }); await tick();
    expect(t.row("src").classList.contains("droptgt")).toBe(true);
    t.pointAt(t.root.querySelector(".file-tree")!); native.handler!({ kind: "hover", point: { x: 10, y: 500 } }); await tick();
    expect(t.root.querySelector(".file-tree")!.classList.contains("dropall")).toBe(true);
    native.handler!({ kind: "leave" }); await tick();
    expect(t.root.querySelector(".droptgt, .dropall")).toBeNull();
  });
  it("copies dropped items into the folder under the pointer and offers undo", async () => {
    const t = mount(); await tick();
    t.pointAt(t.row("src")); native.handler!({ kind: "drop", point: { x: 10, y: 10 }, paths: ["/elsewhere/new.txt"] }); await tick();
    expect(t.transfer.importPaths).toHaveBeenCalledWith("src", [{ source: "/elsewhere/new.txt", policy: "keepBoth" }]);
    expect(notices[0].message).toBe("Copied new.txt to src/");
    expect(t.state.selection()).toEqual(["src/new.txt"]);
    await t.state.undo();
    expect(t.trashPath).toHaveBeenCalledWith("src/new.txt");
  });
  it("ignores drops outside the Explorer panel", async () => {
    const t = mount(); await tick();
    t.pointAt(t.row("src")); native.handler!({ kind: "drop", point: { x: 900, y: 10 }, paths: ["/elsewhere/new.txt"] }); await tick();
    expect(t.transfer.importPaths).not.toHaveBeenCalled();
  });
  it("asks about a clash and applies the choice to the rest when asked", async () => {
    const t = mount(); await tick();
    const done = t.state.importItems([{ path: "/x/a.txt", name: "a.txt", isDir: false, size: 1 }, { path: "/y/a.txt", name: "a.txt", isDir: false, size: 1 }], "src");
    await tick();
    const dialog = t.state.dialog();
    expect(dialog).toMatchObject({ kind: "import-conflict", name: "a.txt", remaining: 1 });
    (dialog as { resolve: (choice: unknown) => void }).resolve({ policy: "skip", all: true });
    await done;
    expect(t.transfer.importPaths).toHaveBeenCalledWith("src", [{ source: "/x/a.txt", policy: "skip" }, { source: "/y/a.txt", policy: "skip" }]);
  });
  it("cancelling the clash dialog copies nothing", async () => {
    const t = mount(); await tick();
    const done = t.state.importItems([{ path: "/x/a.txt", name: "a.txt", isDir: false, size: 1 }], "src"); await tick();
    (t.state.dialog() as { resolve: (choice: unknown) => void }).resolve(undefined);
    expect(await done).toBe(false);
    expect(t.transfer.importPaths).not.toHaveBeenCalled();
  });
});

describe("Explorer OS clipboard", () => {
  it("puts copied rows on the OS clipboard and moves Span's own cut on paste", async () => {
    const t = mount({ readClipboard: vi.fn(async () => ({ files: [{ path: "/ws/README.md", name: "README.md", isDir: false, size: 1 }], hasImage: false, hasText: false })) }); await tick();
    t.state.selectOnly("README.md"); t.state.setClip(true); await tick();
    expect(t.transfer.writeClipboard).toHaveBeenCalledWith(["README.md"]);
    await t.state.paste("src");
    expect(t.renamePath).toHaveBeenCalledWith("README.md", "src/README.md");
    expect(t.transfer.importPaths).not.toHaveBeenCalled();
  });
  it("imports files copied in Finder into the selected folder", async () => {
    const t = mount({ readClipboard: vi.fn(async () => ({ files: [{ path: "/Finder/b.txt", name: "b.txt", isDir: false, size: 1 }], hasImage: false, hasText: false })) }); await tick();
    await t.state.paste("src");
    expect(t.transfer.importPaths).toHaveBeenCalledWith("src", [{ source: "/Finder/b.txt", policy: "keepBoth" }]);
  });
  it("pastes a clipboard image as a new file after asking for its name", async () => {
    const t = mount({ readClipboard: vi.fn(async () => ({ files: [], hasImage: true, hasText: true })) }); await tick();
    const done = t.state.paste("src"); await tick();
    expect(t.state.dialog()).toMatchObject({ kind: "paste-name", pasted: "image", value: "Pasted image.png" });
    (t.state.dialog() as { resolve: (name: string) => void }).resolve("shot.png");
    await done;
    expect(t.transfer.pasteFile).toHaveBeenCalledWith("src/shot.png", "image");
  });
});

describe("transfer helpers", () => {
  it("summarises reports and picks free pasted names", () => {
    expect(importSummary(report(["src/a", "src/b", "src/c"]) as never, "src")).toBe("Copied 3 items to src/");
    expect(importSummary(report(["a.txt"], { replaced: ["a.txt"], skipped: ["b"], skippedLinks: 2 }) as never, "")).toBe("Copied a.txt to the project root, 1 replaced (the old item is in the Trash), 1 skipped, 2 links not copied");
    expect(pastedName("text", name => name === "Pasted text.txt")).toBe("Pasted text copy.txt");
    expect(sameEntries([{ path: "/ws/a.txt", name: "a.txt", isDir: false, size: 1 }], "/ws", ["a.txt"])).toBe(true);
    expect(sameEntries([{ path: "/other/a.txt", name: "a.txt", isDir: false, size: 1 }], "/ws", ["a.txt"])).toBe(false);
  });
  it("finds no drop folder when the Explorer shows no tree", () => {
    const panel = document.createElement("div"); panel.className = "explorer-panel"; document.body.append(panel);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect);
    expect(explorerDropFolder({ x: 5, y: 5 }, () => false)).toBeUndefined();
  });
});
