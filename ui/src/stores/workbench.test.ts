import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeSet } from "@codemirror/state";
import type { BufferSnapshot, TextEdit } from "../bindings";

const client = vi.hoisted(() => ({
  openWorkspace: vi.fn(), listDirectory: vi.fn(), listFiles: vi.fn(), getSettings: vi.fn(),
  openBuffer: vi.fn(), editBuffer: vi.fn(), saveBuffer: vi.fn(), discardBuffer: vi.fn(),
}));
vi.mock("../lib/client", () => ({ api: client, isDesktop: true }));
import { createWorkbench } from "./workbench";

const initial = (): BufferSnapshot => ({ path: "src/file.ts", text: "const value = 1;\n", revision: 0, savedRevision: 0, language: "typescript" });
let server: Map<string, BufferSnapshot>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const workbench = createWorkbench();
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
  client.getSettings.mockResolvedValue({ theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false });
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
