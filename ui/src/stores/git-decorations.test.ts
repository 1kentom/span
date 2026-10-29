import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitContext, GitFileBaseline_Serialize, GitStatus } from "../bindings";
vi.mock("../lib/client", () => ({ api: {} }));
import { createGitDecorations } from "./git-decorations";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
const context: GitContext = { workspaceRoot: "/repo/project", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "project", branch: "main", head: "head-1", detached: false, unborn: false }, unavailableReason: null };
const status: GitStatus = { repository: context.repository!, indexRevision: "index-1", stagedSnapshot: "tree", entries: [], operation: null, truncated: false };
const baseline = (text = "saved", revision = "index-1"): GitFileBaseline_Serialize => ({ repositoryId: "repo", path: "project/file.ts", indexRevision: revision, headText: "committed", indexText: text, binary: false, truncated: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(enabled = true) {
  return createRoot(dispose => {
    disposers.push(dispose);
    const [ctx, setContext] = createSignal<GitContext>({ ...context, enabled });
    const [snapshot, setStatus] = createSignal<GitStatus>(status);
    const [generation, setGeneration] = createSignal(1);
    const [paths, setPaths] = createSignal(["file.ts"]);
    const [dirty, setDirty] = createSignal<string[]>([]);
    const transport = { gitFileBaseline: vi.fn(async () => baseline()) };
    const store = createGitDecorations({ git: { context: ctx, status: snapshot }, generation, paths, dirtyPaths: dirty, available: true, transport });
    return { store, transport, setContext, setStatus, setGeneration, setPaths, setDirty };
  });
}

describe("repository-scoped decoration baselines", () => {
  it("does no native reads or dirty-file decoration before Git consent", async () => {
    const f = setup(false); f.setDirty(["file.ts"]);
    await Promise.resolve();
    expect(f.transport.gitFileBaseline).not.toHaveBeenCalled();
    expect(f.store.status("file.ts")).toBeUndefined();
    f.setContext(context);
    await vi.waitFor(() => expect(f.store.baseline("file.ts")?.indexText).toBe("saved"));
    expect(f.transport.gitFileBaseline).toHaveBeenCalledWith(context, "project/file.ts");
    expect(f.store.status("file.ts")?.label).toContain("unsaved");
  });
  it("rejects late responses after a workspace generation changes even in the same repository", async () => {
    const f = setup(false), old = deferred<GitFileBaseline_Serialize>();
    f.transport.gitFileBaseline.mockImplementationOnce(() => old.promise);
    f.setContext(context);
    await vi.waitFor(() => expect(f.transport.gitFileBaseline).toHaveBeenCalledTimes(1));
    f.setGeneration(2);
    await vi.waitFor(() => expect(f.store.baseline("file.ts")?.indexText).toBe("saved"));
    old.resolve(baseline("old workspace response")); await Promise.resolve();
    expect(f.store.baseline("file.ts")?.indexText).toBe("saved");
  });
  it("invalidates baselines on staging or HEAD movement, and rejects an index revision race", async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.store.baseline("file.ts")).toBeDefined());
    f.transport.gitFileBaseline.mockResolvedValueOnce(baseline("staged", "index-2"));
    f.setStatus({ ...status, indexRevision: "index-2" });
    await vi.waitFor(() => expect(f.store.baseline("file.ts")?.indexText).toBe("staged"));
    f.transport.gitFileBaseline.mockResolvedValueOnce(baseline("racing index", "index-3"));
    f.setStatus({ ...status, indexRevision: "index-2", repository: { ...status.repository, head: "head-2" } });
    await vi.waitFor(() => expect(f.transport.gitFileBaseline).toHaveBeenCalledTimes(3));
    expect(f.store.baseline("file.ts")).toBeUndefined();
  });
  it("reuses immutable index text when worktree status or dirty editor content changes", async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.store.baseline("file.ts")).toBeDefined());
    f.setStatus({ ...status }); f.setDirty(["file.ts"]); f.setDirty([]);
    await Promise.resolve();
    expect(f.transport.gitFileBaseline).toHaveBeenCalledTimes(1);
  });
  it("clears fetched baselines when Git consent resets", async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.store.baseline("file.ts")).toBeDefined());
    f.setContext({ ...context, enabled: false });
    await vi.waitFor(() => expect(f.store.baseline("file.ts")).toBeUndefined());
    expect(f.store.status("file.ts")).toBeUndefined();
  });
});
