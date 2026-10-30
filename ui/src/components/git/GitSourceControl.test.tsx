// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type JSX, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { GitCommit, GitContext_Serialize as GitContext, GitHistoryPage, GitStatus_Serialize as GitStatus } from "../../bindings";
vi.mock("../../lib/client", () => ({ api: {} }));
import { createGitWorkbench } from "../../stores/git";
import { GIT_SUBVIEW_KEY, createGitView } from "../../stores/git-view";
import { GitSourceControl } from "./GitSourceControl";

const dispose: (() => void)[] = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); document.body.replaceChildren(); });
const context: GitContext = { workspaceRoot: "/repo/project", enabled: true, repository: { id: "repo", root: "/repo", workspacePrefix: "project", branch: "main", head: "a".repeat(40), detached: false, unborn: false }, unavailableReason: null };
const status: GitStatus = { repository: context.repository!, entries: [], indexRevision: "index", stagedSnapshot: "tree", operation: null, truncated: false };
const commit: GitCommit = { id: "b".repeat(40), parents: [], author: "Author", authorEmail: "author@example.test", timestamp: 1700000000, subject: "First commit", body: "First commit" };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), data };
}

function fixture(storage = memoryStorage()) {
  const transport = { gitRemotes: vi.fn(async () => ({ configFingerprint: "review-1", remotes: [{ name: "origin", fetchUrl: "https://example.test/a", pushUrl: "https://example.test/a", current: true }, { name: "backup", fetchUrl: "https://example.test/b", pushUrl: "https://example.test/b", current: false }] })), gitRemoteSelected: vi.fn(async () => ({ operation: { status, output: "Published" }, remoteSucceeded: true, upstreamConfigured: false, warning: "Upstream could not be saved" })), gitContext: vi.fn(async () => context), gitEnable: vi.fn(async () => status), gitStatus: vi.fn(async () => status), gitDiff: vi.fn(), gitHistory: vi.fn(async (): Promise<GitHistoryPage> => ({ repositoryId: "repo", commits: [commit], anchor: commit.id, nextSkip: null })), gitCommitDiff: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(), gitAmend: vi.fn(async () => ({ commitId: commit.id, commit, warning: null, status })), gitCommit: vi.fn() };
  const { git, view } = createRoot(cleanup => { dispose.push(cleanup); return { git: createGitWorkbench({ root: () => "/repo/project", generation: () => 1, active: () => false, blocked: () => false, available: true, transport, onOpenView: vi.fn() }), view: createGitView(storage) }; });
  const host = document.createElement("div"); document.body.append(host);
  const mount = (node: () => JSX.Element) => dispose.push(render(node, host));
  return { git, view, transport, host, mount, storage };
}
const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const radio = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(node => node.textContent?.trim() === name)!;

describe("Git source control view", () => {
  it("requires explicit amend intent and displays the captured commit for message-only amend", async () => {
    const f = fixture(); await f.git.refresh(); f.git.setMessage("Reviewed replacement");
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active />);
    const amend = [...f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(node => node.parentElement?.textContent?.includes("Amend last commit"))!;
    expect(amend.checked).toBe(false); expect(f.git.canCommit()).toBe(false);
    amend.click(); expect(amend.checked).toBe(true);
    expect(f.host.textContent).toContain("No force push runs automatically");
    const submit = [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Amend aaaaaaaa")!;
    expect(submit.disabled).toBe(false); submit.click();
    await vi.waitFor(() => expect(f.transport.gitAmend).toHaveBeenCalledWith(context, "Reviewed replacement", context.repository!.head, "index", "tree"));
    expect(f.transport.gitCommit).not.toHaveBeenCalled(); expect(f.transport.gitStage).not.toHaveBeenCalled();
  });
  it("keeps selected remote and target after failure and requires another review after partial success", async () => {
    const f = fixture(); await f.git.refresh(); await f.git.loadResource("remotes");
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active />);
    const remote = f.host.querySelector<HTMLSelectElement>("#git-network-remote")!;
    remote.value = "backup"; remote.dispatchEvent(new Event("change", { bubbles: true }));
    const target = f.host.querySelector<HTMLInputElement>("#git-network-branch")!;
    target.value = "publish-here"; target.dispatchEvent(new Event("input", { bubbles: true }));
    const review = [...f.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(node => node.parentElement?.textContent?.includes("I reviewed"))!;
    const push = [...f.host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Push")!;
    expect(push.disabled).toBe(true); review.click();
    f.transport.gitRemoteSelected.mockRejectedValueOnce(new Error("Network unavailable")); push.click();
    await vi.waitFor(() => expect(f.git.error()).toBe("Network unavailable"));
    expect(remote.value).toBe("backup"); expect(target.value).toBe("publish-here");
    push.click(); await vi.waitFor(() => expect(f.git.warning()).toContain("remote action completed"));
    expect(remote.value).toBe("backup"); expect(target.value).toBe("publish-here"); expect(push.disabled).toBe(true);
    expect(f.transport.gitRemoteSelected).toHaveBeenLastCalledWith(context, "push", "backup", "publish-here", "index", "review-1", true);
    expect(f.transport.gitRemoteSelected).toHaveBeenCalledTimes(2);
  });
  it("shows Changes and History sub-views in one panel, defaulting to Changes", async () => {
    const f = fixture(); await f.git.refresh();
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active activePath="src/main.ts" />);
    const list = f.host.querySelector('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Source control view");
    expect(tabs(f.host).map(tab => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([["Changes", "true"], ["History", "false"], ["Branches", "false"], ["Stash", "false"], ["Worktrees", "false"], ["GitHub", "false"]]);
    expect(f.host.querySelectorAll('[aria-label="Refresh Git"]')).toHaveLength(1);
    expect(f.host.querySelector('[aria-label="Git commit message"]')).not.toBeNull();
    expect(f.host.querySelector('[aria-label="Git history"]')).toBeNull();
    tabs(f.host)[1].click();
    await vi.waitFor(() => expect(f.host.textContent).toContain("First commit"));
    expect(f.host.querySelector('[aria-label="Git commit message"]')).toBeNull();
    expect(f.host.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("git-subview-history");
    expect(f.storage.data.get(GIT_SUBVIEW_KEY)).toBe("history");
  });

  it("moves between sub-views with arrow, Home and End keys using roving focus", async () => {
    const f = fixture(); await f.git.refresh();
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active />);
    const [changes, history] = tabs(f.host);
    expect([changes.tabIndex, history.tabIndex]).toEqual([0, -1]);
    changes.focus(); changes.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(f.view.subView()).toBe("history"); expect(document.activeElement).toBe(history); expect([changes.tabIndex, history.tabIndex]).toEqual([-1, 0]);
    history.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(f.view.subView()).toBe("changes"); expect(document.activeElement).toBe(changes);
    changes.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(f.view.subView()).toBe("github");
  });

  it("remembers the last sub-view and still renders when storage throws", () => {
    expect(createRoot(done => { dispose.push(done); return createGitView(memoryStorage({ [GIT_SUBVIEW_KEY]: "history" })).subView(); })).toBe("history");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const view = createRoot(done => { dispose.push(done); return createGitView(broken); });
    expect(view.subView()).toBe("changes"); view.setSubView("history"); expect(view.subView()).toBe("history");
    expect(createRoot(done => { dispose.push(done); return createGitView(undefined).subView(); })).toBe("changes");
  });

  it("opens History scoped to a file from a file action and lets the user switch to All commits", async () => {
    const f = fixture(); await f.git.refresh();
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active activePath="src/other.ts" />);
    f.view.showFileHistory("src/main.ts");
    await vi.waitFor(() => expect(f.transport.gitHistory).toHaveBeenLastCalledWith(context, expect.objectContaining({ path: "project/src/main.ts" })));
    expect(tabs(f.host)[1].getAttribute("aria-selected")).toBe("true");
    expect(radio(f.host, "This file").getAttribute("aria-checked")).toBe("true");
    expect(f.host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("History scope");
    radio(f.host, "This file").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await vi.waitFor(() => expect(f.transport.gitHistory).toHaveBeenLastCalledWith(context, expect.objectContaining({ path: null })));
    expect(radio(f.host, "All commits").getAttribute("aria-checked")).toBe("true"); expect(f.view.target()).toBeUndefined();
    radio(f.host, "This file").click();
    await vi.waitFor(() => expect(f.transport.gitHistory).toHaveBeenLastCalledWith(context, expect.objectContaining({ path: "project/src/other.ts" })));
  });

  it("defaults generic History opens to All commits", async () => {
    const f = fixture(); await f.git.refresh();
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active activePath="src/main.ts" />);
    f.view.showHistory();
    await vi.waitFor(() => expect(f.transport.gitHistory).toHaveBeenCalledWith(context, expect.objectContaining({ path: null })));
    expect(radio(f.host, "All commits").getAttribute("aria-checked")).toBe("true");
  });

  it("does not read history while the Git view is hidden", async () => {
    const f = fixture(memoryStorage({ [GIT_SUBVIEW_KEY]: "history" })); await f.git.refresh();
    const [active, setActive] = createSignal(false);
    f.mount(() => <GitSourceControl git={f.git} view={f.view} available active={active()} />);
    expect(f.transport.gitHistory).not.toHaveBeenCalled();
    setActive(true); await vi.waitFor(() => expect(f.transport.gitHistory).toHaveBeenCalledTimes(1));
  });
});

describe("App wiring for the merged Git view", () => {
  const app = readFileSync(resolve(process.cwd(), "src", "App.tsx"), "utf8");
  it("has no standalone History tab and keeps Git active for either sub-view", () => {
    expect(app).toContain('<For each={["Files", "Search", "Git", "Uploads"] as const}>');
    expect(app).not.toMatch(/"History"/);
    expect(app).toContain('active: () => showLeft() && leftView() === "Git" || isGitTab');
  });
  it("routes file context menu and editor actions to Git History scoped to the file", () => {
    expect(app.match(/id: "file-history", label: "Show file history"[^}]*onSelect: \(\) => showFileHistory\(path\)/g)).toHaveLength(2);
    expect(app).toContain("gitView.showFileHistory(relativePath(path, w.workspace()?.root)); showSourceControl();");
  });
});
