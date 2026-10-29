import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitCommit, GitCommitResult, GitContext, GitDiff, GitHistoryPage, GitStatus } from "../bindings";
vi.mock("../lib/client", () => ({ api: {} }));
import { createGitWorkbench, workspaceGitPath } from "./git";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
const commit: GitCommit = { id: "a".repeat(40), parents: [], author: "Author", authorEmail: "author@example.test", timestamp: 1_700_000_000, subject: "A change", body: "A change\n\nBody" };
const context = (root = "/repo/project", id = "repo-a"): GitContext => ({ workspaceRoot: root, enabled: true, repository: { id, root: "/repo", workspacePrefix: "project", branch: "main", head: "b".repeat(40), detached: false, unborn: false }, unavailableReason: null });
const status = (ctx = context()): GitStatus => ({ repository: ctx.repository!, indexRevision: "index-1", stagedSnapshot: "tree-1", entries: [{ id: "file", path: "outside/file.ts", displayPath: "outside/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null }], operation: null, truncated: false });
const diff = (patch: string): GitDiff => ({ repositoryId: "repo-a", path: "outside/file.ts", oldPath: null, side: "working", indexRevision: "index-1", oldText: "before", newText: "after", patch, binary: false, truncated: false, summary: null, commitId: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(available = true) {
  return createRoot(dispose => {
    disposers.push(dispose);
    const [root, setRoot] = createSignal("/repo/project"); const [generation, setGeneration] = createSignal(1);
    const [active, setActive] = createSignal(false);
    const transport = {
      gitContext: vi.fn(async () => context(root(), generation() === 1 ? "repo-a" : "repo-b")),
      gitEnable: vi.fn(async () => status()),
      gitStatus: vi.fn(async (ctx: GitContext) => status(ctx)), gitDiff: vi.fn(async () => diff("patch")),
      gitHistory: vi.fn(async (): Promise<GitHistoryPage> => ({ repositoryId: "repo-a", anchor: "b".repeat(40), commits: [commit], nextSkip: null })),
      gitCommitDiff: vi.fn(async () => ({ ...diff("history patch"), side: "commit" as const, commitId: commit.id })),
      gitStage: vi.fn(async () => ({ ...status(), indexRevision: "index-2" })), gitUnstage: vi.fn(async () => status()),
      gitCommit: vi.fn(async (): Promise<GitCommitResult> => ({ commitId: commit.id, commit, warning: null, status: { ...status(), entries: [] } })),
    };
    const onOpenView = vi.fn();
    const git = createGitWorkbench({ root, generation, active, blocked: () => false, available, transport, onOpenView });
    return { git, transport, onOpenView, setRoot, setGeneration, setActive };
  });
}

describe("repository-scoped Git workbench", () => {
  it("does not run status, history, diffs, polling or mutations before explicit session enablement", async () => {
    const f = fixture(); f.transport.gitContext.mockResolvedValue({ ...context(), enabled: false });
    vi.useFakeTimers(); f.setActive(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.transport.gitContext).toHaveBeenCalledTimes(1);
    await f.git.loadHistory(); f.git.openDiff("outside/file.ts", "working");
    expect(await f.git.commit()).toBe(false); expect(await f.git.stage([status().entries[0]])).toBe(false);
    expect(f.transport.gitStatus).not.toHaveBeenCalled(); expect(f.transport.gitHistory).not.toHaveBeenCalled();
    expect(f.transport.gitDiff).not.toHaveBeenCalled(); expect(f.transport.gitStage).not.toHaveBeenCalled();
    expect(await f.git.enable()).toBe(true);
    expect(f.transport.gitEnable).toHaveBeenCalledWith({ ...context(), enabled: false });
    expect(f.git.context()?.enabled).toBe(true); expect(f.git.status()?.repository.root).toBe("/repo");
    await f.git.loadHistory(); expect(f.transport.gitHistory).toHaveBeenCalledTimes(1);
  });
  it("ignores late enablement after a workspace switch and requires new explicit activation", async () => {
    const f = fixture(); f.transport.gitContext.mockResolvedValueOnce({ ...context(), enabled: false });
    await f.git.refresh(); const delayed = deferred<GitStatus>(); f.transport.gitEnable.mockReturnValueOnce(delayed.promise);
    const enabling = f.git.enable(); f.setGeneration(2);
    f.transport.gitContext.mockResolvedValueOnce({ ...context("/repo/project", "repo-b"), enabled: false }); await f.git.refresh();
    delayed.resolve(status()); expect(await enabling).toBe(false); expect(f.git.context()?.enabled).toBe(false);
    expect(f.git.status()).toBeUndefined(); expect(f.git.operation()).toBeUndefined();
  });
  it("keeps outside-folder status entries in both index and working lists, but constrains editor paths", async () => {
    const f = fixture(); await f.git.refresh();
    expect(f.git.staged()[0].path).toBe("outside/file.ts"); expect(f.git.changed()[0].path).toBe("outside/file.ts");
    expect(workspaceGitPath(f.git.context(), "outside/file.ts")).toBeUndefined();
    expect(workspaceGitPath(f.git.context(), "project/src/App.ts")).toBe("src/App.ts");
    await f.git.stage(f.git.changed()); expect(f.transport.gitStage).toHaveBeenCalledWith(context(), ["outside/file.ts"], "index-1");
    expect(f.transport.gitCommit).not.toHaveBeenCalled();
  });
  it("commits only the staged snapshot and preserves errors, message and status for retry", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Reviewed staged changes");
    f.transport.gitCommit.mockRejectedValueOnce(new Error("Commit hook failed"));
    expect(await f.git.commit()).toBe(false); expect(f.git.message()).toBe("Reviewed staged changes"); expect(f.git.error()).toBe("Commit hook failed");
    expect(f.git.status()?.indexRevision).toBe("index-1"); expect(f.transport.gitStage).not.toHaveBeenCalled();
    expect(await f.git.commit()).toBe(true);
    expect(f.transport.gitCommit).toHaveBeenLastCalledWith(context(), "Reviewed staged changes", "index-1", "tree-1");
    expect(f.git.message()).toBe(""); expect(f.git.notice()).toContain(commit.id.slice(0, 8));
  });
  it("reports a post-commit warning as success without offering a duplicate retry", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Committed message");
    f.transport.gitCommit.mockResolvedValueOnce({ commitId: commit.id, commit, status: { ...status(), entries: [] }, warning: "Post-commit hook timed out" });
    expect(await f.git.commit()).toBe(true); expect(f.git.message()).toBe("");
    expect(f.git.error()).toBe(""); expect(f.git.notice()).toContain("Committed aaaaaaaa");
    expect(f.git.warning()).toBe("Post-commit hook timed out"); expect(f.transport.gitCommit).toHaveBeenCalledTimes(1);
  });
  it("retains a successful commit receipt when post-commit status is unavailable", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Actual commit");
    f.transport.gitCommit.mockResolvedValueOnce({ commitId: commit.id, commit, status: null, warning: "The commit was created; status refresh failed" });
    f.transport.gitStatus.mockRejectedValueOnce(new Error("Status temporarily unavailable"));
    expect(await f.git.commit()).toBe(true); expect(f.git.message()).toBe(""); expect(f.git.status()).toBeUndefined();
    expect(f.git.notice()).toContain("Committed aaaaaaaa"); expect(f.git.warning()).toContain("commit was created");
    await vi.waitFor(() => expect(f.git.error()).toBe("Status temporarily unavailable"));
    expect(f.git.canCommit()).toBe(false); expect(f.transport.gitCommit).toHaveBeenCalledTimes(1);
  });
  it("runs mutations once, and never clears a newer unsent message after commit success", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Commit A");
    const pending = deferred<GitCommitResult>(); f.transport.gitCommit.mockReturnValueOnce(pending.promise);
    const first = f.git.commit(); expect(await f.git.commit()).toBe(false); f.git.setMessage("Next unsent commit B");
    pending.resolve({ commitId: commit.id, commit, warning: null, status: status() }); await first;
    expect(f.git.message()).toBe("Next unsent commit B"); expect(f.transport.gitCommit).toHaveBeenCalledTimes(1);
  });
  it("preserves an edited message even when its text returns to the submitted value", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Same text");
    const pending = deferred<GitCommitResult>(); f.transport.gitCommit.mockReturnValueOnce(pending.promise);
    const committing = f.git.commit(); f.git.setMessage("New draft"); f.git.setMessage("Same text");
    pending.resolve({ commitId: commit.id, commit, status: status(), warning: null }); await committing;
    expect(f.git.message()).toBe("Same text");
  });
  it("shows the actual committed ID if metadata and status refresh both fail", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Actual commit");
    f.transport.gitCommit.mockResolvedValueOnce({ commitId: commit.id, commit: null, status: null, warning: "Metadata unavailable after commit" });
    f.transport.gitStatus.mockRejectedValueOnce(new Error("Status unavailable"));
    expect(await f.git.commit()).toBe(true); expect(f.git.message()).toBe("");
    expect(f.git.notice()).toBe("Committed aaaaaaaa"); expect(f.git.warning()).toContain("Metadata unavailable");
    await vi.waitFor(() => expect(f.git.status()).toBeUndefined()); expect(f.transport.gitCommit).toHaveBeenCalledTimes(1);
  });
  it("rejects old workspace context, mutation and comparison responses without altering new state", async () => {
    const f = fixture(); const oldContext = deferred<GitContext>(); f.transport.gitContext.mockReturnValueOnce(oldContext.promise);
    const first = f.git.refresh(); f.setRoot("/repo/other"); f.setGeneration(2); await f.git.refresh();
    oldContext.resolve(context()); await first; expect(f.git.context()?.workspaceRoot).toBe("/repo/other");
    f.git.setMessage("New workspace message"); expect(f.git.context()?.repository?.id).toBe("repo-b");
    expect(f.git.views()).toEqual({});
  });
  it("cannot mutate an old status if the native repository context changed and refresh failed", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Review old index");
    f.transport.gitContext.mockResolvedValueOnce(context("/repo/project", "replacement-repo"));
    f.transport.gitStatus.mockRejectedValueOnce(new Error("Repository is temporarily unavailable"));
    await f.git.refresh();
    expect(f.git.status()).toBeUndefined(); expect(f.git.ready()).toBe(false);
    expect(await f.git.commit()).toBe(false); expect(await f.git.stage([status().entries[0]])).toBe(false);
    expect(f.transport.gitCommit).not.toHaveBeenCalled(); expect(f.transport.gitStage).not.toHaveBeenCalled();
    expect(f.git.message()).toBe("Review old index");
  });
  it("preserves the new workspace draft if an old commit completes after switching", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Old message");
    const pending = deferred<GitCommitResult>(); f.transport.gitCommit.mockReturnValueOnce(pending.promise);
    const first = f.git.commit(); f.setGeneration(2); await f.git.refresh(); f.git.setMessage("New draft");
    pending.resolve({ commitId: commit.id, commit, warning: null, status: status() }); expect(await first).toBe(false);
    expect(f.git.message()).toBe("New draft"); expect(f.git.status()?.repository.id).toBe("repo-b"); expect(f.git.notice()).toBe("");
  });
  it("ignores stale diff results and keeps the earlier read-only snapshot on refresh errors", async () => {
    const f = fixture(); await f.git.refresh();
    const a = deferred<GitDiff>(); const b = deferred<GitDiff>(); f.transport.gitDiff.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    f.git.openDiff("outside/file.ts", "working"); f.git.openDiff("outside/file.ts", "working");
    b.resolve(diff("newer")); await vi.waitFor(() => expect(Object.values(f.git.views())[0].diff?.patch).toBe("newer"));
    a.resolve(diff("stale")); await Promise.resolve(); expect(Object.values(f.git.views())[0].diff?.patch).toBe("newer");
    const view = Object.values(f.git.views())[0]; f.transport.gitDiff.mockRejectedValueOnce(new Error("Index changed")); await f.git.refreshView(view.key);
    expect(f.git.views()[view.key].error).toBe("Index changed"); expect(f.git.views()[view.key].diff?.patch).toBe("newer");
    expect(f.onOpenView).toHaveBeenCalledWith(view.key, "file.ts (Working)");
  });
  it("pages history from a stable anchor and lets a newer scope replace a pending query", async () => {
    const f = fixture(); await f.git.refresh();
    f.transport.gitHistory.mockResolvedValueOnce({ repositoryId: "repo-a", anchor: commit.id, commits: [commit], nextSkip: 50 });
    await f.git.loadHistory("project/file.ts");
    f.transport.gitHistory.mockResolvedValueOnce({ repositoryId: "repo-a", anchor: commit.id, commits: [{ ...commit, id: "c".repeat(40) }], nextSkip: null });
    await f.git.loadHistory("project/file.ts", true);
    expect(f.transport.gitHistory).toHaveBeenLastCalledWith(context(), { anchor: commit.id, skip: 50, limit: 50, path: "project/file.ts" }); expect(f.git.history()?.commits).toHaveLength(2);
    const old = deferred<Awaited<ReturnType<typeof f.transport.gitHistory>>>(); f.transport.gitHistory.mockReturnValueOnce(old.promise);
    const pending = f.git.loadHistory("project/old.ts"); await f.git.loadHistory(null);
    old.resolve({ repositoryId: "repo-a", anchor: commit.id, commits: [{ ...commit, subject: "stale" }], nextSkip: null }); await pending;
    expect(f.git.historyPath()).toBeUndefined(); expect(f.git.history()?.commits[0].subject).toBe("A change");
  });
  it("releases obsolete history loading state when a commit invalidates a pending page", async () => {
    const f = fixture(); await f.git.refresh();
    const old = deferred<GitHistoryPage>(); f.transport.gitHistory.mockReturnValueOnce(old.promise);
    const pending = f.git.loadHistory(); expect(f.git.historyLoading()).toBe(true);
    f.git.setMessage("Commit during history read"); expect(await f.git.commit()).toBe(true);
    expect(f.git.historyLoading()).toBe(false); expect(f.git.history()).toBeUndefined();
    old.resolve({ repositoryId: "repo-a", anchor: "old-head", commits: [commit], nextSkip: null }); await pending;
    expect(f.git.history()).toBeUndefined(); expect(f.git.historyLoading()).toBe(false);
    await f.git.loadHistory(); expect(f.git.history()?.anchor).toBe("b".repeat(40));
  });
  it("blocks commit when conflict, repository operation or truncated status prevents complete review", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("message");
    for (const unsafe of [{ ...status(), truncated: true }, { ...status(), operation: "merge" }, { ...status(), entries: [{ ...status().entries[0], conflicted: true }] }]) {
      f.transport.gitStatus.mockResolvedValueOnce(unsafe); await f.git.refresh(); expect(f.git.canCommit()).toBe(false); expect(await f.git.commit()).toBe(false);
    }
    expect(f.transport.gitCommit).not.toHaveBeenCalled();
  });
  it("does not run native Git in browser preview", async () => {
    const f = fixture(false); await f.git.refresh(); await f.git.commit(); expect(f.transport.gitContext).not.toHaveBeenCalled(); expect(f.transport.gitCommit).not.toHaveBeenCalled();
  });
});
