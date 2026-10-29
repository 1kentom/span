// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import type { GitContext_Serialize, GitHubItem_Serialize as Item, GitHubRead, GitHubRepository, GitHubResponse_Serialize, GitHubStatus } from "../../bindings";
import type { GitWorkbench } from "../../stores/git";
vi.mock("../../lib/client", () => ({ api: {} }));
import { createGitHubWorkbench } from "../../stores/github";
import { GitHubPanel } from "./GitHubPanel";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
const repository: GitHubRepository = { host: "github.com", owner: "team", name: "editor", remoteName: "origin" };
const item = (): Item => ({ number: 12, title: "Reviewed change", body: "PR description", state: "OPEN", url: "https://github.com/team/editor/pull/12", author: { login: "author" }, baseRefName: "main", headRefName: "feature", headRefOid: "a".repeat(40), isDraft: false, reviewDecision: "", statusCheckRollup: [], reviews: [], comments: [], files: [], changedFiles: 31, additions: 3, deletions: 2, nameWithOwner: "", defaultBranchRef: null, description: null, isPrivate: false, filename: "", patch: null, previous_filename: null });
async function fixture(state: "connected" | "missing" | "signedOut" | "unsupported" = "connected") {
  const context: GitContext_Serialize = { workspaceRoot: "/workspace", enabled: true, unavailableReason: null, repository: { id: "workspace-a", root: "/workspace", workspacePrefix: "", branch: "feature", head: "b".repeat(40), detached: false, unborn: false } };
  const checkoutPullRequest = vi.fn(async () => true);
  const git = { context: () => context, status: () => ({ repository: context.repository }), operation: () => undefined, error: () => "", ready: () => true, checkoutPullRequest } as unknown as GitWorkbench;
  const transport = {
    githubRepositories: vi.fn(async () => state === "unsupported" ? [] : [repository]),
    githubStatus: vi.fn(async (): Promise<GitHubStatus> => ({ available: state !== "missing", authenticated: state === "connected", message: state === "missing" ? "Install GitHub CLI (gh) to connect" : state === "signedOut" ? "GitHub authentication unavailable" : "Connected using GitHub CLI", repository })),
    githubRead: vi.fn(async (_id: string, _remote: string, request: GitHubRead): Promise<GitHubResponse_Serialize> => ({ items: request.kind === "pullRequestFiles" ? [] : request.kind === "repository" ? [{ ...item(), defaultBranchRef: { name: "trunk" }, nameWithOwner: "team/editor" }] : [item()] })),
    githubCreatePullRequest: vi.fn(async () => "https://github.com/team/editor/pull/13"), githubReviewPullRequest: vi.fn(async () => "Review submitted"),
  };
  const github = createRoot(dispose => { disposers.push(dispose); return createGitHubWorkbench({ git, active: () => false, generation: () => 1, transport }); });
  await github.load();
  const host = document.createElement("div"); document.body.append(host); const onOpenUrl = vi.fn();
  disposers.push(render(() => <GitHubPanel github={github} git={git} onOpenUrl={onOpenUrl} />, host));
  return { github, transport, checkoutPullRequest, host, onOpenUrl };
}
function button(host: HTMLElement, label: string): HTMLButtonElement { const found = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === label); if (!found) throw new Error(`Missing button: ${label}`); return found; }
function input(host: HTMLElement, id: string, value: string) { const node = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!; node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); }
function submit(node: Element) { node.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }

describe("GitHub panel explicit actions", () => {
  it("opening the panel and PR details never creates, reviews, checks out, or opens a browser", async () => {
    const f = await fixture(); button(f.host, "Reviewed change#12 · author");
    await f.github.detail(item());
    expect(f.host.textContent).toContain("PR description");
    expect(f.transport.githubCreatePullRequest).not.toHaveBeenCalled(); expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled(); expect(f.checkoutPullRequest).not.toHaveBeenCalled(); expect(f.onOpenUrl).not.toHaveBeenCalled();
  });
  it.each(["missing", "signedOut", "unsupported"] as const)("shows honest %s connection instructions without mutation controls", async state => {
    const f = await fixture(state);
    expect(f.host.textContent).toContain(state === "unsupported" ? "No GitHub remote" : state === "missing" ? "Install GitHub CLI" : "GitHub authentication unavailable");
    if (state !== "unsupported") expect(f.host.textContent).toContain("gh auth login --hostname github.com");
    expect(f.host.textContent).not.toContain("New pull request"); expect(f.transport.githubRead).not.toHaveBeenCalled();
    expect(f.transport.githubCreatePullRequest).not.toHaveBeenCalled(); expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled();
  });
  it("does not invent detail counts after a failed read and retries the selected item in the displayed repository", async () => {
    const f = await fixture(); const listCalls=f.transport.githubRepositories.mock.calls.length;
    f.transport.githubRead.mockRejectedValueOnce(new Error("Temporary GitHub failure")); await f.github.detail(item());
    expect(f.github.detailsLoaded()).toBe(false); expect(f.host.textContent).toContain("Reviewed change");
    expect(f.host.textContent).toContain("Details are unavailable");
    for (const text of ["No checks reported", "Checks (0)", "Changed files (", "Conversation (", "Review submission", "Check out pull request"]) expect(f.host.textContent).not.toContain(text);
    button(f.host, "Retry read").click();
    await vi.waitFor(() => expect(f.github.detailsLoaded()).toBe(true));
    expect(f.transport.githubRead).toHaveBeenLastCalledWith("workspace-a", "origin", {kind:"pullRequest",number:12}, repository);
    expect(f.transport.githubRepositories).toHaveBeenCalledTimes(listCalls);
    expect(f.host.textContent).toContain("No checks reported");
    expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled(); expect(f.checkoutPullRequest).not.toHaveBeenCalled();
  });
  it("preserves the review draft across a failed refresh and explicit detail retry", async () => {
    const f = await fixture(); await f.github.detail(item()); input(f.host,"github-review-body","Keep my unsent review");
    f.transport.githubRead.mockRejectedValueOnce(new Error("Read interrupted")); await f.github.detail(f.github.selected()!);
    expect(f.host.textContent).toContain("Details are unavailable"); expect(f.github.selected()?.title).toBe("Reviewed change");
    button(f.host,"Retry read").click(); await vi.waitFor(() => expect(f.github.detailsLoaded()).toBe(true));
    expect(f.host.querySelector<HTMLTextAreaElement>("#github-review-body")?.value).toBe("Keep my unsent review");
    expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled();
  });
  it("preserves an explicitly submitted PR draft after the hosted create fails", async () => {
    const f = await fixture(); f.transport.githubCreatePullRequest.mockRejectedValueOnce(new Error("Network unavailable. Refresh before retrying"));
    button(f.host, "New pull request").click(); input(f.host, "github-pr-title", "Keep this title"); input(f.host, "github-pr-body", "Keep this description");
    expect(f.transport.githubCreatePullRequest).not.toHaveBeenCalled();
    submit(button(f.host, "Create pull request"));
    await vi.waitFor(() => expect(f.host.querySelector('[role="alert"]')?.textContent).toContain("Network unavailable"));
    expect(f.transport.githubCreatePullRequest).toHaveBeenCalledExactlyOnceWith("workspace-a", "origin", { title: "Keep this title", body: "Keep this description", base: "trunk", head: "feature", draft: true }, repository);
    expect(f.host.querySelector<HTMLInputElement>("#github-pr-title")?.value).toBe("Keep this title"); expect(f.host.querySelector<HTMLTextAreaElement>("#github-pr-body")?.value).toBe("Keep this description");
  });
  it("requires a separate publish confirmation and submits the displayed commit head", async () => {
    const f = await fixture(); await f.github.detail(item()); input(f.host, "github-review-body", "Please revise this line");
    submit(button(f.host, "Review submission"));
    expect(f.host.textContent).toContain("Publish this comment for commit aaaaaaaa to GitHub?"); expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled();
    button(f.host, "Submit review").click();
    await vi.waitFor(() => expect(f.transport.githubReviewPullRequest).toHaveBeenCalledExactlyOnceWith("workspace-a", "origin", { number: 12, expectedHead: "a".repeat(40), event: "comment", body: "Please revise this line" }, repository));
  });
  it("invalidates a publish confirmation when refreshed details change the displayed head", async () => {
    const f = await fixture(); await f.github.detail(item()); input(f.host, "github-review-body", "Review of the previous commit");
    submit(button(f.host, "Review submission")); expect(f.host.textContent).toContain("Publish this comment for commit aaaaaaaa");
    f.transport.githubRead.mockResolvedValueOnce({ items: [{ ...item(), headRefOid: "c".repeat(40) }] }); await f.github.detail(item());
    expect(f.github.detailLoading()).toBe(false); expect(f.host.textContent).toContain("cccccccccccc");
    expect(f.host.textContent).not.toContain("Publish this comment"); expect([...f.host.querySelectorAll("button")].some(node => node.textContent === "Submit review")).toBe(false);
    expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled();
  });
  it("requires explicit checkout and forwards the remote, PR number, immutable head and chosen new branch", async () => {
    const f = await fixture(); await f.github.detail(item()); button(f.host, "Check out pull request").click();
    expect(f.checkoutPullRequest).not.toHaveBeenCalled(); input(f.host, "github-checkout-branch", "review/pr-12"); submit(button(f.host, "Fetch and check out"));
    await vi.waitFor(() => expect(f.checkoutPullRequest).toHaveBeenCalledExactlyOnceWith("origin", 12, "a".repeat(40), "review/pr-12"));
  });
  it("shows paged patches, distinguishes missing text patches, and loads the next page explicitly", async () => {
    const f = await fixture(); await f.github.detail(item());
    const files = Array.from({ length: 30 }, (_, index) => ({ ...item(), filename: index === 0 ? "image.png" : `file-${index}.rs`, patch: index === 0 ? null : "@@ -1 +1 @@\n-old\n+new" }));
    f.transport.githubRead.mockResolvedValueOnce({ items: files }); button(f.host, "Load file patches").click();
    await vi.waitFor(() => expect(f.host.textContent).toContain("GitHub did not provide a text patch for this file"));
    expect(f.host.textContent).toContain("+new"); expect(f.transport.githubRead).toHaveBeenLastCalledWith("workspace-a", "origin", { kind: "pullRequestFiles", number: 12, expectedHead: "a".repeat(40), page: 1 }, repository);
    f.transport.githubRead.mockResolvedValueOnce({ items: [{ ...item(), filename: "last.rs", patch: "+last" }] }); button(f.host, "Load next 30 files").click();
    await vi.waitFor(() => expect(f.host.textContent).toContain("last.rs"));
    expect(f.transport.githubRead).toHaveBeenLastCalledWith("workspace-a", "origin", { kind: "pullRequestFiles", number: 12, expectedHead: "a".repeat(40), page: 2 }, repository); expect(f.host.textContent).not.toContain("Load next 30 files");
  });
});
