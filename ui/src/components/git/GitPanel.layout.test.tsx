// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import type { GitContext_Serialize as GitContext, GitStatus_Serialize as GitStatus } from "../../bindings";
vi.mock("../../lib/client", () => ({ api: {} }));
import { createGitWorkbench } from "../../stores/git";
import { GitPanel } from "./GitPanel";
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); });
async function fixture(enabled = true, clean = false) {
  const context: GitContext = { workspaceRoot: "/work/span", enabled, unavailableReason: null, repository: { id: "repo", root: "/work/span", workspacePrefix: "", branch: "main", head: "a".repeat(40), detached: false, unborn: false } };
  const status: GitStatus = { repository: context.repository!, indexRevision: "index", stagedSnapshot: "tree", operation: null, truncated: false, entries: clean ? [] : [{ id: "file", path: "ui/src/App.tsx", displayPath: "ui/src/App.tsx", oldPath: null, displayOldPath: null, indexStatus: "M", worktreeStatus: "M", untracked: false, conflicted: false, submodule: false, unsupportedReason: null }] };
  const transport = { gitContext: vi.fn(async () => context), gitStatus: vi.fn(async () => status), gitEnable: vi.fn(async () => status), gitDiff: vi.fn(), gitHistory: vi.fn(), gitCommitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitCommit: vi.fn(), gitAmend: vi.fn() };
  const git = createRoot(dispose => { cleanups.push(dispose); return createGitWorkbench({ root: () => context.workspaceRoot!, generation: () => 1, active: () => false, blocked: () => false, available: true, transport, onOpenView: vi.fn() }); });
  await git.refresh();
  const host = document.createElement("div"); document.body.append(host); cleanups.push(render(() => <GitPanel git={git} available />, host));
  return { host, git };
}
it("keeps repository identity compact after enable while showing the full root before consent", async () => {
  const enabled = await fixture();
  expect(enabled.host.querySelector(".git-repo-identity strong")?.textContent).toBe("span");
  expect(enabled.host.querySelector(".git-repo-identity")?.getAttribute("title")).toBe("/work/span");
  expect(enabled.host.querySelector(".git-repo-branch")?.textContent).toBe("main");
  expect(enabled.host.querySelector(".git-repo-path")).toBeNull();
  const consent = await fixture(false);
  expect(consent.host.querySelector(".git-repo-path")?.textContent).toBe("/work/span");
  expect(consent.host.textContent).toContain("Git can run filters and hooks");
});
it("uses a two-row composer, concise submit and explicit commit options without hiding amend warnings", async () => {
  const { host, git } = await fixture();
  expect(host.querySelector("textarea")?.rows).toBe(2);
  expect(host.querySelector("textarea")?.getAttribute("aria-label")).toBe("Git commit message");
  expect(host.querySelector('[aria-label="Commit 1 staged file"]')?.textContent).toBe("Commit1");
  expect(host.querySelector(".git-commit-hint")?.textContent).toBe("Staged changes only");
  const options = host.querySelector<HTMLDetailsElement>(".git-commit-options")!;
  expect(options.open).toBe(false); expect(options.querySelector("summary")?.textContent).toBe("Commit options");
  git.setAmend(true);
  expect(host.textContent).toContain("No force push runs automatically");
  expect(options.textContent).not.toContain("No force push");
});
it("splits filenames from directories and reserves aligned action slots outside the review button", async () => {
  const { host } = await fixture();
  const row = host.querySelector(".git-change-row")!;
  expect(row.querySelector(".git-change-name")?.textContent).toBe("App.tsx");
  expect(row.querySelector(".git-change-directory")?.textContent).toBe("ui/src");
  const review = row.querySelector(".git-change-open")!;
  expect(review.getAttribute("aria-label")).toBe("Review staged changes in ui/src/App.tsx");
  expect(review.getAttribute("title")).toBe("ui/src/App.tsx");
  expect(review.querySelector(".git-change-status")).toBeNull();
  expect(row.querySelector(".git-row-actions > .git-row-action-slot")).not.toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>(".git-section-toggle")!;
  toggle.click(); expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("omits empty change sections but retains message-only amend and truthful clean state", async () => {
  const { host, git } = await fixture(true, true);
  expect(host.querySelector(".git-section-heading")).toBeNull();
  expect(host.textContent).toContain("Working tree clean");
  git.setMessage("Message only"); git.setAmend(true);
  expect(git.canCommit()).toBe(true);
});
