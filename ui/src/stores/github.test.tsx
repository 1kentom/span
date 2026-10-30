// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { GitContext_Serialize, GitHubItem_Serialize as Item, GitHubRead, GitHubRepository, GitHubResponse_Serialize, GitHubStatus } from "../bindings";
import type { GitWorkbench } from "./git";
vi.mock("../lib/client", () => ({ api: {} }));
import { createGitHubWorkbench } from "./github";
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const repository = (remoteName = "origin"): GitHubRepository => ({ host: "github.com", owner: remoteName === "origin" ? "team" : "other", name: "editor", remoteName });
const item = (number = 12): Item => ({ number, title: `Change ${number}`, body: "Description", state: "OPEN", url: `https://github.com/team/editor/pull/${number}`, author: { login: "author" }, baseRefName: "main", headRefName: "feature", headRefOid: "a".repeat(40), isDraft: false, reviewDecision: "", statusCheckRollup: [], reviews: [], comments: [], files: [], changedFiles: 31, additions: 3, deletions: 2, nameWithOwner: "", defaultBranchRef: null, description: null, isPrivate: false, filename: "", patch: null, previous_filename: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  return createRoot(dispose => {
    disposers.push(dispose);
    const [id, setId] = createSignal("workspace-a"); const [generation, setGeneration] = createSignal(1); const [active, setActive] = createSignal(false); const [contextPoll, setContextPoll] = createSignal(0);
    const context = (): GitContext_Serialize => { contextPoll(); return ({ enabled: true, workspaceRoot: "/workspace", unavailableReason: null, repository: { id: id(), root: "/workspace", workspacePrefix: "", branch: "feature", head: "b".repeat(40), detached: false, unborn: false } }); };
    const git = { context, status: () => ({ repository: context().repository! }), operation: () => undefined } as unknown as GitWorkbench;
    const transport = {
      githubRepositories: vi.fn(async () => [repository(), repository("upstream")]),
      githubStatus: vi.fn(async (_id: string, name: string): Promise<GitHubStatus> => ({ available: true, authenticated: true, message: "Connected", repository: repository(name) })),
      githubRead: vi.fn(async (_id: string, _name: string, request: GitHubRead): Promise<GitHubResponse_Serialize> => ({ items: request.kind === "pullRequestFiles" ? [] : request.kind === "repository" ? [{ ...item(), defaultBranchRef: { name: "trunk" }, nameWithOwner: "team/editor" }] : [item()] })),
      githubCreatePullRequest: vi.fn(async () => "https://github.com/team/editor/pull/13"),
      githubReviewPullRequest: vi.fn(async () => "Review submitted"),
    };
    const github = createGitHubWorkbench({ git, active, generation, transport });
    return { github, transport, setId, setGeneration, setActive, setContextPoll };
  });
}
describe("repository-scoped GitHub workbench", () => {
  it("only reads when activated and never creates or reviews automatically", async () => {
    const f = fixture(); expect(f.transport.githubRepositories).not.toHaveBeenCalled();
    f.setActive(true); await vi.waitFor(() => expect(f.github.items()).toHaveLength(1));
    expect(f.transport.githubRead).toHaveBeenCalledWith("workspace-a", "origin", { kind: "pullRequests", state: "open", limit: 50 }, repository());
    expect(f.transport.githubCreatePullRequest).not.toHaveBeenCalled(); expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled();
  });
  it("preserves loaded and selected GitHub data when Git polls a new context object with the same identity", async () => {
    const f = fixture(); await f.github.load(); await f.github.detail(item());
    const selected=f.github.selected(); const items=f.github.items(); const calls=f.transport.githubRepositories.mock.calls.length;
    f.setContextPoll(1);
    await Promise.resolve();
    expect(f.github.selected()).toBe(selected); expect(f.github.detailsLoaded()).toBe(true); expect(f.github.items()).toBe(items); expect(f.github.remote()).toBe("origin");
    expect(f.transport.githubRepositories).toHaveBeenCalledTimes(calls);
  });
  it("drops a read response after the workspace generation changes", async () => {
    const f = fixture(); const old = deferred<GitHubResponse_Serialize>(); f.transport.githubRead.mockReturnValueOnce(old.promise);
    const pending = f.github.load(); await vi.waitFor(() => expect(f.transport.githubRead).toHaveBeenCalled());
    f.setId("workspace-b"); f.setGeneration(2); await f.github.load();
    old.resolve({ items: [item(99)] }); await pending;
    expect(f.github.items().map(value => value.number)).toEqual([12]); expect(f.github.error()).toBe("");
  });
  it("drops a previous remote's pending detail response", async () => {
    const f = fixture(); await f.github.load(); const old = deferred<GitHubResponse_Serialize>(); f.transport.githubRead.mockReturnValueOnce(old.promise);
    const pending = f.github.detail(item()); await f.github.chooseRemote("upstream");
    old.resolve({ items: [item(99)] }); await pending;
    expect(f.github.remote()).toBe("upstream"); expect(f.github.selected()).toBeUndefined();
    expect(f.github.items().map(value => value.number)).toEqual([12]);
  });
  it("retires loading flags and drops old patches when switching remotes", async () => {
    const f = fixture(); await f.github.load(); await f.github.detail(item());
    const old = deferred<GitHubResponse_Serialize>(); f.transport.githubRead.mockReturnValueOnce(old.promise);
    const pending = f.github.loadFiles(); expect(f.github.filesLoading()).toBe(true);
    await f.github.chooseRemote("upstream");
    expect(f.github.filesLoading()).toBe(false);
    await f.github.detail(item());
    old.resolve({ items: [{ ...item(), filename: "old-remote.rs", patch: "+stale" }] }); await pending;
    expect(f.github.files()).toEqual([]); expect(f.github.selected()?.number).toBe(12);
    await f.github.loadFiles();
    expect(f.transport.githubRead).toHaveBeenLastCalledWith("workspace-a", "upstream", { kind: "pullRequestFiles", number: 12, expectedHead: "a".repeat(40), page: 1 }, repository("upstream"));
  });
  it.each([{ available: false, message: "Install GitHub CLI (gh) to connect" }, { available: true, message: "Run gh auth login in a terminal and retry" }])("does not read hosted data when authentication is unavailable ($available)", async unavailable => {
    const f = fixture(); f.transport.githubStatus.mockResolvedValue({ ...unavailable, authenticated: false, repository: repository() });
    await f.github.load(); expect(f.github.status()?.message).toBe(unavailable.message); expect(f.github.ready()).toBe(false);
    expect(f.transport.githubRead).not.toHaveBeenCalled(); expect(f.github.items()).toEqual([]);
  });
  it("keeps unsupported remotes explicit and never invokes gh status or reads", async () => {
    const f = fixture(); f.transport.githubRepositories.mockResolvedValue([]); await f.github.load();
    expect(f.github.repositories()).toEqual([]); expect(f.github.remote()).toBe(""); expect(f.github.status()).toBeUndefined();
    expect(f.transport.githubStatus).not.toHaveBeenCalled(); expect(f.transport.githubRead).not.toHaveBeenCalled();
  });
  it("marks the full current-branch payload loaded and clears it on a workspace generation change", async () => {
    const f = fixture(); await f.github.load(); await f.github.currentBranch();
    expect(f.github.selected()?.number).toBe(12); expect(f.github.detailsLoaded()).toBe(true);
    f.setGeneration(2); expect(f.github.detailsLoaded()).toBe(false); expect(f.github.selected()).toBeUndefined();
  });
  it("blocks reviews and patches until details have successfully loaded", async () => {
    const f = fixture(); await f.github.load(); f.transport.githubRead.mockRejectedValueOnce(new Error("Details unavailable"));
    await f.github.detail(item()); expect(f.github.detailsLoaded()).toBe(false);
    const reads=f.transport.githubRead.mock.calls.length;
    expect(await f.github.review("approve", "")).toBe(false); await f.github.loadFiles();
    expect(f.transport.githubReviewPullRequest).not.toHaveBeenCalled(); expect(f.transport.githubRead).toHaveBeenCalledTimes(reads);
    await f.github.detail(item()); expect(f.github.detailsLoaded()).toBe(true);
    await f.github.chooseRemote("upstream"); expect(f.github.detailsLoaded()).toBe(false);
  });
  it("binds explicit review submission to the displayed PR head", async () => {
    const f = fixture(); await f.github.load(); await f.github.detail(item());
    expect(await f.github.review("requestChanges", "Please revise")).toBe(true);
    expect(f.transport.githubReviewPullRequest).toHaveBeenCalledExactlyOnceWith("workspace-a", "origin", { number: 12, expectedHead: "a".repeat(40), event: "requestChanges", body: "Please revise" }, repository());
  });
  it("loads patches one page at a time and appends the next page", async () => {
    const f = fixture(); await f.github.load(); await f.github.detail(item());
    const page = Array.from({ length: 30 }, (_, index) => ({ ...item(), filename: `file-${index}.rs`, patch: "@@ -1 +1 @@\n-old\n+new" }));
    f.transport.githubRead.mockResolvedValueOnce({ items: page }); await f.github.loadFiles();
    expect(f.github.moreFiles()).toBe(true); expect(f.github.filePage()).toBe(1);
    f.transport.githubRead.mockResolvedValueOnce({ items: [{ ...item(), filename: "binary.png", patch: null }] }); await f.github.loadFiles(true);
    expect(f.transport.githubRead).toHaveBeenLastCalledWith("workspace-a", "origin", { kind: "pullRequestFiles", number: 12, expectedHead: "a".repeat(40), page: 2 }, repository());
    expect(f.github.files()).toHaveLength(31); expect(f.github.files()[30].patch).toBeNull(); expect(f.github.moreFiles()).toBe(false);
  });
});
