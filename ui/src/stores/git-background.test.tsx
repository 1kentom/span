// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitCommit, GitCommitResult, GitContext, GitDiff, GitHistoryPage, GitStatus, GitStatus_Serialize } from "../bindings";
vi.mock("../lib/client", () => ({ api: {} }));
import { createGitWorkbench } from "./git";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const commit: GitCommit = { id: "a".repeat(40), parents: [], author: "Author", authorEmail: "author@example.test", timestamp: 1_700_000_000, subject: "A change", body: "A change\n\nBody" };
const context = (root = "/repo/project", id = "repo-a"): GitContext => ({ workspaceRoot: root, enabled: true, repository: { id, root: "/repo", workspacePrefix: "project", branch: "main", head: "b".repeat(40), detached: false, unborn: false }, unavailableReason: null });
const status = (ctx = context()): GitStatus => ({ repository: ctx.repository!, indexRevision: "index-1", stagedSnapshot: "tree-1", entries: [{ id: "file", path: "outside/file.ts", displayPath: "outside/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null }], operation: null, truncated: false });
const diff = (patch: string): GitDiff => ({ repositoryId: "repo-a", path: "outside/file.ts", oldPath: null, side: "working", indexRevision: "index-1", oldText: "before", newText: "after", patch, binary: false, truncated: false, summary: null, commitId: null });
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
      gitRemotes: vi.fn(async () => ({ remotes: [{ name: "origin", current: true, fetchUrl: "https://example.test/repo", pushUrl: "https://example.test/repo" }], configFingerprint: "reviewed-config" })),
      gitFetchBackground: vi.fn(async () => ({ status: status() as GitStatus_Serialize, output: "Fetched" })),
      gitConfigureRemote: vi.fn(async () => ({ remotes: [], configFingerprint: "new-config" })),
      gitCommit: vi.fn(async (): Promise<GitCommitResult> => ({ commitId: commit.id, commit, warning: null, status: { ...status(), entries: [] } })),
    };
    const onOpenView = vi.fn(); const onWorkingTreeChange = vi.fn();
    const git = createGitWorkbench({ root, generation, active, blocked: () => false, available, transport, onOpenView, onWorkingTreeChange });
    return { git, transport, onOpenView, onWorkingTreeChange, setRoot, setGeneration, setActive };
  });
}


describe("explicit repository background fetch", () => {
  it("requires opt-in, pauses offline and hidden, and stops after an uncertain error", async () => {
    vi.useFakeTimers(); vi.stubGlobal("document", { visibilityState: "visible" }); vi.stubGlobal("navigator", { onLine: true });
    const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes");
    await vi.advanceTimersByTimeAsync(300_000); expect(f.transport.gitFetchBackground).not.toHaveBeenCalled();
    f.git.setAutoFetchEnabled(true); f.git.setAutoFetchMinutes(1); expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.stubGlobal("navigator", { onLine: false }); await vi.advanceTimersByTimeAsync(60_000); expect(f.transport.gitFetchBackground).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { onLine: true }); vi.stubGlobal("document", { visibilityState: "hidden" }); await vi.advanceTimersByTimeAsync(60_000); expect(f.transport.gitFetchBackground).not.toHaveBeenCalled();
    vi.stubGlobal("document", { visibilityState: "visible" }); expect(f.git.autoFetchEnabled()).toBe(true); expect(f.git.ready()).toBe(true); expect(f.git.remotes()?.remotes.length).toBe(1); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.transport.gitFetchBackground).toHaveBeenCalledExactlyOnceWith(context(), "reviewed-config"); expect(f.git.lastFetch()).toBeTypeOf("number");
    f.transport.gitFetchBackground.mockRejectedValueOnce(new Error("Network unavailable")); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.git.autoFetchEnabled()).toBe(false); expect(f.git.autoFetchError()).toBe("Network unavailable");
    await vi.advanceTimersByTimeAsync(300_000); expect(f.transport.gitFetchBackground).toHaveBeenCalledTimes(2);
  });
  it("never carries opt-in into another repository and never retries failed configuration", async () => {
    const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes"); f.git.setAutoFetchEnabled(true);
    f.transport.gitConfigureRemote.mockRejectedValueOnce(new Error("Configuration changed"));
    expect(await f.git.configureRemote("remove", "origin")).toBe(false); expect(f.transport.gitConfigureRemote).toHaveBeenCalledOnce();
    f.setRoot("/different"); f.transport.gitContext.mockResolvedValueOnce({ ...context("/different"), repository: { ...context().repository!, root: "/different" } }); await f.git.refresh();
    expect(f.git.autoFetchEnabled()).toBe(false);
  });
});

it("keeps the editor operation idle and drafts writable while a background fetch is held", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", { visibilityState: "visible" }); vi.stubGlobal("navigator", { onLine: true });
  const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes");
  let finish!: (result: Awaited<ReturnType<typeof f.transport.gitFetchBackground>>) => void;
  f.transport.gitFetchBackground.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  f.git.setAutoFetchEnabled(true); f.git.setAutoFetchMinutes(1); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.git.autoFetching()).toBe(true); expect(f.git.operation()).toBeUndefined(); expect(f.git.ready()).toBe(false); expect(f.git.integrationReady()).toBe(false);
  f.git.setMessage("Typing while fetch runs"); expect(f.git.message()).toBe("Typing while fetch runs");
  const reads = f.transport.gitStatus.mock.calls.length; await f.git.refresh(); await vi.advanceTimersByTimeAsync(10_000); expect(f.transport.gitStatus).toHaveBeenCalledTimes(reads);
  expect(await f.git.stage(f.git.changed())).toBe(false); expect(f.transport.gitStage).not.toHaveBeenCalled();
  finish({ status: status() as GitStatus_Serialize, output: "Fetched" }); await Promise.resolve(); await Promise.resolve();
  expect(f.git.autoFetching()).toBe(false); expect(f.git.ready()).toBe(true); expect(f.git.message()).toBe("Typing while fetch runs"); expect(f.onWorkingTreeChange).not.toHaveBeenCalled();
});
it("drops a held background fetch after workspace replacement", async () => {
  vi.useFakeTimers(); vi.stubGlobal("document", { visibilityState: "visible" }); vi.stubGlobal("navigator", { onLine: true });
  const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes");
  let finish!: (result: Awaited<ReturnType<typeof f.transport.gitFetchBackground>>) => void;
  f.transport.gitFetchBackground.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  f.git.setAutoFetchEnabled(true); f.git.setAutoFetchMinutes(1); await vi.advanceTimersByTimeAsync(60_000);
  f.setRoot("/new"); f.setGeneration(2); await f.git.refresh(); f.git.setMessage("New workspace draft");
  expect(f.git.autoFetching()).toBe(false);
  finish({ status: status() as GitStatus_Serialize, output: "Old result" }); await Promise.resolve(); await Promise.resolve();
  expect(f.git.context()?.repository?.id).toBe("repo-b"); expect(f.git.message()).toBe("New workspace draft"); expect(f.git.lastFetch()).toBeUndefined(); expect(f.git.operation()).toBeUndefined();
});
