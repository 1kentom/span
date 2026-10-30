import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitBlame_Serialize, GitContext, GitStatus } from "../bindings";
vi.mock("../lib/client", () => ({ api: {} }));
import { createGitLineInfo } from "./git-line-info";

const context: GitContext = { workspaceRoot: "/repo/project", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "project", branch: "main", head: "head-1", detached: false, unborn: false }, unavailableReason: null };
const snapshot: GitStatus = { repository: context.repository!, indexRevision: "index-1", stagedSnapshot: "tree", entries: [], operation: null, truncated: false };
const blame = (head = "head-1"): GitBlame_Serialize => ({ repositoryId: "repo", path: "project/file.ts", head, lines: [{ line: 1, originalLine: 1, author: "Author", authorEmail: "author@example.test", commitId: head, timestamp: 1_700_000_000, summary: "A commit" }] });
const disposers: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const settle = async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(200); };
function setup(enabled = true) {
  return createRoot(dispose => {
    disposers.push(dispose);
    const [ctx, setContext] = createSignal<GitContext>({ ...context, enabled });
    const [status, setStatus] = createSignal<GitStatus>(snapshot);
    const [path, setPath] = createSignal<string | undefined>("file.ts");
    const [generation, setGeneration] = createSignal(1);
    const [blocked, setBlocked] = createSignal(false);
    const transport = { gitBlame: vi.fn(async () => blame()) };
    const info = createGitLineInfo({ git: { context: ctx, status }, path, generation, blocked, available: true, transport });
    return { info, transport, setContext, setStatus, setPath, setGeneration, setBlocked };
  });
}

describe("active-file Git attribution", () => {
  it("does not read before Git consent and resolves the repository-relative path after consent", async () => {
    const f = setup(false); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
    f.setContext(context); await settle();
    expect(f.transport.gitBlame).toHaveBeenCalledWith(context, "project/file.ts");
    expect(f.info.blame("file.ts")?.lines[0].author).toBe("Author");
  });
  it("cancels pending reads while toggled off and clears already loaded attribution", async () => {
    const f = setup(); f.info.toggle(); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
    f.info.toggle(); await settle();
    expect(f.info.blame("file.ts")).toBeDefined();
    f.info.toggle();
    expect(f.info.blame("file.ts")).toBeUndefined();
    f.setStatus({ ...snapshot }); await settle();
    expect(f.transport.gitBlame).toHaveBeenCalledTimes(1);
  });
  it("reuses blame across new status snapshots with the same HEAD, including index changes", async () => {
    const f = setup(); await settle();
    const current = f.info.blame("file.ts");
    f.setStatus({ ...snapshot, indexRevision: "index-2" }); await settle();
    f.setContext({ ...context, repository: { ...context.repository! } }); await settle();
    expect(f.transport.gitBlame).toHaveBeenCalledTimes(1);
    expect(f.info.blame("file.ts")).toBe(current);
  });
  it("rejects an old workspace reply even when repository ID, path and HEAD match", async () => {
    const f = setup(), old = deferred<GitBlame_Serialize>();
    f.transport.gitBlame.mockImplementationOnce(() => old.promise); await settle();
    f.setGeneration(2); await settle();
    expect(f.info.blame("file.ts")?.lines[0].author).toBe("Author");
    old.resolve({ ...blame(), lines: [{ ...blame().lines[0], author: "Old workspace" }] }); await settle();
    expect(f.info.blame("file.ts")?.lines[0].author).toBe("Author");
  });
  it("rejects a held old-HEAD reply and an unexpectedly different HEAD returned by the native command", async () => {
    const f = setup(), old = deferred<GitBlame_Serialize>();
    f.transport.gitBlame.mockImplementationOnce(() => old.promise); await settle();
    f.transport.gitBlame.mockResolvedValueOnce(blame("head-2"));
    f.setStatus({ ...snapshot, repository: { ...snapshot.repository, head: "head-2" } }); await settle();
    expect(f.info.blame("file.ts")?.head).toBe("head-2");
    old.resolve(blame()); await settle();
    expect(f.info.blame("file.ts")?.head).toBe("head-2");
    f.transport.gitBlame.mockResolvedValueOnce(blame("unexpected-head"));
    f.setStatus({ ...snapshot, repository: { ...snapshot.repository, head: "head-3" } }); await settle();
    expect(f.info.blame("file.ts")).toBeUndefined();
  });
  it.each(["conflicted", "untracked", "submodule"] as const)("does not blame a %s file", async flag => {
    const f = setup();
    f.setStatus({ ...snapshot, entries: [{ id: "file", path: "project/file.ts", displayPath: "project/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", conflicted: false, untracked: false, submodule: false, unsupportedReason: null, [flag]: true }] });
    await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
    expect(f.info.blame("file.ts")).toBeUndefined();
  });
  it("does not read pseudo-document paths or while a Git operation blocks reads", async () => {
    const f = setup(); f.setBlocked(true); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
    f.setPath("settings://user"); f.setBlocked(false); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
    f.setPath(undefined); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
  });
  it("cancels delayed work on disposal", async () => {
    const f = setup(); disposers.pop()!(); await settle();
    expect(f.transport.gitBlame).not.toHaveBeenCalled();
  });
});
