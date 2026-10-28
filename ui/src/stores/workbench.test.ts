import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputed, createRoot } from "solid-js";
import { ChangeSet } from "@codemirror/state";
import type { BufferSnapshot, TextEdit, SessionState_Serialize as SessionState, Settings_Serialize as Settings } from "../bindings";

const client = vi.hoisted(() => ({
  openWorkspace: vi.fn(), listDirectory: vi.fn(), listFiles: vi.fn(), getSettings: vi.fn(),
  openBuffer: vi.fn(), editBuffer: vi.fn(), saveBuffer: vi.fn(), discardBuffer: vi.fn(), getSettingsForScope: vi.fn(), getSettingsJsoncForScope: vi.fn(), getSettingsKeysForScope: vi.fn(), updateSettingsJsoncForScope: vi.fn(), updateSetting: vi.fn(), openSettingsBuffer: vi.fn(), editSettingsBuffer: vi.fn(), saveSettingsBuffer: vi.fn(), discardSettingsBuffer: vi.fn(), newFile: vi.fn(), newDirectory: vi.fn(), renamePath: vi.fn(), duplicatePath: vi.fn(), trashPath: vi.fn(), takeStartupRequests: vi.fn(), getSettingsJsonc: vi.fn(), getSession: vi.fn(), saveSession: vi.fn(), updateSettings: vi.fn(), updateSettingsJsonc: vi.fn(), formatBuffer: vi.fn(),
}));
vi.mock("../lib/client", () => ({ api: client, isDesktop: true }));
import { createWorkbench, settleIntent, SETTINGS_TAB } from "./workbench";

const initial = (): BufferSnapshot => ({ path: "src/file.ts", text: "const value = 1;\n", revision: 0, savedRevision: 0, language: "typescript" });
let server: Map<string, BufferSnapshot>;
const preferences: Settings = { theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false, uiFontSize: 13, uiFontFamily: "Inter", editorFontFamily: "JetBrains Mono", collapsePanelsOnDrag: true, markdownPreviewDefault: true, formatOnSave: false, autoSave: "off", autoSaveDelay: 1000, tabLimitEnabled: true, tabLimit: 10, tabLimitPerGroup: false, zoomLevel: null, keybindings: {}, formatters: {} };
const roots: (() => void)[] = [];
function testWorkbench() { return createRoot(dispose => { roots.push(dispose); return createWorkbench(); }); }
afterEach(() => { for (const dispose of roots.splice(0)) dispose(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const workbench = testWorkbench();
  await workbench.openWorkspace("/workspace");
  await workbench.openFile("src/file.ts");
  return workbench;
}
function append(workbench: ReturnType<typeof createWorkbench>, text: string) {
  const path = "src/file.ts";
  const previousDocument = workbench.documents()[path].document;
  const changes = [{ from: previousDocument.length, to: previousDocument.length, insert: text }];
  const changeSet = ChangeSet.of(changes, previousDocument.length);
  workbench.edit(path, { baseRevision: workbench.buffers[path].revision, previousDocument, document: changeSet.apply(previousDocument), changes, changeSet });
}
beforeEach(() => {
  vi.resetAllMocks();
  server = new Map([["src/file.ts", initial()]]);
  client.openWorkspace.mockImplementation(async (root: string) => ({ root, name: "workspace" }));
  client.listDirectory.mockResolvedValue([]);
  client.listFiles.mockResolvedValue([]);
  client.getSettings.mockResolvedValue(preferences);
  client.getSettingsForScope.mockResolvedValue(preferences);
  client.getSettingsJsoncForScope.mockResolvedValue('// retained comments\n{ "theme": "Dark" }\n');
  client.getSettingsKeysForScope.mockResolvedValue(["theme"]);
  client.updateSettingsJsoncForScope.mockImplementation(async (_scope, text: string) => { client.getSettingsJsoncForScope.mockResolvedValue(text); return preferences; });
  client.updateSetting.mockResolvedValue(preferences);
  client.getSettingsJsonc.mockResolvedValue('// retained comments\n{ "theme": "Dark" }\n');
  client.getSession.mockResolvedValue(null);
  client.takeStartupRequests.mockResolvedValue([]);
  client.saveSession.mockResolvedValue(undefined);
  client.updateSettings.mockImplementation(async (settings: Settings) => settings);
  client.updateSettingsJsonc.mockResolvedValue(preferences);
  client.openBuffer.mockImplementation(async (path: string) => ({ ...server.get(path)! }));
  client.editBuffer.mockImplementation(async (path: string, revision: number, changes: TextEdit[]) => {
    const buffer = server.get(path)!;
    if (buffer.revision !== revision) throw new Error("Stale buffer revision");
    let text = buffer.text;
    for (const change of [...changes].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    const next = { ...buffer, text, revision: revision + 1 };
    server.set(path, next);
    return { path, revision: next.revision, savedRevision: next.savedRevision };
  });
  client.saveBuffer.mockImplementation(async (path: string, revision: number) => {
    const next = { ...server.get(path)!, savedRevision: revision };
    server.set(path, next); return next;
  });
});

describe("authoritative buffer synchronization", () => {
  it("reactively clears the dirty indicator after a queued edit is saved", async () => {
    const workbench = await setup();
    const dirtyStates: boolean[] = [];
    const synchronizedStates: boolean[] = [];
    createRoot(dispose => { roots.push(dispose); createComputed(() => { dirtyStates.push(workbench.dirty("src/file.ts")); synchronizedStates.push(workbench.synchronized("src/file.ts")); }); });
    append(workbench, "// save clears the indicator\n");
    expect(dirtyStates.at(-1)).toBe(true);
    expect(synchronizedStates.at(-1)).toBe(false);
    await workbench.save("src/file.ts");
    expect(dirtyStates.at(-1)).toBe(false);
    expect(synchronizedStates.at(-1)).toBe(true);
  });
  it("accepts a reviewed proposal on an already dirty file", async () => {
    const workbench = await setup();
    append(workbench, "// human\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    expect(workbench.dirty("src/file.ts")).toBe(true);
    const proposal = { ...server.get("src/file.ts")!, text: "const value = 2;\n// human\n", revision: 2 };
    server.set(proposal.path, proposal);
    await workbench.acceptAgentBuffer(proposal.path, proposal);
    expect(workbench.documents()[proposal.path].document.toString()).toBe(proposal.text);
    expect(workbench.buffers[proposal.path].revision).toBe(2);
    expect(workbench.dirty(proposal.path)).toBe(true);
    expect(workbench.pendingRecovery()).toBeUndefined();
  });

  it("opens a newly proposed file so its accepted contents can be saved", async () => {
    const workbench = await setup();
    const proposal: BufferSnapshot = { path: "src/new.ts", text: "export const created = true;\n", revision: 1, savedRevision: 0, language: "typescript" };
    server.set(proposal.path, proposal);
    await workbench.acceptAgentBuffer(proposal.path, proposal);
    expect(workbench.activePath()).toBe(proposal.path);
    expect(workbench.groups()[0].tabs).toContain(proposal.path);
    expect(workbench.documents()[proposal.path].document.toString()).toBe(proposal.text);
    expect(await workbench.save(proposal.path)).toBe(true);
    expect(client.saveBuffer).toHaveBeenCalledWith(proposal.path, 1);
    expect(workbench.dirty(proposal.path)).toBe(false);
  });

  it("preserves a local draft when an agent edit makes its queued revision stale", async () => {
    const workbench = await setup();
    const proposal = { ...initial(), text: "const value = 2;\n", revision: 1 };
    server.set(proposal.path, proposal);
    append(workbench, "// retained draft\n");
    await vi.waitFor(() => expect(workbench.failed().has(proposal.path)).toBe(true));
    await workbench.acceptAgentBuffer(proposal.path, proposal);
    expect(workbench.documents()[proposal.path].document.toString()).toBe(proposal.text);
    expect(workbench.pendingRecovery()?.document.toString()).toContain("retained draft");
    workbench.resolveRecovery(true);
    await vi.waitFor(() => expect(workbench.buffers[proposal.path].revision).toBe(2));
    expect(workbench.documents()[proposal.path].document.toString()).toContain("retained draft");
    expect(server.get(proposal.path)?.text).toContain("retained draft");
  });

  it("ignores an older snapshot that resolves after a newer local edit was acknowledged", async () => {
    const workbench = await setup();
    const older = { ...initial(), text: "const value = 2;\n", revision: 1 };
    server.set(older.path, older);
    await workbench.acceptAgentBuffer(older.path, older);
    const read = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementationOnce(() => read.promise);
    const acceptance = workbench.acceptAgentBuffer(older.path, older);
    await Promise.resolve();
    append(workbench, "// newer local edit\n");
    await vi.waitFor(() => expect(workbench.buffers[older.path].revision).toBe(2));
    read.resolve(older);
    await acceptance;
    expect(workbench.buffers[older.path].revision).toBe(2);
    expect(workbench.documents()[older.path].document.toString()).toContain("newer local edit");
  });

  it("keeps accepted revisions monotonic when a save response arrives after another edit", async () => {
    const workbench = await setup();
    append(workbench, "// first\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const saved = { ...server.get("src/file.ts")!, savedRevision: 1 };
    const response = deferred<BufferSnapshot>();
    client.saveBuffer.mockImplementationOnce(() => response.promise);
    const saving = workbench.save("src/file.ts");
    await vi.waitFor(() => expect(client.saveBuffer).toHaveBeenCalled());
    append(workbench, "// second\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(2));
    response.resolve(saved);
    await saving;
    append(workbench, "// third\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(3));
    expect(workbench.buffers["src/file.ts"].savedRevision).toBe(1);
    expect(workbench.failed().size).toBe(0);
    expect(server.get("src/file.ts")?.text).toContain("third");
  });
});


describe("workspace views and session state", () => {
  it("opens one Settings tab without replacing document or shared history", async () => {
    const workbench = await setup();
    append(workbench, "// preserve history\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const document = workbench.documents()["src/file.ts"].document;
    workbench.openSettings(); workbench.openSettings(); workbench.splitEditor();
    expect(workbench.groups().flatMap(group => group.tabs).filter(path => path === SETTINGS_TAB)).toHaveLength(1);
    expect(workbench.documents()["src/file.ts"].document).toBe(document);
    workbench.closeGroup(2);
    await workbench.openFile("src/file.ts"); workbench.applyHistory("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
  });

  it("reopens a closed file from the same persistent document", async () => {
    const workbench = await setup(); const document = workbench.documents()["src/file.ts"].document;
    workbench.closeTab("src/file.ts", 1); expect(workbench.activePath()).toBeUndefined();
    await workbench.reopenClosedTab(); expect(workbench.activePath()).toBe("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document).toBe(document);
    expect(client.openBuffer).toHaveBeenCalledTimes(1);
  });

  it("restores saved file groups, panel sizes and Markdown view overrides", async () => {
    const readme: BufferSnapshot = { path: "README.md", text: "# Project\n", revision: 0, savedRevision: 0, language: "markdown" };
    server.set(readme.path, readme);
    const session: SessionState = { workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }, { paths: ["README.md"], activePath: "README.md" }], activeGroup: 1, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: true, assistantCollapsed: false, terminalCollapsed: true }, markdownViews: { "README.md": "both" } };
    client.getSession.mockResolvedValue(session);
    const workbench = testWorkbench(); await workbench.initialize();
    expect(workbench.groups().map(group => group.tabs)).toEqual([["src/file.ts"], ["README.md"]]);
    expect(workbench.activePath()).toBe("README.md"); expect(workbench.panels()).toEqual(session.panels);
    expect(workbench.markdownView("README.md")).toBe("both");
    workbench.openSettings(); await workbench.persistSession();
    const saved = client.saveSession.mock.lastCall?.[0] as SessionState;
    expect(saved.groups.flatMap(group => group.paths)).not.toContain(SETTINGS_TAB);
    expect(JSON.stringify(saved)).not.toContain("# Project");
  });

  it("keeps the last requested group focused when earlier file reads finish later", async () => {
    const workbench = await setup();
    const first = deferred<BufferSnapshot>(); const second = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementation((path: string) => path === "src/first.ts" ? first.promise : second.promise);
    workbench.splitEditor();
    const openingFirst = workbench.openFile("src/first.ts", 1);
    const openingSecond = workbench.openFile("src/second.ts", 2);
    expect(workbench.activeGroup()).toBe(2);
    second.resolve({ path: "src/second.ts", text: "second\n", revision: 0, savedRevision: 0, language: "typescript" });
    await openingSecond;
    first.resolve({ path: "src/first.ts", text: "first\n", revision: 0, savedRevision: 0, language: "typescript" });
    await openingFirst;
    expect(workbench.activeGroup()).toBe(2);
    expect(workbench.groups().find(group => group.id === 1)?.active).toBe("src/first.ts");
    expect(workbench.groups().find(group => group.id === 2)?.active).toBe("src/second.ts");
  });

  it("keeps the newest tab selection active within a group across slow reads", async () => {
    const workbench = await setup();
    const first = deferred<BufferSnapshot>(); const second = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementation((path: string) => path === "src/first.ts" ? first.promise : second.promise);
    const openingFirst = workbench.openFile("src/first.ts", 1);
    const openingSecond = workbench.openFile("src/second.ts", 1);
    second.resolve({ path: "src/second.ts", text: "second\n", revision: 0, savedRevision: 0, language: "typescript" });
    await openingSecond;
    first.resolve({ path: "src/first.ts", text: "first\n", revision: 0, savedRevision: 0, language: "typescript" });
    await openingFirst;
    expect(workbench.groups()[0].active).toBe("src/second.ts");
    expect(workbench.groups()[0].tabs).toContain("src/first.ts");
  });

  it("does not let an earlier file read replace a later Settings selection", async () => {
    const workbench = await setup();
    const loading = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementation((path: string) => path === "src/late.ts" ? loading.promise : Promise.resolve(server.get(path)!));
    const opening = workbench.openFile("src/late.ts", 1);
    workbench.openSettings();
    expect(workbench.activeTab()).toBe(SETTINGS_TAB);
    loading.resolve({ path: "src/late.ts", text: "late\n", revision: 0, savedRevision: 0, language: "typescript" });
    await opening;
    expect(workbench.activeTab()).toBe(SETTINGS_TAB);
  });

  it("shares one first-load snapshot when a new file opens into both groups", async () => {
    const workbench = await setup();
    const snapshot: BufferSnapshot = { path: "src/shared.ts", text: "shared\n", revision: 0, savedRevision: 0, language: "typescript" };
    const loading = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementation((path: string) => path === snapshot.path ? loading.promise : Promise.resolve(server.get(path)!));
    workbench.splitEditor();
    const first = workbench.openFile(snapshot.path, 1);
    const second = workbench.openFile(snapshot.path, 2);
    expect(client.openBuffer.mock.calls.filter(([path]) => path === snapshot.path)).toHaveLength(1);
    loading.resolve(snapshot); await Promise.all([first, second]);
    expect(workbench.groups().every(group => group.tabs.includes(snapshot.path))).toBe(true);
    expect(workbench.documents()[snapshot.path].document.toString()).toBe(snapshot.text);
    workbench.closeGroup(1);
    expect(workbench.groups()).toHaveLength(1);
    expect(workbench.groups()[0].tabs).toContain(snapshot.path);
    expect(workbench.documents()[snapshot.path].document.toString()).toBe(snapshot.text);
  });

  it("opens an inactive pane's selected tab to its opposite group", async () => {
    const workbench = await setup();
    const side: BufferSnapshot = { path: "src/side.ts", text: "side\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(side.path, side);
    workbench.splitEditor(); await workbench.openFile(side.path, 1);
    workbench.setActiveGroup(2);
    await workbench.openToSide(side.path, 1);
    expect(workbench.groups().find(group => group.id === 1)?.active).toBe(side.path);
    expect(workbench.groups().find(group => group.id === 2)?.active).toBe(side.path);
    expect(workbench.activeGroup()).toBe(2);
  });

  it("splits the selected file into a new group without replacing its source view", async () => {
    const workbench = await setup();
    const sourceDocument = workbench.documents()["src/file.ts"].document;
    await workbench.openToSide("src/file.ts", 1);
    expect(workbench.groups()).toHaveLength(2);
    expect(workbench.groups().every(group => group.tabs.includes("src/file.ts"))).toBe(true);
    expect(workbench.groups()[0].active).toBe("src/file.ts");
    expect(workbench.groups()[1].active).toBe("src/file.ts");
    expect(workbench.activeGroup()).toBe(2);
    expect(workbench.documents()["src/file.ts"].document).toBe(sourceDocument);
  });

  it("uses an empty split as a valid target for opening a file", async () => {
    const workbench = await setup();
    const next: BufferSnapshot = { path: "src/next.ts", text: "next\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(next.path, next);
    workbench.openSettings(); workbench.splitEditor();
    expect(workbench.groups().find(group => group.id === 2)?.tabs).toEqual([]);
    await workbench.openFile(next.path, 2);
    expect(workbench.activeGroup()).toBe(2);
    expect(workbench.groups().find(group => group.id === 2)?.active).toBe(next.path);
  });

  it("opens Markdown in preview by default while preserving a source override", async () => {
    const workbench = await setup(); expect(workbench.markdownView("README.md")).toBe("preview");
    workbench.setMarkdownView("README.md", "source");
    await workbench.updateSettings({ theme: "Purple" });
    expect(workbench.markdownView("README.md")).toBe("source");
  });

  it("retains exact raw JSONC after saving comments and trailing commas", async () => {
    const workbench = await setup(); const text = '// personal note\n{ "theme": "Dark", }\n';
    await workbench.saveSettingsJsonc(text);
    expect(client.updateSettingsJsoncForScope).toHaveBeenCalledWith("workspace", text);
    expect(workbench.settingsJsonc()).toBe(text);
  });

  it("makes manual formatting undoable through shared buffer history", async () => {
    const workbench = await setup();
    client.formatBuffer.mockImplementation(async () => { const result = { ...initial(), text: "const value = 1;\n\n", revision: 1 }; server.set(result.path, result); return result; });
    await workbench.format("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe("const value = 1;\n\n");
    workbench.applyHistory("src/file.ts");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(2));
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
  });
});


describe("native startup and asset boundaries", () => {
  it("honors explicit startup projects before considering the saved session", async () => {
    client.takeStartupRequests.mockResolvedValue([{ workspaceRoot: "/explicit-cli-project", files: [] }]);
    const workbench = testWorkbench();
    await workbench.initialize(async request => { if (request.workspaceRoot) await workbench.openWorkspace(request.workspaceRoot); });
    expect(workbench.workspace()?.root).toBe("/explicit-cli-project");
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("opens binary images without requesting a UTF-8 editor buffer", async () => {
    const workbench = await setup(); const calls = client.openBuffer.mock.calls.length;
    await workbench.openFile("assets/image.png");
    expect(workbench.activePath()).toBe("assets/image.png");
    expect(client.openBuffer.mock.calls.length).toBe(calls);
    expect(workbench.buffers["assets/image.png"]).toBeUndefined();
    expect(workbench.markdownView("assets/image.png")).toBe("preview");
  });

  it("synchronizes formatter changes even when the following disk save fails", async () => {
    const workbench = await setup();
    client.saveBuffer.mockImplementationOnce(async () => { server.set("src/file.ts", { ...initial(), text: "const value = 2;\n", revision: 1 }); throw new Error("Disk write denied"); });
    expect(await workbench.save("src/file.ts")).toBe(false);
    expect(workbench.error()).toContain("Disk write denied");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe("const value = 2;\n");
    expect(workbench.dirty("src/file.ts")).toBe(true);
    workbench.applyHistory("src/file.ts");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(2));
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
  });
});


describe("asynchronous user intents", () => {
  it("does not complete a canceled close after a delayed save succeeds", async () => {
    const saved = deferred<boolean>(); let current: object | undefined = {}; const intent = current; const close = vi.fn();
    const completion = settleIntent(intent, token => current === token, () => saved.promise, close);
    current = undefined; saved.resolve(true);
    expect(await completion).toBe(false); expect(close).not.toHaveBeenCalled();
  });
  it("does not approve a newer project request from an older Save all callback", async () => {
    const saved = deferred<boolean>(); const first = {}; const second = {}; let current = first; const open = vi.fn();
    const completion = settleIntent(first, token => current === token, () => saved.promise, open);
    current = second; saved.resolve(true);
    expect(await completion).toBe(false); expect(open).not.toHaveBeenCalled(); expect(current).toBe(second);
  });
  it("keeps the close intent pending when new edits appear during persistence", async () => {
    const persisted = deferred<boolean>(); let dirty = false; const close = vi.fn();
    const completion = settleIntent(1, () => true, async () => { await persisted.promise; return !dirty; }, close);
    dirty = true; persisted.resolve(true);
    expect(await completion).toBe(false); expect(close).not.toHaveBeenCalled();
  });
});

describe("closing editor groups", () => {
  it("serializes folder opening and retains the previous workspace on cancel or failure", async () => {
    const workbench = await setup(); const original = workbench.documents()["src/file.ts"].document;
    const canceled = deferred<null>(); client.openWorkspace.mockImplementationOnce(() => canceled.promise);
    const opening = workbench.openWorkspace("/next");
    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenLastCalledWith("/next"));
    await workbench.openWorkspace("/concurrent");
    expect(client.openWorkspace).not.toHaveBeenCalledWith("/concurrent"); expect(workbench.busy()).toBe(true);
    canceled.resolve(null); await opening;
    expect(workbench.workspace()?.root).toBe("/workspace"); expect(workbench.documents()["src/file.ts"].document).toBe(original); expect(workbench.busy()).toBe(false);
    client.openWorkspace.mockRejectedValueOnce(new Error("Folder could not open")); await workbench.openWorkspace("/failed");
    expect(workbench.workspace()?.root).toBe("/workspace"); expect(workbench.documents()["src/file.ts"].document).toBe(original); expect(workbench.busy()).toBe(false);
  });
  it("can close an empty second group without replacing the first document", async () => {
    const workbench = await setup(); const original = workbench.documents()["src/file.ts"].document;
    workbench.openSettings(); workbench.splitEditor();
    expect(workbench.groups()).toHaveLength(2);
    workbench.closeGroup(2);
    expect(workbench.groups()).toHaveLength(1);
    expect(workbench.documents()["src/file.ts"].document).toBe(original);
  });
  it("removes a split when its last clean tab closes", async () => {
    const workbench = await setup(); workbench.splitEditor();
    workbench.closeTab("src/file.ts", 2);
    expect(workbench.groups().map(group => group.id)).toEqual([1]);
    expect(workbench.activeGroup()).toBe(1);
  });
  it("closes a duplicate dirty view without discarding shared edits or undo history", async () => {
    const workbench = await setup(); workbench.splitEditor(); append(workbench, "// shared draft\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    workbench.closeGroup(2);
    expect(workbench.pendingClose()).toBeUndefined(); expect(workbench.groups()).toHaveLength(1);
    expect(workbench.documents()["src/file.ts"].document.toString()).toContain("shared draft");
    workbench.applyHistory("src/file.ts"); expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
  });
  it("keeps a group and its unique dirty file when closing is canceled", async () => {
    const workbench = await setup(); workbench.openSettings(); workbench.splitEditor();
    await workbench.openFile("src/file.ts", 2); workbench.closeTab("src/file.ts", 1);
    append(workbench, "// keep unique\n"); await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    workbench.closeGroup(2); expect(workbench.pendingClose()?.path).toBe("src/file.ts");
    await workbench.confirmClose("cancel");
    expect(workbench.groups()).toHaveLength(2); expect(workbench.documents()["src/file.ts"].document.toString()).toContain("keep unique");
  });
  it("does not close a tab after its delayed Save action was canceled", async () => {
    const workbench = await setup(); append(workbench, "// delayed\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const response = deferred<BufferSnapshot>(); client.saveBuffer.mockImplementationOnce(() => response.promise);
    workbench.closeTab("src/file.ts", 1); const saving = workbench.confirmClose("save");
    await vi.waitFor(() => expect(client.saveBuffer).toHaveBeenCalled());
    await workbench.confirmClose("cancel"); response.resolve({ ...server.get("src/file.ts")!, savedRevision: 1 }); await saving;
    expect(workbench.groups()[0].tabs).toContain("src/file.ts");
  });
  it("retains and rebases new edits when an authoritative discard response arrives after Cancel", async () => {
    const workbench = await setup(); append(workbench, "// original draft\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const response = deferred<BufferSnapshot>();
    const discarded = { ...initial(), revision: 2, savedRevision: 2 };
    client.discardBuffer.mockImplementationOnce(async () => { server.set(discarded.path, discarded); return response.promise; });
    workbench.closeTab("src/file.ts", 1); const discarding = workbench.confirmClose("discard");
    await vi.waitFor(() => expect(client.discardBuffer).toHaveBeenCalled());
    await workbench.confirmClose("cancel"); append(workbench, "// new draft after Cancel\n");
    const localDocument = workbench.documents()["src/file.ts"].document;
    await vi.waitFor(() => expect(workbench.failed().has("src/file.ts")).toBe(true));
    response.resolve(discarded); await discarding;
    await vi.waitFor(() => expect(workbench.failed().has("src/file.ts")).toBe(false));
    expect(workbench.documents()["src/file.ts"].document).toBe(localDocument);
    expect(workbench.groups()[0].tabs).toContain("src/file.ts");
    expect(await workbench.save("src/file.ts")).toBe(true);
    expect(server.get("src/file.ts")?.text).toBe(localDocument.toString());
    workbench.applyHistory("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).not.toContain("new draft after Cancel");
    expect(workbench.documents()["src/file.ts"].document.toString()).toContain("original draft");
  });
});


describe("scoped settings and auto save integration", () => {
  it("keeps User scope values separate from Workspace-effective values", async () => {
    client.getSettings.mockResolvedValue({ ...preferences, theme: "Purple" });
    client.getSettingsForScope.mockImplementation(async scope => ({ ...preferences, theme: scope === "user" ? "Light" : "Purple" }));
    const workbench = await setup(); await workbench.refreshSettingsScope("user");
    expect(workbench.scopeSettings().theme).toBe("Light"); expect(workbench.settings().theme).toBe("Purple");
    await workbench.updateSettings({ fontSize: 16 });
    expect(client.updateSetting).toHaveBeenCalledWith("user", "fontSize", "16");
    expect(workbench.settings().theme).toBe("Purple");
    await workbench.resetSetting("fontSize"); expect(client.updateSetting).toHaveBeenLastCalledWith("user", "fontSize", null);
  });
  it("auto saves an open local draft after its configured delay", async () => {
    client.getSettings.mockResolvedValue({ ...preferences, autoSave: "afterDelay", autoSaveDelay: 25 });
    const workbench = await setup(); append(workbench, "// automatic\n");
    await vi.waitFor(() => expect(client.saveBuffer).toHaveBeenCalledWith("src/file.ts", 1));
    expect(workbench.dirty("src/file.ts")).toBe(false); expect(server.get("src/file.ts")?.text).toContain("automatic");
  });
  it("saves focus-change mode only after the editor loses focus", async () => {
    client.getSettings.mockResolvedValue({ ...preferences, autoSave: "onFocusChange" });
    const workbench = await setup(); append(workbench, "// focus save\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    expect(client.saveBuffer).not.toHaveBeenCalled(); workbench.autoSaveEditorBlur("src/file.ts");
    await vi.waitFor(() => expect(client.saveBuffer).toHaveBeenCalled());
  });
  it("uses dedicated settings IPC and excludes settings files from Auto Save", async () => {
    client.getSettings.mockResolvedValue({ ...preferences, autoSave: "afterDelay", autoSaveDelay: 10 });
    const base: BufferSnapshot = { path: "settings://user", text: "{}", revision: 0, savedRevision: 0, language: "jsonc" };
    client.openSettingsBuffer.mockResolvedValue(base);
    client.editSettingsBuffer.mockResolvedValue({ path: base.path, revision: 1, savedRevision: 0 });
    client.saveSettingsBuffer.mockResolvedValue({ ...base, text: '{"fontSize":16}', revision: 1, savedRevision: 1 });
    const workbench = await setup(); await workbench.openSettingsJsonc("user");
    const previousDocument = workbench.documents()[base.path].document; const changes = [{ from: 1, to: 1, insert: '"fontSize":16' }]; const changeSet = ChangeSet.of(changes, previousDocument.length);
    workbench.edit(base.path, { baseRevision: 0, previousDocument, document: changeSet.apply(previousDocument), changes, changeSet });
    await vi.waitFor(() => expect(client.editSettingsBuffer).toHaveBeenCalledWith("user", 0, changes));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(client.saveSettingsBuffer).not.toHaveBeenCalled(); expect(workbench.dirty(base.path)).toBe(true);
    await workbench.save(base.path); expect(client.saveSettingsBuffer).toHaveBeenCalledWith("user", 1);
    expect(client.openBuffer).not.toHaveBeenCalledWith(base.path);
  });
});

describe("file operations reconcile editor state", () => {
  it("opens a newly created file from its authoritative snapshot", async () => {
    const workbench = await setup(); const snapshot: BufferSnapshot = { ...initial(), path: "src/new.ts", text: "" };
    client.newFile.mockResolvedValue(snapshot); await workbench.newFile(snapshot.path);
    expect(workbench.activePath()).toBe(snapshot.path); expect(workbench.documents()[snapshot.path].document.length).toBe(0);
    expect(client.openBuffer).not.toHaveBeenCalledWith(snapshot.path);
  });
  it("renames clean duplicate views without losing shared document or undo history", async () => {
    const workbench = await setup(); append(workbench, "// keep undo\n"); await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1)); await workbench.save(); workbench.splitEditor();
    const document = workbench.documents()["src/file.ts"].document;
    client.renamePath.mockImplementation(async (from: string, to: string) => { const old = server.get(from)!; server.delete(from); server.set(to, { ...old, path: to, revision: old.revision + 1, savedRevision: old.revision + 1 }); return { path: to, name: "renamed.ts", isDir: false }; });
    await workbench.renamePath("src/file.ts", "src/renamed.ts");
    expect(workbench.groups().every(group => group.tabs.includes("src/renamed.ts"))).toBe(true);
    expect(workbench.documents()["src/renamed.ts"].document).toBe(document);
    workbench.applyHistory("src/renamed.ts"); await vi.waitFor(() => expect(workbench.buffers["src/renamed.ts"].revision).toBe(3));
    expect(workbench.documents()["src/renamed.ts"].document.toString()).toBe(initial().text);
  });
  it("preserves a dirty file when the backend refuses its rename", async () => {
    const workbench = await setup(); append(workbench, "// unsaved\n"); await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    client.renamePath.mockRejectedValue(new Error("Save or discard unsaved changes first"));
    await expect(workbench.renamePath("src/file.ts", "src/renamed.ts")).rejects.toThrow("Save or discard");
    expect(workbench.activePath()).toBe("src/file.ts"); expect(workbench.documents()["src/file.ts"].document.toString()).toContain("unsaved");
  });
  it("moves a dirty tab into another group without prompting or losing the document", async () => {
    const workbench = await setup(); workbench.openSettings(); workbench.splitEditor(); await workbench.openFile("src/file.ts", 1); append(workbench, "// move me\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1)); const document = workbench.documents()["src/file.ts"].document;
    workbench.moveTab("src/file.ts", 1, 2);
    expect(workbench.pendingClose()).toBeUndefined(); expect(workbench.groups().find(group => group.id === 2)?.tabs).toContain("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document).toBe(document);
  });
});
