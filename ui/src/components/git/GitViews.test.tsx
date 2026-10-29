// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type JSX, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { GitCommit, GitCommitResult, GitContext, GitDiff, GitHistoryPage, GitStatus } from "../../bindings";
vi.mock("../../lib/client", () => ({ api: {} }));
import { createGitWorkbench } from "../../stores/git";
import { GitPanel } from "./GitPanel";
import { GitDiffView } from "./GitDiffView";
import { GitHistory } from "./GitHistory";
const dispose: (() => void)[] = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); document.body.replaceChildren(); });
const context: GitContext = { workspaceRoot: "/repo/project", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "project", branch: "feature/test", head: "a".repeat(40), detached: false, unborn: false }, unavailableReason: null };
const entry = { id: "outside", path: "outside/file.ts", displayPath: "outside/file.ts", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null };
const status: GitStatus = { repository: context.repository!, entries: [entry], indexRevision: "index", stagedSnapshot: "tree", operation: null, truncated: false };
const commit: GitCommit = { id: "b".repeat(40), parents: [], author: "Author", authorEmail: "author@example.test", timestamp: 1700000000, subject: "Reviewed commit", body: "Reviewed commit\n\nDetails" };
function fixture(available = true) {
  const transport = { gitContext: vi.fn(async () => context), gitEnable: vi.fn(async () => status), gitStatus: vi.fn(async () => status), gitDiff: vi.fn(), gitHistory: vi.fn(async (): Promise<GitHistoryPage> => ({ repositoryId: "repo", commits: [commit], anchor: commit.id, nextSkip: null })), gitCommitDiff: vi.fn(), gitStage: vi.fn(async () => status), gitUnstage: vi.fn(async () => status), gitCommit: vi.fn(async (): Promise<GitCommitResult> => ({ commitId: commit.id, commit, warning: null, status: { ...status, entries: [] } })) };
  const onOpenView = vi.fn();
  const git = createRoot(cleanup => { dispose.push(cleanup); return createGitWorkbench({ root: () => "/repo/project", generation: () => 1, active: () => false, blocked: () => false, available, transport, onOpenView }); });
  const host = document.createElement("div"); document.body.append(host);
  const mount = (node: () => JSX.Element) => dispose.push(render(node, host));
  return { git, transport, onOpenView, host, mount };
}
it("shows repository scope and requires an explicit inline enable before exposing Git actions", async () => {
  const f = fixture(); f.transport.gitContext.mockResolvedValueOnce({ ...context, enabled: false });
  await f.git.refresh(); f.mount(() => <GitPanel git={f.git} available />);
  expect(f.host.textContent).toContain("/repo"); expect(f.host.textContent).toContain("filters and hooks");
  expect(f.transport.gitStatus).not.toHaveBeenCalled();
  expect(f.host.querySelector('[aria-label="Git commit message"]')).toBeNull();
  f.host.querySelector<HTMLButtonElement>('[aria-label="Enable Git"]')!.click();
  await vi.waitFor(() => expect(f.host.querySelector('[aria-label="Git commit message"]')).not.toBeNull());
  expect(f.transport.gitEnable).toHaveBeenCalledWith({ ...context, enabled: false });
});
it("does not offer file history for Git or settings virtual view identifiers", async () => {
  const f = fixture(); await f.git.refresh();
  const [path, setPath] = createSignal("span:git:working:diff");
  f.mount(() => <GitHistory git={f.git} available active={false} filePath={path()} />);
  const fileButton = [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "This file")!;
  for (const virtual of ["span:git:working:diff", "span:settings", "settings://user", "settings://workspace"]) { setPath(virtual); expect(fileButton.disabled).toBe(true); }
  expect(f.transport.gitHistory).not.toHaveBeenCalled(); setPath("src/main.ts"); expect(fileButton.disabled).toBe(false);
});
it("shows the actual repository and every staged/working outside-folder entry with explicit actions", async () => {
  const f = fixture(); await f.git.refresh(); f.mount(() => <GitPanel git={f.git} available />);
  expect(f.host.textContent).toContain("/repo"); expect(f.host.textContent).toContain("feature/test"); expect(f.host.textContent).toContain("whole repository");
  expect(f.host.querySelectorAll('[aria-label="Review staged changes in outside/file.ts"]')).toHaveLength(1);
  expect(f.host.querySelectorAll('[aria-label="Review working changes in outside/file.ts"]')).toHaveLength(1);
  f.host.querySelector<HTMLButtonElement>('[aria-label="Unstage outside/file.ts"]')!.click();
  await vi.waitFor(() => expect(f.transport.gitUnstage).toHaveBeenCalledWith(context, ["outside/file.ts"], "index"));
  expect(f.transport.gitCommit).not.toHaveBeenCalled();
});
it("preserves keyboard focus when status refresh returns new objects for the same files", async () => {
  const f = fixture(); await f.git.refresh(); f.mount(() => <GitPanel git={f.git} available />);
  const row = f.host.querySelector<HTMLButtonElement>('[aria-label="Review working changes in outside/file.ts"]')!;
  row.focus(); f.transport.gitStatus.mockResolvedValueOnce(structuredClone(status)); await f.git.refresh();
  expect(row.isConnected).toBe(true); expect(document.activeElement).toBe(row);
});
it("keeps a rejected commit draft, retries explicitly and never stages implicitly", async () => {
  const f = fixture(); await f.git.refresh(); f.transport.gitCommit.mockRejectedValueOnce(new Error("Signing failed")); f.mount(() => <GitPanel git={f.git} available />);
  const textarea = f.host.querySelector<HTMLTextAreaElement>('[aria-label="Git commit message"]')!;
  textarea.value = "Retained message"; textarea.dispatchEvent(new Event("input", { bubbles: true }));
  const button = () => [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.includes("Commit 1 staged file"))!;
  button().click(); await vi.waitFor(() => expect(f.host.textContent).toContain("Signing failed")); expect(textarea.value).toBe("Retained message");
  for (const [index, extra] of [{ isComposing: true }, { repeat: true }, {}].entries()) {
    const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true, ...extra });
    if (index === 2) event.preventDefault();
    textarea.dispatchEvent(event);
  }
  expect(f.transport.gitCommit).toHaveBeenCalledTimes(1);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(f.host.textContent).toContain("Committed bbbbbbbb")); expect(textarea.value).toBe(""); expect(f.transport.gitStage).not.toHaveBeenCalled();
});
it("renders escaped patch text and disables working-file access outside the opened folder", () => {
  const f = fixture(); const open = vi.fn();
  const diff: GitDiff = { repositoryId: "repo", path: "outside/file.ts", oldPath: null, side: "staged", indexRevision: "index", oldText: null, newText: null, patch: "@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>", binary: false, truncated: false, summary: null, commitId: null };
  f.mount(() => <GitDiffView title="file.ts (Staged)" diff={diff} loading={false} outsideWorkspace repositoryRoot="/repo" onRefresh={open} />);
  expect(f.host.textContent).toContain("HEAD compared with index"); expect(f.host.textContent).toContain("<img src=x onerror=alert(1)>"); expect(f.host.querySelector("img")).toBeNull();
  const button = [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Open working file")!;
  expect(button.disabled).toBe(true); expect(f.host.textContent).toContain("outside the opened folder"); expect(f.host.querySelector('[contenteditable="true"]')).toBeNull();
});
it("shows saved untracked text when native Git returns newText without a patch", () => {
  const f = fixture();
  const diff: GitDiff = { repositoryId: "repo", path: "new.txt", oldPath: null, side: "working", indexRevision: "index", oldText: null, newText: "new saved content\nsecond line\n", patch: "", binary: false, truncated: false, summary: "Untracked file", commitId: null };
  f.mount(() => <GitDiffView title="new.txt (Working)" diff={diff} loading={false} onRefresh={() => undefined} />);
  expect(f.host.textContent).toContain("new saved content"); expect(f.host.textContent).toContain("second line");
  expect(f.host.textContent).not.toContain("No changes in this comparison");
});
it("distinguishes unchanged text from an untracked empty file", () => {
  const f = fixture();
  const diff: GitDiff = { repositoryId: "repo", path: "same.txt", oldPath: null, side: "working", indexRevision: "index", oldText: "same", newText: "same", patch: "", binary: false, truncated: false, summary: null, commitId: null };
  f.mount(() => <GitDiffView title="same.txt" diff={diff} loading={false} onRefresh={() => undefined} />);
  expect(f.host.textContent).toContain("No changes in this comparison"); expect(f.host.querySelector(".git-patch")).toBeNull();
});
it("shows binary/partial comparisons honestly and pages long text without dropping the retained patch", () => {
  const f = fixture(); const diff: GitDiff = { repositoryId: "repo", path: "image.png", oldPath: null, side: "working", indexRevision: "index", oldText: null, newText: null, patch: "", binary: true, truncated: true, summary: "Binary change", commitId: null };
  f.mount(() => <GitDiffView title="image.png" diff={diff} loading={false} onRefresh={() => undefined} />);
  expect(f.host.textContent).toContain("Binary file changed"); expect(f.host.textContent).toContain("partial preview");
});
it("opens immutable commit diffs from real paged history without branch mutations", async () => {
  const f = fixture(); await f.git.refresh(); f.mount(() => <GitHistory git={f.git} available active filePath="src/main.ts" />);
  await vi.waitFor(() => expect(f.host.textContent).toContain("Reviewed commit"));
  f.host.querySelector<HTMLButtonElement>('[aria-label="Review commit bbbbbbbb: Reviewed commit"]')!.click();
  await vi.waitFor(() => expect(f.transport.gitCommitDiff).toHaveBeenCalledWith(context, commit.id, null));
  expect(f.transport.gitStage).not.toHaveBeenCalled(); expect(f.transport.gitCommit).not.toHaveBeenCalled();
});
it("keeps history readable for a valid Git timestamp outside the JavaScript Date range", async () => {
  const f = fixture(); await f.git.refresh();
  f.transport.gitHistory.mockResolvedValueOnce({ repositoryId: "repo", commits: [{ ...commit, timestamp: 8640000000001 }], anchor: commit.id, nextSkip: null });
  f.mount(() => <GitHistory git={f.git} available active />);
  await vi.waitFor(() => expect(f.host.textContent).toContain("Unknown date"));
  expect(f.host.querySelector("time")?.getAttribute("datetime")).toBeNull();
  expect(f.host.querySelector("time")?.title).toContain("8640000000001");
});
it("shows preview unavailability and never invokes Git", async () => {
  const f = fixture(false); f.mount(() => <GitPanel git={f.git} available={false} />);
  expect(f.host.textContent).toContain("Browser preview does not run Git"); expect(f.transport.gitContext).not.toHaveBeenCalled();
});
