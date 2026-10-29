import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { ChangeSet } from "@codemirror/state";
import type { BufferSnapshot, TextEdit } from "../bindings";

const client = vi.hoisted(() => ({
  openWorkspace: vi.fn(), listDirectory: vi.fn(), fileIndexStatus: vi.fn(), getSettings: vi.fn(), getSettingsJsonc: vi.fn(), getSettingsForScope: vi.fn(), getSettingsJsoncForScope: vi.fn(), getSettingsKeysForScope: vi.fn(),
  openBuffer: vi.fn(), editBuffer: vi.fn(), saveBuffer: vi.fn(), saveSession: vi.fn(), cancelFormatBuffer: vi.fn(), releaseBuffer: vi.fn(),
}));
vi.mock("../lib/client", () => ({ api: client, isDesktop: true }));
import { createWorkbench, type Workbench } from "./workbench";

const path = "src/file.ts";
const initial = (): BufferSnapshot => ({ path, text: "one\n", revision: 0, savedRevision: 0, language: "typescript" });
const roots: (() => void)[] = [];
let server: BufferSnapshot;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); server = initial();
  client.openWorkspace.mockImplementation(async root => ({ root, name: root.split("/").at(-1) }));
  client.listDirectory.mockResolvedValue([]); client.fileIndexStatus.mockResolvedValue(null);
  client.getSettingsJsonc.mockResolvedValue("{}"); client.getSettingsJsoncForScope.mockResolvedValue("{}"); client.getSettingsKeysForScope.mockResolvedValue([]);
  client.openBuffer.mockImplementation(async () => ({ ...server }));
  client.editBuffer.mockImplementation(async (_path: string, revision: number, changes: TextEdit[]) => {
    if (server.revision !== revision) throw new Error("Stale buffer revision");
    let text = server.text;
    for (const change of [...changes].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    server = { ...server, text, revision: revision + 1 };
    return { path, revision: server.revision, savedRevision: server.savedRevision };
  });
  client.saveBuffer.mockImplementation(async () => { server = { ...server, savedRevision: server.revision }; return { ...server }; });
  client.saveSession.mockResolvedValue(undefined); client.cancelFormatBuffer.mockResolvedValue(undefined); client.releaseBuffer.mockResolvedValue(undefined);
});
afterEach(() => { roots.splice(0).forEach(dispose => dispose()); });
async function setup() {
  const workbench = createRoot(dispose => { roots.push(dispose); return createWorkbench(); });
  const settings = { ...workbench.settings(), autoSave: "off" };
  client.getSettings.mockResolvedValue(settings); client.getSettingsForScope.mockResolvedValue(settings);
  await workbench.openWorkspace("/workspace"); await workbench.openFile(path);
  expect(workbench.error()).toBe("");
  return workbench;
}
function replace(workbench: Workbench, text: string) {
  const previousDocument = workbench.documents()[path].document;
  const changes = [{ from: 0, to: previousDocument.length, insert: text }];
  const changeSet = ChangeSet.of(changes, previousDocument.length);
  workbench.edit(path, { baseRevision: workbench.buffers[path].revision, previousDocument, document: changeSet.apply(previousDocument), changes, changeSet });
}

describe("clean buffer refresh after native Git operations", () => {
  it("applies a clean native snapshot to the editor and keeps subsequent edits synchronized with its revision", async () => {
    const w = await setup();
    server = { ...initial(), text: "checked out branch\n", revision: 4, savedRevision: 4 };
    await w.refreshBuffer(path);
    expect(w.documents()[path].document.toString()).toBe(server.text);
    expect(w.buffers[path]).toMatchObject({ revision: 4, savedRevision: 4 });
    expect(w.dirty(path)).toBe(false);
    replace(w, "local edit after checkout\n");
    await vi.waitFor(() => expect(w.buffers[path].revision).toBe(5));
    expect(client.editBuffer).toHaveBeenLastCalledWith(path, 4, expect.any(Array));
    expect(server.text).toBe("local edit after checkout\n");
  });
  it("preserves an edit made while the native read is held, even before the edit is acknowledged", async () => {
    const w = await setup(), read = deferred<BufferSnapshot>();
    const acknowledgement = deferred<{ path: string; revision: number; savedRevision: number }>();
    client.openBuffer.mockImplementationOnce(() => read.promise);
    client.editBuffer.mockImplementationOnce(() => acknowledgement.promise);
    const refreshing = w.refreshBuffer(path);
    replace(w, "new local draft\n");
    expect(w.buffers[path].revision).toBe(0);
    read.resolve({ ...initial(), text: "stale native result\n", revision: 1, savedRevision: 1 });
    await refreshing;
    expect(w.documents()[path].document.toString()).toBe("new local draft\n");
    expect(w.dirty(path)).toBe(true);
    expect(w.buffers[path].revision).toBe(0);
    acknowledgement.resolve({ path, revision: 1, savedRevision: 0 });
    await vi.waitFor(() => expect(w.synchronized(path)).toBe(true));
    expect(w.documents()[path].document.toString()).toBe("new local draft\n");
  });
  it("rejects a held snapshot after the same file is opened in a different workspace", async () => {
    const w = await setup(), read = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementationOnce(() => read.promise);
    const refreshing = w.refreshBuffer(path);
    await w.openWorkspace("/replacement");
    server = { ...initial(), text: "replacement workspace\n" }; await w.openFile(path);
    read.resolve({ ...initial(), text: "old workspace\n", revision: 3, savedRevision: 3 });
    await refreshing;
    expect(w.workspace()?.root).toBe("/replacement");
    expect(w.documents()[path].document.toString()).toBe("replacement workspace\n");
    expect(w.buffers[path].revision).toBe(0);
    expect(w.error()).toBe("");
  });
  it("retains a newer accepted native refresh if an earlier read resolves later", async () => {
    const w = await setup(), first = deferred<BufferSnapshot>(), second = deferred<BufferSnapshot>();
    client.openBuffer.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const oldRefresh = w.refreshBuffer(path), newRefresh = w.refreshBuffer(path);
    second.resolve({ ...initial(), text: "new branch\n", revision: 2, savedRevision: 2 }); await newRefresh;
    first.resolve({ ...initial(), text: "old branch\n", revision: 1, savedRevision: 1 }); await oldRefresh;
    expect(w.documents()[path].document.toString()).toBe("new branch\n");
    expect(w.buffers[path].revision).toBe(2);
  });
  it("refuses to read an already dirty buffer", async () => {
    const w = await setup(); replace(w, "local draft\n");
    const reads = client.openBuffer.mock.calls.length;
    await w.refreshBuffer(path);
    expect(client.openBuffer).toHaveBeenCalledTimes(reads);
    expect(w.documents()[path].document.toString()).toBe("local draft\n");
    expect(w.error()).toContain("unsaved changes");
  });
  it("preserves valid saved undo history when a native refresh has identical text", async () => {
    const w = await setup(); replace(w, "two\n");
    expect(await w.save(path)).toBe(true);
    server = { ...server, revision: 2, savedRevision: 2 };
    await w.refreshBuffer(path);
    w.applyHistory(path);
    await vi.waitFor(() => expect(w.buffers[path].revision).toBe(3));
    expect(w.documents()[path].document.toString()).toBe("one\n");
    expect(w.dirty(path)).toBe(true);
  });
  it("discards saved edit history when branch content changes, so Undo cannot apply an unrelated old edit", async () => {
    const w = await setup(); replace(w, "two\n");
    expect(await w.save(path)).toBe(true);
    server = { ...initial(), text: "new\n", revision: 2, savedRevision: 2 };
    await w.refreshBuffer(path);
    const writes = client.editBuffer.mock.calls.length;
    w.applyHistory(path); await Promise.resolve();
    expect(w.documents()[path].document.toString()).toBe("new\n");
    expect(client.editBuffer).toHaveBeenCalledTimes(writes);
    expect(w.dirty(path)).toBe(false);
  });
});
