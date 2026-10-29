// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { GitContext, GitStatus_Serialize, GitDiff_Serialize, GitIntegrationState_Serialize } from "../../bindings";
vi.mock("../../lib/client", () => ({ api: {} }));
import { createGitWorkbench } from "../../stores/git";
import { createGitView } from "../../stores/git-view";
import { GitSourceControl } from "./GitSourceControl";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const context: GitContext = { workspaceRoot: "/repo", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "", branch: "main", head: "a".repeat(40), detached: false, unborn: false }, unavailableReason: null };
const status: GitStatus_Serialize = { repository: { id: "repo", root: "/repo", workspacePrefix: "", branch: "main", head: "a".repeat(40), detached: false, unborn: false }, entries: [], indexRevision: "index", stagedSnapshot: "tree", operation: null, truncated: false };
const patch: GitDiff_Serialize = { repositoryId: "repo", path: "file.ts", oldPath: null, side: "working", indexRevision: "index", oldText: "before", newText: "after", patch: "@@ -1 +1 @@\n-before\n+after\n", binary: false, truncated: false, summary: null, commitId: null };
const state: GitIntegrationState_Serialize = { status, worktreeSnapshot: "saved-resolution" };
const branch = { name: "feature/test", remote: false, current: false, upstream: null, ahead: 0, behind: 0, commitId: "b".repeat(40) };
function fixture() {
  const storage = new Map<string, string>();
  const transport = {
    gitContext: vi.fn(async () => context), gitEnable: vi.fn(async () => status), gitStatus: vi.fn(async () => status), gitDiff: vi.fn(), gitHistory: vi.fn(), gitCommitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitCommit: vi.fn(),
    gitBranches: vi.fn(async () => [branch]), gitCheckout: vi.fn(async () => ({ ...status, repository: { ...status.repository, branch: branch.name, head: branch.commitId } })),
    gitRemotes: vi.fn(async () => ({ remotes: [{ name: "origin", current: true, fetchUrl: "https://example.test/repo", pushUrl: "https://example.test/repo" }], configFingerprint: "config" })), gitRemote: vi.fn(async () => ({ status, output: "Remote updated" })),
    gitStashes: vi.fn(async () => [{ id: "c".repeat(40), selector: "stash@{0}", subject: "Saved work" }]), gitStash: vi.fn(async () => ({ status, output: "Changes restored" })),
    gitWorktrees: vi.fn(async () => [{ path: "/repo", branch: "main", head: "a".repeat(40), bare: false, locked: false, prunable: false }, { path: "/other", branch: "feature/test", head: "b".repeat(40), bare: false, locked: false, prunable: false }]),
    gitWorktreeAdd: vi.fn(async () => ({ status, output: "Added worktree" })), gitWorktreeRemove: vi.fn(async () => ({ status, output: "Removed worktree" })),
    gitHunkDiff: vi.fn(async () => ({ diff: patch, worktreeSnapshot: "disk", hunks: [{ id: "hunk-id", header: "@@ -1 +1 @@", patch: patch.patch }] })), gitApplyHunk: vi.fn(async () => status),
    gitIntegrationState: vi.fn(async () => state), gitRebase: vi.fn(async () => ({ state, completed: true, output: "Rebased" })), gitRebaseControl: vi.fn(async () => ({ state, completed: true, output: "Rebase finished" })), gitMarkResolved: vi.fn(async () => state), gitDiscardFile: vi.fn(async () => ({ state, recoveryPath: "/private/git/span-recovery/file.ts.bak" })),
    gitTags: vi.fn(async () => [{ name: "v1", objectId: "d".repeat(40), targetId: "a".repeat(40), annotated: false }]), gitCreateTag: vi.fn(async () => []), gitDeleteTag: vi.fn(async () => []), gitMergeFastForward: vi.fn(async () => ({ status, output: "Fast-forwarded" })),
  };
  const openFile = vi.fn();
  const before = vi.fn(() => true); const reload = vi.fn(async () => undefined);
  const [root, setRoot] = createSignal("/repo"); const [generation, setGeneration] = createSignal(1);
  const { git, view } = createRoot(dispose => { disposers.push(dispose); return { git: createGitWorkbench({ root, generation, active: () => false, blocked: () => false, available: true, transport, onOpenView: vi.fn(), onOpenFile: openFile, beforeWorkingTreeChange: before, onWorkingTreeChange: reload }), view: createGitView({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }) }; });
  const host = document.createElement("div"); document.body.append(host);
  const mount = () => disposers.push(render(() => <GitSourceControl git={git} view={view} available active />, host));
  return { git, view, host, mount, transport, before, reload, openFile, setRoot, setGeneration };
}
const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
it("loads repository lists only when opened and switches branches with a disk-change guard", async () => {
  const f = fixture(); await f.git.refresh(); f.mount();
  expect(f.transport.gitBranches).not.toHaveBeenCalled();
  f.view.setSubView("branches");
  await vi.waitFor(() => expect(f.host.textContent).toContain(branch.name));
  f.before.mockReturnValueOnce(false); button(f.host, "Switch to feature/test").click();
  expect(f.transport.gitCheckout).not.toHaveBeenCalled();
  button(f.host, "Switch to feature/test").click();
  await vi.waitFor(() => expect(f.transport.gitCheckout).toHaveBeenCalledExactlyOnceWith(context, "feature/test", false, "index"));
  await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce()); expect(f.git.context()?.repository?.branch).toBe("feature/test");
});
it("applies a stash by immutable ID and keeps destructive ordinal stash actions absent", async () => {
  const f = fixture(); await f.git.refresh(); f.view.setSubView("stashes"); f.mount();
  await vi.waitFor(() => expect(f.host.textContent).toContain("Saved work"));
  expect(f.host.querySelector('[aria-label="Drop stash@{0}"]')).toBeNull();
  button(f.host, "Apply stash@{0}").click();
  await vi.waitFor(() => expect(f.transport.gitStash).toHaveBeenCalledWith(context, "apply", "c".repeat(40), null, "index"));
  await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
});
it("requires inline confirmation before removing a separate worktree", async () => {
  const f = fixture(); await f.git.refresh(); f.view.setSubView("worktrees"); f.mount();
  await vi.waitFor(() => expect(f.host.textContent).toContain("/other"));
  expect(f.host.querySelector('[aria-label="Remove worktree /repo"]')).toBeNull();
  button(f.host, "Remove worktree /other").click();
  expect(f.transport.gitWorktreeRemove).not.toHaveBeenCalled();
  const group = f.host.querySelector('[aria-label="Confirm worktree removal"]')!;
  [...group.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Remove worktree")!.click();
  await vi.waitFor(() => expect(f.transport.gitWorktreeRemove).toHaveBeenCalledWith(context, "/other"));
});
it("merges only the reviewed immutable target and confirms tag deletion with its object ID", async () => {
  const f = fixture(); await f.git.refresh(); f.view.setSubView("branches"); f.mount();
  await vi.waitFor(() => expect(f.host.textContent).toContain("v1"));
  button(f.host, "Fast-forward merge feature/test").click(); expect(f.transport.gitMergeFastForward).not.toHaveBeenCalled();
  const merge = f.host.querySelector('[aria-label="Confirm fast-forward merge of feature/test"]')!;
  [...merge.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Fast-forward merge")!.click();
  await vi.waitFor(() => expect(f.transport.gitMergeFastForward).toHaveBeenCalledWith(context, branch.commitId, "index"));
  await vi.waitFor(() => expect(button(f.host, "Delete local tag v1")?.disabled).toBe(false));
  button(f.host, "Delete local tag v1").click(); expect(f.transport.gitDeleteTag).not.toHaveBeenCalled();
  const confirm = f.host.querySelector('[aria-label="Confirm deletion of local tag v1"]')!;
  [...confirm.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Delete local tag")!.click();
  await vi.waitFor(() => expect(f.transport.gitDeleteTag).toHaveBeenCalledWith(context, "v1", "d".repeat(40)));
});
it("keeps failed operation drafts visible and requires explicit remote actions", async () => {
  const f = fixture(); await f.git.refresh(); f.mount();
  f.git.setMessage("Keep this draft"); expect(f.transport.gitRemote).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.git.remotes()).toBeDefined());
  f.transport.gitRemote.mockRejectedValueOnce(new Error("Authentication required"));
  [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Push")!.click();
  await vi.waitFor(() => expect(f.host.textContent).toContain("Authentication required"));
  expect(f.git.message()).toBe("Keep this draft"); expect(f.reload).not.toHaveBeenCalled();
});
it("preserves commit drafts per workspace and across workspace generations", () => {
  const f = fixture(); f.git.setMessage("First draft"); f.setRoot("/other"); f.setGeneration(2);
  expect(f.git.message()).toBe(""); f.git.setMessage("Second draft");
  f.setRoot("/repo"); f.setGeneration(3); expect(f.git.message()).toBe("First draft");
  f.setGeneration(4); expect(f.git.message()).toBe("First draft");
});

it("stages only a reviewed hunk with both index and disk snapshot tokens", async () => {
  const f = fixture(); await f.git.refresh(); f.transport.gitDiff.mockResolvedValue(patch);
  f.git.openDiff("file.ts", "working");
  await vi.waitFor(() => expect(Object.values(f.git.views())[0]?.hunkData).toBeDefined());
  const key = Object.keys(f.git.views())[0];
  await f.git.applyHunk(key, "hunk-id");
  expect(f.transport.gitApplyHunk).toHaveBeenCalledWith(context, "file.ts", "working", "hunk-id", "index", "disk");
  expect(f.transport.gitStage).not.toHaveBeenCalled();
});
it("starts a rebase only after confirming the immutable reviewed branch tip", async () => {
  const f = fixture(); await f.git.refresh(); f.view.setSubView("branches"); f.mount();
  await vi.waitFor(() => expect(button(f.host, "Rebase onto feature/test")).not.toBeNull());
  button(f.host, "Rebase onto feature/test").click(); expect(f.transport.gitRebase).not.toHaveBeenCalled();
  const group = f.host.querySelector('[aria-label="Confirm rebase onto feature/test"]')!;
  [...group.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Start rebase")!.click();
  await vi.waitFor(() => expect(f.transport.gitRebase).toHaveBeenCalledWith(context, branch.commitId, "index"));
  await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
});
it("opens conflict files and stages saved resolutions using a freshly reviewed snapshot", async () => {
  const f = fixture();
  const conflicted: GitStatus_Serialize = { ...status, operation: "rebase", entries: [{ id: "file", path: "file.ts", displayPath: "file.ts", oldPath: null, displayOldPath: null, indexStatus: "U", worktreeStatus: "U", untracked: false, conflicted: true, submodule: false, unsupportedReason: null }] };
  f.transport.gitStatus.mockResolvedValue(conflicted);
  f.transport.gitIntegrationState.mockResolvedValue({ ...state, status: conflicted });
  f.transport.gitMarkResolved.mockResolvedValue({ ...state, status: { ...status, operation: "rebase" } });
  await f.git.refresh(); f.mount();
  expect(f.host.textContent).toContain("Rebase in progress");
  button(f.host, "Open conflict file file.ts").click(); expect(f.openFile).toHaveBeenCalledWith("file.ts");
  button(f.host, "Mark file.ts resolved").click();
  await vi.waitFor(() => expect(f.transport.gitMarkResolved).toHaveBeenCalledWith(context, "file.ts", "index", "saved-resolution"));
  expect(f.before).toHaveBeenCalledWith("mark resolved");
  await vi.waitFor(() => expect(f.reload).toHaveBeenCalledOnce());
  expect(f.git.status()?.entries.some(entry => entry.conflicted)).toBe(false);
});
it("requires an explicit rebase abort confirmation before discarding saved resolutions", async () => {
  const f = fixture(); f.transport.gitStatus.mockResolvedValue({ ...status, operation: "rebase" });
  f.transport.gitIntegrationState.mockResolvedValue({ ...state, status: { ...status, operation: "rebase" } });
  await f.git.refresh(); f.mount();
  [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Abort rebase…")!.click();
  expect(f.transport.gitRebaseControl).not.toHaveBeenCalled();
  const group = f.host.querySelector('[aria-label="Confirm rebase abort"]')!;
  [...group.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Abort rebase")!.click();
  await vi.waitFor(() => expect(f.transport.gitRebaseControl).toHaveBeenCalledWith(context, "abort", "index", "saved-resolution"));
});

it("confirms saved-file discard and shows the retained recovery location", async () => {
  const f = fixture(); const modified: GitStatus_Serialize = { ...status, entries: [{ id: "file", path: "file.ts", displayPath: "file.ts", oldPath: null, displayOldPath: null, indexStatus: ".", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null }] };
  f.transport.gitStatus.mockResolvedValue(modified); f.transport.gitIntegrationState.mockResolvedValue({ ...state, status: modified });
  await f.git.refresh(); f.mount();
  button(f.host, "Discard saved changes in file.ts").click(); expect(f.transport.gitDiscardFile).not.toHaveBeenCalled();
  const group = f.host.querySelector('[aria-label="Confirm discard of file.ts"]')!;
  const confirmButton = [...group.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Discard saved changes")!; confirmButton.focus(); confirmButton.click();
  await vi.waitFor(() => expect(f.transport.gitDiscardFile).toHaveBeenCalledWith(context, "file.ts", "index", "saved-resolution"));
  await vi.waitFor(() => expect(f.host.textContent).toContain("/private/git/span-recovery/file.ts.bak"));
  expect(f.before).toHaveBeenCalledWith("discard file");
  await vi.waitFor(() => expect(document.activeElement).toBe(f.host.querySelector(".git-commit-message")));
});
it("binds network operations to the reviewed remote configuration and retains failures across polling", async () => {
  const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes");
  f.transport.gitRemote.mockRejectedValueOnce(new Error("Authentication required"));
  await f.git.remote("push"); expect(f.transport.gitRemote).toHaveBeenCalledWith(context, "push", "config");
  await f.git.refresh(); expect(f.git.error()).toBe("Authentication required");
});
it("ignores a repository resource reply from before a branch mutation", async () => {
  const f = fixture(); await f.git.refresh();
  let resolve!: (value: typeof branch[]) => void;
  f.transport.gitBranches.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
  const old = f.git.loadResource("branches"); await f.git.checkout(branch.name);
  f.transport.gitBranches.mockResolvedValueOnce([{ ...branch, name: "new-branch" }]); await f.git.loadResource("branches");
  resolve([{ ...branch, name: "outdated-branch" }]); await old;
  expect(f.git.branches()?.map(branch => branch.name)).toEqual(["new-branch"]);
});
it("polls status without multiplying repository resource reads", async () => {
  const f = fixture(); await f.git.refresh(); f.view.setSubView("branches"); f.mount();
  await vi.waitFor(() => expect(f.git.branches()).toBeDefined());
  await f.git.refresh(); await f.git.refresh();
  expect(f.transport.gitBranches).toHaveBeenCalledTimes(1); expect(f.transport.gitTags).toHaveBeenCalledTimes(1); expect(f.transport.gitRemotes).toHaveBeenCalledTimes(1);
});
