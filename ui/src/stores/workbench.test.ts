import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputed, createRoot } from "solid-js";
import { ChangeSet } from "@codemirror/state";
import type { BufferSnapshot, FileIndexStatus, TextEdit, SessionState_Serialize as SessionState, Settings_Serialize as Settings } from "../bindings";

const client = vi.hoisted(() => ({
  migrateExplorerPreferences: vi.fn(), openWorkspace: vi.fn(), checkExternalFiles: vi.fn(), resolveExternalFile: vi.fn(), abandonExternalFile: vi.fn(), listDirectory: vi.fn(), listFiles: vi.fn(), fileIndexStatus: vi.fn(), queryFile: vi.fn(), getSettings: vi.fn(),
  openBuffer: vi.fn(), editBuffer: vi.fn(), saveBuffer: vi.fn(), discardBuffer: vi.fn(), getSettingsForScope: vi.fn(), getSettingsJsoncForScope: vi.fn(), getSettingsKeysForScope: vi.fn(), updateSettingsJsoncForScope: vi.fn(), updateSetting: vi.fn(), openSettingsBuffer: vi.fn(), editSettingsBuffer: vi.fn(), saveSettingsBuffer: vi.fn(), discardSettingsBuffer: vi.fn(), newFile: vi.fn(), newDirectory: vi.fn(), renamePath: vi.fn(), duplicatePath: vi.fn(), trashPath: vi.fn(), takeStartupRequests: vi.fn(), getSettingsJsonc: vi.fn(), getSession: vi.fn(), saveSession: vi.fn(), updateSettings: vi.fn(), updateSettingsJsonc: vi.fn(), formatBuffer: vi.fn(), cancelFormatBuffer: vi.fn(), releaseBuffer: vi.fn(), probeFile: vi.fn(),
}));
vi.mock("../lib/client", () => ({ api: client, isDesktop: true }));
import { createWorkbench, settleIntent, SETTINGS_TAB, isGitTab, tabName } from "./workbench";
import { viewerTabPath } from "../lib/viewer-tabs";

const initial = (): BufferSnapshot => ({ path: "src/file.ts", text: "const value = 1;\n", revision: 0, savedRevision: 0, language: "typescript" });
let server: Map<string, BufferSnapshot>;
const preferences: Settings = { theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false, uiFontSize: 13, uiFontFamily: "Inter", editorFontFamily: "JetBrains Mono", collapsePanelsOnDrag: true, markdownPreviewDefault: true, formatOnSave: false, autoSave: "off", autoSaveDelay: 1000, tabLimitEnabled: true, tabLimit: 10, tabLimitPerGroup: false, zoomLevel: null, keybindings: {}, formatters: {}, languageServers: { autoInstall: false, enabled: {}, javaHome: null, nodePath: null, runProjectCode: false, trustedWorkspaces: [] } };
const roots: (() => void)[] = [];
function testWorkbench() { return createRoot(dispose => { roots.push(dispose); return createWorkbench(); }); }
afterEach(() => { for (const dispose of roots.splice(0)) dispose(); vi.unstubAllGlobals(); });
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
  client.fileIndexStatus.mockResolvedValue(null);
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 0, states: [], directoriesChanged: false });
  client.queryFile.mockResolvedValue({ workspaceRoot: "/workspace", generation: 1, requestId: 1, results: [] });
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
  client.cancelFormatBuffer.mockResolvedValue(undefined);
  client.releaseBuffer.mockResolvedValue(undefined);
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

  it("opens an attachment viewer tab once, without a buffer, an active file path or a session entry", async () => {
    client.getSession.mockResolvedValue({ workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: true }, markdownViews: {}, splitVertical: false } satisfies SessionState);
    const workbench = testWorkbench(); await workbench.initialize();
    const path = viewerTabPath("att-1", "shot.png");
    workbench.openViewerTab(path); workbench.openViewerTab(path);
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts", path]);
    expect(workbench.activeTab()).toBe(path);
    expect(workbench.activePath()).toBeUndefined();
    expect(tabName(path)).toBe("shot.png");
    expect(client.openBuffer).toHaveBeenCalledTimes(1);
    await workbench.persistSession();
    const saved = client.saveSession.mock.lastCall?.[0] as SessionState;
    expect(saved.groups.flatMap(group => group.paths)).toEqual(["src/file.ts"]);
    expect(saved.groups[0].activePath).toBe("src/file.ts");
  });

  it("routes a viewer tab through openFile and never records it as a reopenable file", async () => {
    const workbench = await setup();
    const path = viewerTabPath("att-2", "notes.md");
    await workbench.openFile(path);
    expect(workbench.activeTab()).toBe(path);
    expect(client.openBuffer).toHaveBeenCalledTimes(1);
    workbench.closeTab(path, 1);
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts"]);
    expect(client.releaseBuffer).not.toHaveBeenCalledWith(path);
    await workbench.reopenClosedTab();
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts"]);
    expect(client.openBuffer).toHaveBeenCalledTimes(1);
  });

  it("focuses an open viewer tab in its own group instead of duplicating it", async () => {
    const workbench = await setup();
    const path = viewerTabPath("att-3", "a.json");
    workbench.openViewerTab(path); workbench.splitEditor();
    expect(workbench.groups()[1].tabs).toEqual([path]);
    workbench.closeTab(path, 1);
    workbench.setActiveGroup(1);
    workbench.openViewerTab(path);
    expect(workbench.activeGroup()).toBe(2);
    expect(workbench.groups().flatMap(group => group.tabs).filter(tab => tab === path)).toHaveLength(1);
  });

  it("restores saved file groups, panel sizes and Markdown view overrides", async () => {
    const readme: BufferSnapshot = { path: "README.md", text: "# Project\n", revision: 0, savedRevision: 0, language: "markdown" };
    server.set(readme.path, readme);
    const session: SessionState = { workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }, { paths: ["README.md"], activePath: "README.md" }], activeGroup: 1, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: true, assistantCollapsed: false, terminalCollapsed: true }, markdownViews: { "README.md": "both" }, splitVertical: false };
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

  it("restores the saved active file before applying the tab limit", async () => {
    const first: BufferSnapshot = { path: "src/first.ts", text: "first\n", revision: 0, savedRevision: 0, language: "typescript" };
    const active: BufferSnapshot = { path: "src/active.ts", text: "active\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(first.path, first); server.set(active.path, active);
    const session: SessionState = { workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts", first.path, active.path], activePath: active.path }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: false }, markdownViews: {}, splitVertical: false };
    client.getSession.mockResolvedValue(session);
    client.getSettings.mockResolvedValue({ ...preferences, tabLimit: 2 });
    const workbench = testWorkbench(); await workbench.initialize();
    expect(workbench.groups()[0].tabs).toEqual([first.path, active.path]);
    expect(workbench.activePath()).toBe(active.path);
  });

  it("evicts the least recently focused clean file and keeps dirty files until saved", async () => {
    const workbench = await setup();
    const a: BufferSnapshot = { path: "src/a.ts", text: "a\n", revision: 0, savedRevision: 0, language: "typescript" };
    const b: BufferSnapshot = { path: "src/b.ts", text: "b\n", revision: 0, savedRevision: 0, language: "typescript" };
    const c: BufferSnapshot = { path: "src/c.ts", text: "c\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(a.path, a); server.set(b.path, b); server.set(c.path, c);
    workbench.setSettings({ ...preferences, tabLimit: 3 });
    await workbench.openFile(a.path); await workbench.openFile(b.path); await workbench.openFile("src/file.ts"); await workbench.openFile(c.path);
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts", b.path, c.path]);

    workbench.setSettings({ ...preferences, tabLimit: 1 });
    append(workbench, "// unsaved\n");
    await workbench.openFile(a.path);
    expect(workbench.groups()[0].tabs).toContain("src/file.ts");
    expect(workbench.dirty("src/file.ts")).toBe(true);
    await workbench.save("src/file.ts");
    expect(workbench.dirty("src/file.ts")).toBe(false);
    expect(workbench.groups()[0].tabs).toEqual([a.path]);
  });

  it("releases a buffer to the language servers once when its last tab closes or is evicted", async () => {
    const workbench = await setup();
    const a: BufferSnapshot = { path: "src/a.ts", text: "a\n", revision: 0, savedRevision: 0, language: "typescript" };
    const b: BufferSnapshot = { path: "src/b.ts", text: "b\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(a.path, a); server.set(b.path, b);
    await workbench.openFile(a.path);
    workbench.closeTab(a.path, 1);
    expect(client.releaseBuffer.mock.calls).toEqual([[a.path]]);
    // Eviction by the tab limit releases the evicted file.
    client.releaseBuffer.mockClear();
    workbench.setSettings({ ...preferences, tabLimit: 1 });
    await workbench.openFile(b.path);
    expect(workbench.groups()[0].tabs).toEqual([b.path]);
    expect(client.releaseBuffer.mock.calls).toEqual([["src/file.ts"]]);
  });

  it("does not release a buffer another group still shows, and releases a closed group once", async () => {
    const workbench = await setup();
    workbench.splitEditor();
    expect(workbench.groups().map(group => group.tabs.includes("src/file.ts"))).toEqual([true, true]);
    workbench.closeTab("src/file.ts", 1);
    expect(client.releaseBuffer).not.toHaveBeenCalled();
    workbench.splitEditor();
    workbench.closeGroup(workbench.groups()[1].id);
    expect(client.releaseBuffer).not.toHaveBeenCalled();
    workbench.closeTab("src/file.ts", workbench.groups()[0].id);
    expect(client.releaseBuffer.mock.calls).toEqual([["src/file.ts"]]);
  });

  it("keeps dirty files open and unreleased when the tab limit would evict them", async () => {
    const workbench = await setup();
    const a: BufferSnapshot = { path: "src/a.ts", text: "a\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(a.path, a);
    workbench.setSettings({ ...preferences, tabLimit: 1 });
    append(workbench, "// unsaved\n");
    await workbench.openFile(a.path);
    expect(workbench.groups()[0].tabs).toContain("src/file.ts");
    expect(client.releaseBuffer).not.toHaveBeenCalled();
  });

  it("immediately applies a configured limit decrease", async () => {
    let configured = { ...preferences };
    client.getSettings.mockImplementation(async () => configured);
    client.getSettingsForScope.mockImplementation(async () => configured);
    client.updateSetting.mockImplementation(async (_scope: string, key: string, value: string) => {
      configured = { ...configured, [key]: JSON.parse(value) };
      return configured;
    });
    const workbench = await setup();
    const a: BufferSnapshot = { path: "src/a.ts", text: "a\n", revision: 0, savedRevision: 0, language: "typescript" };
    const b: BufferSnapshot = { path: "src/b.ts", text: "b\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(a.path, a); server.set(b.path, b);
    await workbench.openFile(a.path); await workbench.openFile(b.path);
    await workbench.updateSettings({ tabLimit: 2 });
    expect(workbench.settings().tabLimit).toBe(2);
    expect(workbench.groups()[0].tabs).toEqual([a.path, b.path]);
  });

  it("does not enforce a disabled limit and counts tabs per editor group when configured", async () => {
    const workbench = await setup();
    const a: BufferSnapshot = { path: "src/a.ts", text: "a\n", revision: 0, savedRevision: 0, language: "typescript" };
    const b: BufferSnapshot = { path: "src/b.ts", text: "b\n", revision: 0, savedRevision: 0, language: "typescript" };
    server.set(a.path, a); server.set(b.path, b);
    workbench.setSettings({ ...preferences, tabLimitEnabled: false, tabLimit: 1 });
    await workbench.openFile(a.path); await workbench.openFile(b.path);
    expect(workbench.groups()[0].tabs).toContain("src/file.ts");
    expect(workbench.groups()[0].tabs).toContain(a.path);
    expect(workbench.groups()[0].tabs).toContain(b.path);

    workbench.setSettings({ ...preferences, tabLimit: 1, tabLimitPerGroup: true });
    await workbench.openFile("src/file.ts");
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts"]);
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
    workbench.splitEditor();
    client.formatBuffer.mockImplementation(async () => { const result = { ...initial(), text: "const value = 1;\n\n", revision: 1 }; server.set(result.path, result); return result; });
    await workbench.format("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe("const value = 1;\n\n");
    workbench.applyHistory("src/file.ts");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(2));
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
  });

  it("rebases edits made during formatting over the accepted formatter result", async () => {
    const workbench = await setup();
    const response = deferred<BufferSnapshot>();
    client.formatBuffer.mockReturnValue(response.promise);
    const formatting = workbench.format("src/file.ts");
    await vi.waitFor(() => expect(client.formatBuffer).toHaveBeenCalled());
    append(workbench, "// keep the user's newer edit\n");
    await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const formatted = { ...initial(), text: "const value = 1;\n\n", revision: 2 };
    server.set(formatted.path, formatted);
    response.resolve(formatted);
    await formatting;
    expect(client.cancelFormatBuffer).toHaveBeenCalledWith("src/file.ts", expect.any(Number));
    expect(workbench.documents()[formatted.path].document.toString()).toContain("keep the user's newer edit");
    expect(server.get(formatted.path)?.text).toContain("keep the user's newer edit");
    expect(workbench.pendingRecovery()).toBeUndefined();
    workbench.applyHistory(formatted.path);
    await vi.waitFor(() => expect(server.get(formatted.path)?.text).toBe(initial().text));
  });

  it("refreshes a hidden buffer without reopening its tab when format finishes after close", async () => {
    const workbench = await setup();
    const response = deferred<BufferSnapshot>();
    client.formatBuffer.mockReturnValue(response.promise);
    const formatting = workbench.format("src/file.ts");
    await vi.waitFor(() => expect(client.formatBuffer).toHaveBeenCalled());
    workbench.closeTab("src/file.ts", 1);
    expect(client.cancelFormatBuffer).toHaveBeenCalledWith("src/file.ts", expect.any(Number));
    const formatted = { ...initial(), text: "FORMATTED_RESULT\n", revision: 1 };
    server.set(formatted.path, formatted);
    response.resolve(formatted);
    await formatting;
    expect(workbench.groups().flatMap(group => group.tabs)).not.toContain("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(formatted.text);
    expect(workbench.buffers[formatted.path].revision).toBe(1);
    const reads = client.openBuffer.mock.calls.length;
    await workbench.openFile(formatted.path);
    expect(client.openBuffer.mock.calls.length).toBe(reads);
    append(workbench, "// fresh edit after reopen\n");
    await vi.waitFor(() => expect(workbench.buffers[formatted.path].revision).toBe(2));
    expect(await workbench.save(formatted.path)).toBe(true);
  });

  it("does not cancel formatting while another split still displays the buffer", async () => {
    const workbench = await setup();
    workbench.splitEditor();
    const response = deferred<BufferSnapshot>();
    client.formatBuffer.mockReturnValue(response.promise);
    const formatting = workbench.format("src/file.ts");
    await vi.waitFor(() => expect(client.formatBuffer).toHaveBeenCalled());
    workbench.closeTab("src/file.ts", 1);
    expect(client.cancelFormatBuffer).not.toHaveBeenCalled();
    const formatted = { ...initial(), text: "const value = 1;\n\n", revision: 1 };
    server.set(formatted.path, formatted);
    response.resolve(formatted);
    await formatting;
    expect(workbench.documents()[formatted.path].document.toString()).toBe(formatted.text);
  });

  it("rejects a delayed formatter result from the previous workspace", async () => {
    const workbench = await setup();
    const response = deferred<BufferSnapshot>();
    client.formatBuffer.mockReturnValue(response.promise);
    const formatting = workbench.format("src/file.ts");
    await vi.waitFor(() => expect(client.formatBuffer).toHaveBeenCalled());
    await workbench.openWorkspace("/replacement");
    const replacement = { ...initial(), text: "NEW_WORKSPACE_TEXT\n", revision: 0 };
    server.set(replacement.path, replacement);
    await workbench.openFile(replacement.path);
    response.resolve({ ...initial(), text: "OLD_WORKSPACE_RESULT\n", revision: 1 });
    await formatting;
    expect(workbench.documents()[replacement.path].document.toString()).toBe(replacement.text);
    expect(workbench.pendingRecovery()).toBeUndefined();
  });

  it("keeps a completed format revision when the native folder picker is canceled", async () => {
    const workbench = await setup();
    const response = deferred<BufferSnapshot>();
    client.formatBuffer.mockReturnValue(response.promise);
    const formatting = workbench.format("src/file.ts");
    await vi.waitFor(() => expect(client.formatBuffer).toHaveBeenCalled());
    client.openWorkspace.mockResolvedValueOnce(null);
    await workbench.openWorkspace();
    const formatted = { ...initial(), text: "FORMATTED_RESULT\n", revision: 1 };
    server.set(formatted.path, formatted);
    response.resolve(formatted);
    await formatting;
    expect(workbench.workspace()?.root).toBe("/workspace");
    expect(workbench.documents()[formatted.path].document.toString()).toBe(formatted.text);
    append(workbench, "// edit after picker cancellation\n");
    await vi.waitFor(() => expect(workbench.buffers[formatted.path].revision).toBe(2));
    expect(await workbench.save(formatted.path)).toBe(true);
  });

  it("records format-on-save output as one shared undo step", async () => {
    const workbench = await setup();
    const formatted = { ...initial(), text: "const value = 1;\n\n", revision: 1, savedRevision: 1 };
    client.saveBuffer.mockImplementationOnce(async () => { server.set(formatted.path, formatted); return formatted; });
    expect(await workbench.save("src/file.ts")).toBe(true);
    expect(workbench.documents()[formatted.path].document.toString()).toBe(formatted.text);
    workbench.applyHistory(formatted.path);
    await vi.waitFor(() => expect(workbench.documents()[formatted.path].document.toString()).toBe(initial().text));
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

  it("restores the saved project for a dropped or forwarded file and never opens the file's folder", async () => {
    client.takeStartupRequests.mockResolvedValue([{ workspaceRoot: "/elsewhere", files: [{ path: "/elsewhere/notes.md", line: null, column: null }], impliedRoot: true }]);
    client.getSession.mockResolvedValue({ workspaceRoot: "/workspace", groups: [{ paths: [], activePath: null }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: true }, markdownViews: {}, splitVertical: false } satisfies SessionState);
    const workbench = testWorkbench();
    const seen: unknown[] = [];
    await workbench.initialize(async request => { seen.push(request); });
    expect(workbench.workspace()?.root).toBe("/workspace");
    expect(client.openWorkspace).not.toHaveBeenCalledWith("/elsewhere", expect.anything());
    expect(client.openWorkspace).not.toHaveBeenCalledWith("/elsewhere");
    expect(seen).toHaveLength(1);
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
    expect(workbench.activePath()).toBe(base.path);
    await workbench.save(); expect(client.saveSettingsBuffer).toHaveBeenCalledWith("user", 1);
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
  it("saves unsaved edits before renaming so the move is not refused", async () => {
    const workbench = await setup(); append(workbench, "// unsaved\n"); await vi.waitFor(() => expect(workbench.buffers["src/file.ts"].revision).toBe(1));
    const order: string[] = [];
    client.saveBuffer.mockImplementation(async (path: string, revision: number) => { order.push("save"); const old = server.get(path)!; const saved = { ...old, revision: Math.max(old.revision, revision), savedRevision: Math.max(old.revision, revision) }; server.set(path, saved); return saved; });
    client.renamePath.mockImplementation(async (from: string, to: string) => { order.push("rename"); const old = server.get(from)!; server.delete(from); server.set(to, { ...old, path: to }); return { path: to, name: "renamed.ts", isDir: false }; });
    await workbench.renamePath("src/file.ts", "src/renamed.ts");
    expect(order).toEqual(["save", "rename"]);
    expect(workbench.activePath()).toBe("src/renamed.ts");
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


describe("incremental workspace file index", () => {
  const status = (root = "/workspace", generation = 1): FileIndexStatus => ({ workspaceRoot: root, generation, status: "scanning", scannedEntries: 80, indexedFiles: 12, errorCount: 0, lastError: null, watcherReady: true, watcherError: null });
  it("publishes the first visible level without waiting for settings or a recursive file list", async () => {
    const prefs = deferred<Settings>();
    client.getSettings.mockReturnValue(prefs.promise);
    client.listFiles.mockReturnValue(new Promise(() => {}));
    client.listDirectory.mockResolvedValue([{ path: "src", name: "src", isDir: true }]);
    client.fileIndexStatus.mockResolvedValue(status());
    const workbench = testWorkbench(); const opening = workbench.openWorkspace("/workspace");
    await vi.waitFor(() => expect(workbench.directories[""]?.[0]?.name).toBe("src"));
    expect(workbench.workspace()?.root).toBe("/workspace");
    expect(workbench.indexStatus()?.indexedFiles).toBe(12);
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.listDirectory).toHaveBeenCalledTimes(1);
    prefs.resolve(preferences); await opening;
  });
  it("expands directories lazily, deduplicates reads and respects collapse during loading", async () => {
    const workbench = await setup(); const listing = deferred<{ path: string; name: string; isDir: boolean }[]>();
    client.listDirectory.mockClear(); client.listDirectory.mockReturnValue(listing.promise);
    expect(workbench.expanded().has("src")).toBe(false); expect(client.listDirectory).not.toHaveBeenCalled();
    const expansion = workbench.toggleDirectory("src");
    expect(workbench.expanded().has("src")).toBe(true); expect(workbench.loadingDirectories().has("src")).toBe(true);
    const duplicate = workbench.loadDirectory("src");
    await workbench.toggleDirectory("src");
    listing.resolve([{ path: "src/new.ts", name: "new.ts", isDir: false }]); await Promise.all([expansion, duplicate]);
    expect(client.listDirectory).toHaveBeenCalledTimes(1); expect(workbench.expanded().has("src")).toBe(false);
    expect(workbench.loadingDirectories().has("src")).toBe(false); expect(workbench.files().some(file => file.path === "src/new.ts")).toBe(true);
  });
  it("never rescans files or reloads directory listings on save", async () => {
    const workbench = await setup(); client.listFiles.mockClear(); client.listDirectory.mockClear();
    append(workbench, "// incremental save\n"); expect(await workbench.save("src/file.ts")).toBe(true);
    expect(client.listFiles).not.toHaveBeenCalled(); expect(client.listDirectory).not.toHaveBeenCalled();
  });
  it("preserves backend ranking and rejects root/generation mismatches", async () => {
    client.fileIndexStatus.mockResolvedValue(status("/workspace", 2));
    const workbench = await setup();
    client.queryFile.mockResolvedValue({ workspaceRoot: "/workspace", generation: 2, requestId: 2, results: [{ path: "src/zebra.ts", score: 9 }, { path: "alpha.ts", score: 2 }] });
    expect((await workbench.queryFiles("zt")).map(file => file.path)).toEqual(["src/zebra.ts", "alpha.ts"]);
    expect(client.queryFile).toHaveBeenCalledWith("zt", 100);
    client.queryFile.mockResolvedValue({ workspaceRoot: "/other", generation: 2, requestId: 3, results: [{ path: "old.ts", score: 1 }] });
    expect(await workbench.queryFiles("old")).toEqual([]);
    client.queryFile.mockResolvedValue({ workspaceRoot: "/workspace", generation: 1, requestId: 4, results: [{ path: "old.ts", score: 1 }] });
    expect(await workbench.queryFiles("old")).toEqual([]);
  });
  it("rejects late file queries, directory reads and progress from the previous workspace", async () => {
    const workbench = await setup();
    const query = deferred<{ workspaceRoot: string; generation: number; requestId: number; results: { path: string; score: number }[] }>();
    const directory = deferred<{ path: string; name: string; isDir: boolean }[]>();
    client.queryFile.mockReturnValue(query.promise);
    client.listDirectory.mockImplementation((path: string) => path === "old" ? directory.promise : Promise.resolve([]));
    const lookup = workbench.queryFiles("old"); const listing = workbench.loadDirectory("old");
    client.fileIndexStatus.mockResolvedValue(status("/new", 2));
    await workbench.openWorkspace("/new");
    query.resolve({ workspaceRoot: "/workspace", generation: 1, requestId: 1, results: [{ path: "old.ts", score: 2 }] });
    directory.resolve([{ path: "old/a.ts", name: "a.ts", isDir: false }]);
    expect(await lookup).toEqual([]); await listing;
    expect(workbench.directories.old).toBeUndefined(); expect(workbench.indexStatus()?.workspaceRoot).toBe("/new");
    expect(workbench.files()).toEqual([]);
  });
});


it("ignores an older workspace progress response and stops polling when disposed", async () => {
  vi.useFakeTimers();
  try {
    const old = deferred<FileIndexStatus | null>();
    client.fileIndexStatus.mockReturnValueOnce(old.promise).mockResolvedValue({ workspaceRoot: "/next", generation: 2, status: "ready", indexedFiles: 7, scannedEntries: 10, errorCount: 0, lastError: null, watcherReady: true, watcherError: null });
    const workbench = testWorkbench(); await workbench.openWorkspace("/workspace"); await workbench.openWorkspace("/next");
    old.resolve({ workspaceRoot: "/workspace", generation: 1, status: "scanning", indexedFiles: 99, scannedEntries: 100, errorCount: 0, lastError: null, watcherReady: true, watcherError: null });
    await Promise.resolve(); expect(workbench.indexStatus()?.workspaceRoot).toBe("/next");
    await vi.advanceTimersByTimeAsync(2000); expect(client.fileIndexStatus).toHaveBeenCalledTimes(3);
    for (const dispose of roots.splice(0)) dispose();
    await vi.advanceTimersByTimeAsync(6000); expect(client.fileIndexStatus).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

describe("editor layout directions and drop zones", () => {
  const add = (...paths: string[]) => { for (const path of paths) server.set(path, { path, text: "x\n", revision: 0, savedRevision: 0, language: "typescript" }); };
  it("splits right and down, and places left or up groups first", async () => {
    const workbench = await setup();
    workbench.splitEditor(1, undefined, "down");
    expect(workbench.groups()).toHaveLength(2); expect(workbench.splitVertical()).toBe(true);
    expect(workbench.groups().map(group => group.id)).toEqual([1, 2]);
    workbench.closeGroup(2);
    workbench.splitEditor(1, undefined, "left");
    expect(workbench.splitVertical()).toBe(false); expect(workbench.groups().map(group => group.id)).toEqual([3, 1]);
  });
  it("never creates a third group", async () => {
    const workbench = await setup();
    workbench.splitEditor(1, undefined, "down"); workbench.splitEditor(1, undefined, "right"); workbench.splitEditor(2, undefined, "up");
    expect(workbench.groups()).toHaveLength(2); expect(workbench.splitVertical()).toBe(true);
  });
  it("opens a file in a new group below for the bottom zone and in the other group when two exist", async () => {
    const workbench = await setup(); add("src/other.ts", "src/third.ts");
    await workbench.openInZone("src/other.ts", 1, "bottom");
    expect(workbench.splitVertical()).toBe(true); expect(workbench.groups()).toHaveLength(2);
    expect(workbench.groups()[1].tabs).toEqual(["src/other.ts"]); expect(workbench.groups()[0].tabs).toContain("src/file.ts");
    await workbench.openInZone("src/third.ts", 1, "right");
    expect(workbench.groups()).toHaveLength(2); expect(workbench.groups()[1].tabs).toContain("src/third.ts");
  });
  it("opens in the same group for the centre zone", async () => {
    const workbench = await setup(); add("src/other.ts");
    await workbench.openInZone("src/other.ts", 1, "center");
    expect(workbench.groups()).toHaveLength(1); expect(workbench.groups()[0].tabs).toContain("src/other.ts");
  });
  it("moves a tab to a new group on the right edge and keeps the source group's other tabs", async () => {
    const workbench = await setup(); add("src/two.ts");
    await workbench.openFile("src/two.ts");
    workbench.moveTabToZone("src/two.ts", 1, 1, "right");
    expect(workbench.groups()).toHaveLength(2); expect(workbench.splitVertical()).toBe(false);
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts"]); expect(workbench.groups()[1].tabs).toEqual(["src/two.ts"]);
  });
  it("refuses to split off the only tab of the only group", async () => {
    const workbench = await setup();
    workbench.moveTabToZone("src/file.ts", 1, 1, "bottom");
    expect(workbench.groups()).toHaveLength(1);
  });
  it("saves the stacked layout in the session and drops it with one group", async () => {
    const session: SessionState = { workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: false }, markdownViews: {}, splitVertical: false };
    client.getSession.mockResolvedValue(session);
    const workbench = testWorkbench(); await workbench.initialize();
    workbench.splitEditor(1, undefined, "down");
    await workbench.persistSession();
    expect(client.saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ splitVertical: true }));
    workbench.closeGroup(2); await workbench.persistSession();
    expect(client.saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ splitVertical: false }));
  });
  it("restores the stacked layout from a saved session", async () => {
    const session: SessionState = { workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts"], activePath: "src/file.ts" }, { paths: ["src/file.ts"], activePath: "src/file.ts" }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: false }, markdownViews: {}, splitVertical: true };
    client.getSession.mockResolvedValue(session);
    const workbench = testWorkbench(); await workbench.initialize();
    expect(workbench.groups()).toHaveLength(2); expect(workbench.splitVertical()).toBe(true);
  });
});


describe("read-only Git workspace tabs", () => {
  it("counts clean comparisons toward the tab limit while protecting dirty editor content", async () => {
    client.getSettings.mockResolvedValue({ ...preferences, tabLimit: 2 });
    const workbench = await setup(); append(workbench, "// keep this draft\n");
    const first = workbench.openGitTab("working:first", "First comparison")!;
    const second = workbench.openGitTab("working:second", "Second comparison")!;
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts", second]);
    expect(workbench.groups()[0].tabs).not.toContain(first);
    expect(workbench.dirty("src/file.ts")).toBe(true);
  });

  it("opens and closes comparisons without reading a filesystem buffer or losing the editor draft/history", async () => {
    const workbench = await setup();
    append(workbench, "// retained draft\n");
    const draft = workbench.documents()["src/file.ts"].document;
    const opens = client.openBuffer.mock.calls.length;
    const tab = workbench.openGitTab("working:src/file.ts", "file.ts (Working changes)")!;
    expect(isGitTab(tab)).toBe(true); expect(tabName(tab)).toBe("file.ts (Working changes)");
    expect(workbench.activeTab()).toBe(tab); expect(workbench.activePath()).toBeUndefined();
    expect(await workbench.save()).toBe(false); expect(client.openBuffer).toHaveBeenCalledTimes(opens);
    workbench.closeTab(tab, workbench.activeGroup());
    expect(workbench.documents()["src/file.ts"].document).toBe(draft);
    expect(workbench.dirty("src/file.ts")).toBe(true);
    workbench.applyHistory("src/file.ts");
    expect(workbench.documents()["src/file.ts"].document.toString()).toBe(initial().text);
    expect(client.releaseBuffer.mock.calls.some(([path]) => isGitTab(path))).toBe(false);
  });
  it("does not persist virtual Git tabs or send them to native buffer IPC", async () => {
    const workbench = testWorkbench(); await workbench.initialize();
    await workbench.openWorkspace("/workspace"); await workbench.openFile("src/file.ts");
    const tab = workbench.openGitTab("history:abc123", "Commit abc123")!;
    await workbench.persistSession();
    const saved = client.saveSession.mock.calls.at(-1)![0];
    expect(saved.groups[0].paths).toEqual(["src/file.ts"]); expect(saved.groups[0].activePath).toBe("src/file.ts");
    await workbench.openFile(tab); expect(client.openBuffer.mock.calls.map(([path]) => path)).toEqual(["src/file.ts"]);
    await workbench.openWorkspace("/other"); expect(workbench.groups().flatMap(group => group.tabs)).not.toContain(tab);
  });
});


describe("Explorer discovery preference refresh", () => {
  function legacyStorage() {
    const values = new Map([["span.explorer.compactFolders", "false"], ["span.explorer.autoReveal", "false"]]);
    vi.stubGlobal("window", { innerWidth: 1440, innerHeight: 900, localStorage: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) } });
    return values;
  }
  it("clears only migrated legacy leaves after the backend validates both scopes", async () => {
    const values = legacyStorage();
    client.migrateExplorerPreferences.mockResolvedValue({ settings: preferences, resolvedLegacyKeys: ["compactFolders"] });
    await setup();
    expect(client.migrateExplorerPreferences).toHaveBeenCalledWith("/workspace", { compactFolders: false, autoReveal: false, confirmDelete: null });
    expect(values.has("span.explorer.compactFolders")).toBe(false);
    expect(values.get("span.explorer.autoReveal")).toBe("false");
  });
  it("retains legacy preferences and keeps the workspace available if migration fails", async () => {
    const values = legacyStorage();
    client.migrateExplorerPreferences.mockRejectedValue(new Error("Invalid settings"));
    const workbench = await setup();
    expect(workbench.workspace()?.root).toBe("/workspace");
    expect(values.size).toBe(2);
  });

  it("invalidates pending tree and file-finder replies when visibility changes", async () => {
    const workbench = await setup();
    const oldDirectory = deferred<{ path: string; name: string; isDir: boolean }[]>();
    const oldQuery = deferred<{ workspaceRoot: string; generation: number; requestId: number; results: { path: string; score: number }[] }>();
    client.listDirectory.mockImplementationOnce(() => oldDirectory.promise).mockResolvedValue([{ path: "src/visible.ts", name: "visible.ts", isDir: false }]);
    client.queryFile.mockReturnValueOnce(oldQuery.promise);
    const expanding = workbench.toggleDirectory("src");
    const finding = workbench.queryFiles("hidden");
    client.getSettings.mockResolvedValue({ ...preferences, explorer: { showHiddenFiles: false, showIgnoredFiles: false, compactFolders: true, autoReveal: true, confirmDelete: true } });
    await workbench.updateSettingKey("explorer.showHiddenFiles", false);
    oldDirectory.resolve([{ path: "src/.hidden.ts", name: ".hidden.ts", isDir: false }]);
    oldQuery.resolve({ workspaceRoot: "/workspace", generation: 1, requestId: 1, results: [{ path: "src/.hidden.ts", score: 1 }] });
    await expanding;
    expect(await finding).toEqual([]);
    expect(workbench.directories.src.map(entry => entry.path)).toEqual(["src/visible.ts"]);
    expect(workbench.files().some(entry => entry.path === "src/.hidden.ts")).toBe(false);
  });

  it("does not feed lazily opened dependency rows into the file finder fallback", async () => {
    const workbench = await setup();
    client.listDirectory.mockResolvedValue([{ path: "node_modules/pkg/index.js", name: "index.js", isDir: false, ignored: true, backgroundExcluded: true }]);
    await workbench.loadDirectory("node_modules/pkg");
    expect(workbench.files().some(entry => entry.path.startsWith("node_modules/"))).toBe(false);
  });
});

describe("external file synchronization", () => {
  it("reloads a clean buffer after a watcher change without saving over the new disk content", async () => {
    vi.useFakeTimers();
    try {
      const workbench = await setup();
      const snapshot = { ...initial(), text: "const external = true;\n", revision: 1, savedRevision: 1 };
      client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: true, states: [{ path: "src/file.ts", revision: 0, kind: "reloaded", snapshot, disk: null, error: null }] });
      await vi.advanceTimersByTimeAsync(2100);
      expect(workbench.documents()["src/file.ts"].document.toString()).toBe(snapshot.text);
      expect(client.saveBuffer).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});


it("retains dirty external conflicts, freezes the reviewed disk token, and never auto-overwrites", async () => {
  const workbench = await setup(); append(workbench, "// draft\n"); await vi.waitFor(() => expect(workbench.synchronized("src/file.ts")).toBe(true));
  const conflict = (token: string) => ({ path: "src/file.ts", revision: workbench.buffers["src/file.ts"].revision, kind: "conflict", snapshot: null, disk: { token, exists: true, text: "outside", truncated: false }, error: null });
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [conflict("reviewed")] });
  await workbench.checkExternalChanges(true); workbench.reviewExternalFile("src/file.ts");
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 2, directoriesChanged: false, states: [conflict("newer")] });
  await workbench.checkExternalChanges(true);
  expect(workbench.externalReview()?.disk?.token).toBe("reviewed");
  expect(workbench.documents()["src/file.ts"].document.toString()).toContain("// draft");
  expect(await workbench.save("src/file.ts", true)).toBe(false); expect(client.saveBuffer).not.toHaveBeenCalled();
  // Review the frozen version again before an explicit resolution. The backend
  // rejects its old disk token, preserving the editor draft and newer disk.
  client.resolveExternalFile.mockRejectedValue(new Error("File changed on disk"));
  await expect(workbench.resolveExternalChange("src/file.ts", "overwrite")).rejects.toThrow("changed on disk");
  expect(client.resolveExternalFile).toHaveBeenCalledWith("src/file.ts", expect.any(Number), "reviewed", "overwrite", "/workspace");
  expect(workbench.documents()["src/file.ts"].document.toString()).toContain("// draft");
});

it("preserves renderer edits racing a clean reload and requires comparison before saving them", async () => {
  const workbench = await setup(); const pending = deferred<any>();
  client.checkExternalFiles.mockReturnValueOnce(pending.promise);
  const checking = workbench.checkExternalChanges(true);
  const snapshot = { ...initial(), text: "external\n", revision: 1, savedRevision: 1 };
  server.set("src/file.ts", snapshot); append(workbench, "// arriving draft\n");
  pending.resolve({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [{ path: "src/file.ts", revision: 0, kind: "reloaded", snapshot, disk: { token: "external-token", exists: true, text: snapshot.text, truncated: false }, error: null }] });
  await checking;
  expect(workbench.documents()["src/file.ts"].document.toString()).toContain("// arriving draft");
  expect(workbench.externalChanges()["src/file.ts"].disk?.token).toBe("external-token");
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [{ path: "src/file.ts", revision: 2, kind: "unchanged", snapshot: null, disk: null, error: null }] });
  await workbench.checkExternalChanges(true);
  expect(workbench.externalChanges()["src/file.ts"]).toBeDefined();
  expect(await workbench.save("src/file.ts")).toBe(false); expect(client.saveBuffer).not.toHaveBeenCalled();
});

it("ignores late external reloads from a workspace that has been replaced", async () => {
  const workbench = await setup(); const pending = deferred<any>();
  client.checkExternalFiles.mockReturnValueOnce(pending.promise);
  const checking = workbench.checkExternalChanges(true);
  await workbench.openWorkspace("/other");
  pending.resolve({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: true, states: [{ path: "src/file.ts", revision: 0, kind: "reloaded", snapshot: { ...initial(), text: "stale" }, disk: null, error: null }] });
  await checking;
  expect(workbench.workspace()?.root).toBe("/other"); expect(workbench.documents()["src/file.ts"]).toBeUndefined(); expect(workbench.externalChanges()).toEqual({});
});


it("never writes an older backend buffer when the reviewed editor draft failed to synchronize", async () => {
  const workbench = await setup(); client.editBuffer.mockRejectedValue(new Error("edit sync failed"));
  append(workbench, "// unsynchronized\n"); await vi.waitFor(() => expect(workbench.failed().has("src/file.ts")).toBe(true));
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [{ path: "src/file.ts", revision: 0, kind: "conflict", snapshot: null, disk: { token: "reviewed", exists: true, text: "outside", truncated: false }, error: null }] });
  await workbench.checkExternalChanges(true); workbench.reviewExternalFile("src/file.ts");
  await expect(workbench.resolveExternalChange("src/file.ts", "overwrite")).rejects.toThrow("not synchronized");
  expect(client.resolveExternalFile).not.toHaveBeenCalled(); expect(workbench.documents()["src/file.ts"].document.toString()).toContain("// unsynchronized");
});

it("explicitly discards and closes an unavailable retained buffer without rereading the disk", async () => {
  const workbench = await setup();
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [{ path: "src/file.ts", revision: 0, kind: "unavailable", snapshot: null, disk: null, error: "permission denied" }] });
  await workbench.checkExternalChanges(true);
  await workbench.closeTab("src/file.ts", workbench.activeGroup()); expect(workbench.pendingClose()?.path).toBe("src/file.ts");
  await workbench.confirmClose("discard");
  expect(client.abandonExternalFile).toHaveBeenCalledWith("src/file.ts", 0, "/workspace"); expect(client.discardBuffer).not.toHaveBeenCalled();
  expect(workbench.groups().flatMap(group => group.tabs)).not.toContain("src/file.ts"); expect(workbench.hasDirty()).toBe(false);
});


it("finishes an explicitly approved unavailable discard before allowing cancel", async () => {
  const workbench = await setup(); const pending = deferred<void>();
  client.checkExternalFiles.mockResolvedValue({ workspaceRoot: "/workspace", revision: 1, directoriesChanged: false, states: [{ path: "src/file.ts", revision: 0, kind: "unavailable", snapshot: null, disk: null, error: "permission denied" }] });
  await workbench.checkExternalChanges(true); await workbench.closeTab("src/file.ts", workbench.activeGroup());
  client.abandonExternalFile.mockReturnValue(pending.promise);
  const closing = workbench.confirmClose("discard"); await vi.waitFor(() => expect(client.abandonExternalFile).toHaveBeenCalled());
  await workbench.confirmClose("cancel"); expect(workbench.pendingClose()?.path).toBe("src/file.ts"); expect(workbench.externalAbandoning()).toBe(true);
  pending.resolve(); await closing;
  expect(workbench.groups().flatMap(group => group.tabs)).not.toContain("src/file.ts"); expect(workbench.documents()["src/file.ts"]).toBeUndefined();
});

describe("files that are not text", () => {
  const notText = "This file isn't text, so it can't be opened in the editor.";
  const probe = (path: string, size = 2048) => ({ path, name: path.split("/").pop()!, size, kind: "binary" as const });

  it("opens a known binary extension in the viewer without reading it as text", async () => {
    client.probeFile.mockImplementation(async (path: string) => probe(path));
    const workbench = testWorkbench(); await workbench.openWorkspace("/workspace");
    await workbench.openFile("docs/report.docx");
    expect(client.openBuffer).not.toHaveBeenCalledWith("docs/report.docx");
    expect(workbench.binaryFile("docs/report.docx")).toEqual(probe("docs/report.docx"));
    expect(workbench.groups()[0].tabs).toEqual(["docs/report.docx"]);
    expect(workbench.buffers["docs/report.docx"]).toBeUndefined();
    expect(workbench.error()).toBe("");
  });

  it("turns a refused text read into a viewer tab instead of a raw error", async () => {
    client.openBuffer.mockImplementation(async (path: string) => {
      if (path === "data/blob.dat") throw "Read file /workspace/data/blob.dat: stream did not contain valid UTF-8";
      return { ...server.get(path)! };
    });
    client.probeFile.mockRejectedValue(new Error("probe unavailable"));
    const workbench = testWorkbench(); await workbench.openWorkspace("/workspace");
    await workbench.openFile("data/blob.dat");
    expect(workbench.error()).toBe("");
    expect(workbench.binaryFile("data/blob.dat")).toEqual({ path: "data/blob.dat", name: "blob.dat", size: 0, kind: "binary" });
    expect(workbench.groups()[0].active).toBe("data/blob.dat");
    // Other read failures are still reported.
    client.openBuffer.mockRejectedValueOnce(new Error("Permission denied"));
    await workbench.openFile("src/other.ts");
    expect(workbench.error()).toBe("Permission denied");
  });

  it("restores a saved session with a binary tab without an error", async () => {
    client.openBuffer.mockImplementation(async (path: string) => {
      if (path === "notes/legacy.txt") throw notText;
      return { ...server.get(path)! };
    });
    client.probeFile.mockImplementation(async (path: string) => probe(path, 10));
    client.getSession.mockResolvedValue({ workspaceRoot: "/workspace", groups: [{ paths: ["src/file.ts", "docs/report.docx", "notes/legacy.txt"], activePath: "docs/report.docx" }], activeGroup: 0, panels: { projectWidth: 280, assistantWidth: 330, terminalHeight: 190, projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: true }, markdownViews: {}, splitVertical: false } satisfies SessionState);
    const workbench = testWorkbench(); await workbench.initialize();
    expect(workbench.groups()[0].tabs).toEqual(["src/file.ts", "docs/report.docx", "notes/legacy.txt"]);
    expect(workbench.activeTab()).toBe("docs/report.docx");
    expect(workbench.binaryFile("docs/report.docx")?.kind).toBe("binary");
    expect(workbench.binaryFile("notes/legacy.txt")?.kind).toBe("binary");
    expect(workbench.error()).toBe("");
    await workbench.persistSession();
    const saved = client.saveSession.mock.lastCall?.[0] as SessionState;
    expect(saved.groups[0].paths).toContain("docs/report.docx");
  });

  it("forgets the binary entry when its last tab closes", async () => {
    client.probeFile.mockImplementation(async (path: string) => probe(path));
    const workbench = testWorkbench(); await workbench.openWorkspace("/workspace");
    await workbench.openFile("docs/report.docx");
    workbench.closeTab("docs/report.docx", workbench.groups()[0].id);
    expect(workbench.binaryFile("docs/report.docx")).toBeUndefined();
  });
});
