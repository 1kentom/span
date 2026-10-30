// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import type { FileEntry } from "../bindings";

// Fixture-only: the desktop archive commands are fakes.
const notices = vi.hoisted(() => [] as { message: string; actions?: { label: string }[] }[]);
vi.mock("../stores/notifications", () => ({ notify: (input: { message: string }) => { notices.push(input); return 1; } }));

import { createExplorerState } from "../lib/explorer-state";
import { archiveSummary, type ExplorerTransfer } from "../lib/explorer-transfer";
import type { ArchiveCommands, ArchiveReport } from "../lib/archive-desktop";
import { Explorer } from "./Explorer";

const dir = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: true } as FileEntry);
const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: false } as FileEntry);
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); notices.length = 0; vi.restoreAllMocks(); });
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(done => setTimeout(done, 0)); };
const report = (extra: Partial<ArchiveReport> = {}): ArchiveReport => ({ created: "src/site", replaced: null, skippedExisting: false, skipped: [], entries: 3, bytes: 30, cancelled: false, error: null, ...extra });

function mount(archive: Partial<ArchiveCommands> = {}) {
  const tree: Record<string, FileEntry[]> = { "": [dir("src")], src: [file("src/site.zip")] };
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({ "": tree[""], src: tree.src });
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(["", "src"]));
  const trashPath = vi.fn(async () => {}); const setError = vi.fn();
  const workbench = { directories, expanded, loadDirectory: async (path: string) => { setDirectories(path, tree[path] ?? []); }, toggleDirectory: async (path: string) => { setExpanded(current => new Set([...current, path])); }, refreshFiles: vi.fn(async () => {}), trashPath, duplicatePath: vi.fn(), renamePath: vi.fn(), setError, settings: () => ({}), discoveryRevision: () => 0, activePath: () => "", dirty: () => false, workspace: () => ({ name: "ws", root: "/ws" }), workspaceGeneration: () => 0, busy: () => false, requestWorkspace: () => {}, search: async () => {}, searching: () => false, searchResults: () => [], indexStatus: () => null, indexError: () => "", loadingDirectories: () => new Set<string>() };
  let progress: ((value: { entries: number; totalEntries: number; bytes: number; totalBytes: number; current: string }) => void) | undefined;
  let finish: ((value: ArchiveReport) => void) | undefined;
  const commands: ArchiveCommands = {
    list: vi.fn(), read: vi.fn(),
    plan: vi.fn(async () => ({ destination: "src/site", files: 3, bytes: 30, conflicts: [], skipped: [] })),
    extract: vi.fn((_job, _source, _request, onProgress) => { progress = onProgress; return new Promise<ArchiveReport>(resolve => { finish = resolve; }); }),
    cancel: vi.fn(async () => { finish?.(report({ created: null, cancelled: true, entries: 0 })); }),
    ...archive,
  };
  const transfer = { pathInfo: vi.fn(), importPaths: vi.fn(), progress: vi.fn(async () => null), cancel: vi.fn(async () => {}), readClipboard: vi.fn(), writeClipboard: vi.fn(), pasteFile: vi.fn(), archive: commands } as unknown as ExplorerTransfer;
  const state = createExplorerState(workbench as never, transfer);
  const root = document.createElement("div"); root.className = "explorer-panel"; document.body.append(root);
  disposers.push(render(() => <Explorer workbench={workbench as never} state={state} view="Files" onNavigate={() => {}} onOpenToSide={() => {}} onEditorTarget={() => undefined} onEditorPreview={() => {}} onEditorDrop={() => {}} />, root));
  return { root, state, commands, trashPath, workbench, emit: (value: Parameters<NonNullable<typeof progress>>[0]) => progress?.(value), finish: (value: ArchiveReport) => finish?.(value) };
}

describe("Explorer archive extraction", () => {
  it("extracts next to the archive with progress, selects the new folder and offers undo", async () => {
    const t = mount(); await tick();
    const done = t.state.extractArchive("src/site.zip", "src"); await tick();
    expect(t.commands.plan).toHaveBeenCalledWith({ kind: "workspace", path: "src/site.zip" }, { targetDir: "src", folderName: null, policy: "keepBoth", options: { paths: null, keepStructure: true, skipHidden: false, keepExecutable: false } });
    expect(t.root.querySelector(".tree-import")?.textContent).toContain("Extracting site.zip");
    t.emit({ entries: 1, totalEntries: 3, bytes: 10, totalBytes: 30, current: "a.txt" }); await tick();
    expect(t.root.querySelector<HTMLProgressElement>('progress[aria-label="Extraction progress"]')?.value).toBe(10);
    t.finish(report({ skipped: [{ path: "../x", reason: "parent folder component (..)" }] }));
    expect(await done).toBe(true);
    expect(t.root.querySelector(".tree-import")).toBeNull();
    expect(notices[0].message).toBe("Extracted 3 files from site.zip to src/site/, 1 entry skipped as unsafe");
    expect(notices[0].actions?.map(action => action.label)).toEqual(["Undo"]);
    expect(t.state.selection()).toEqual(["src/site"]);
    await t.state.undo();
    expect(t.trashPath).toHaveBeenCalledWith("src/site");
  });

  it("asks Keep both, Replace or Skip when the folder exists and uses the answer", async () => {
    const t = mount({ plan: vi.fn(async () => ({ destination: "src/site", files: 3, bytes: 30, conflicts: ["site"], skipped: [] })) }); await tick();
    const done = t.state.extractArchive("src/site.zip", "src"); await tick();
    const dialog = t.state.dialog();
    expect(dialog).toMatchObject({ kind: "import-conflict", folder: "src", name: "site", remaining: 0 });
    (dialog as { resolve: (choice: unknown) => void }).resolve({ policy: "replace", all: false }); await tick();
    expect((t.commands.extract as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ policy: "replace" });
    t.finish(report({ replaced: "src/site" })); await done;
    expect(notices[0].message).toContain("the old folder is in the Trash");
    expect(notices[0].actions).toEqual([]);
  });

  it("dismissing the clash dialog extracts nothing", async () => {
    const t = mount({ plan: vi.fn(async () => ({ destination: "src/site", files: 1, bytes: 1, conflicts: ["site"], skipped: [] })) }); await tick();
    const done = t.state.extractArchive("src/site.zip", "src"); await tick();
    (t.state.dialog() as { resolve: (choice: unknown) => void }).resolve(undefined);
    expect(await done).toBe(false);
    expect(t.commands.extract).not.toHaveBeenCalled();
  });

  it("cancel reaches the running job and reports that nothing was extracted", async () => {
    const t = mount(); await tick();
    const done = t.state.extractArchive("src/site.zip", "src"); await tick();
    [...t.root.querySelectorAll<HTMLButtonElement>(".tree-import button")].find(button => button.textContent === "Cancel")!.click(); await tick();
    expect(t.commands.cancel).toHaveBeenCalledWith(expect.stringMatching(/^explorer-/));
    expect(await done).toBe(false);
    expect(notices[0].message).toBe("Extraction of site.zip cancelled. Nothing was extracted.");
  });

  it("reports a refused archive as an error and writes nothing", async () => {
    const t = mount({ plan: vi.fn(async () => { throw new Error("This archive is damaged or incomplete"); }) }); await tick();
    expect(await t.state.extractArchive("src/site.zip", "src")).toBe(false);
    expect(t.commands.extract).not.toHaveBeenCalled();
  });

  it("summarises skip and empty outcomes", () => {
    expect(archiveSummary(report({ created: null, skippedExisting: true }), "a.zip")).toBe("a.zip was not extracted: the folder exists and Skip was chosen.");
    expect(archiveSummary(report({ created: "a", entries: 1 }), "a.zip")).toBe("Extracted 1 file from a.zip to a/");
  });
});
