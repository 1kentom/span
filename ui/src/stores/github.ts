import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { GitHubCreatePullRequest, GitHubItem_Serialize as GitHubItem, GitHubRepository, GitHubReviewEvent, GitHubStatus } from "../bindings";
import type { GitWorkbench } from "./git";
import { api } from "../lib/client";

type Transport = Pick<typeof api, "githubRepositories" | "githubStatus" | "githubRead" | "githubCreatePullRequest" | "githubReviewPullRequest">;
export function createGitHubWorkbench(options: { git: GitWorkbench; active(): boolean; generation(): number; transport?: Transport }) {
  const transport = options.transport ?? api;
  const [repositories, setRepositories] = createSignal<GitHubRepository[]>();
  const [remote, setRemote] = createSignal("");
  const [status, setStatus] = createSignal<GitHubStatus>();
  const [repositoryInfo, setRepositoryInfo] = createSignal<GitHubItem>();
  const [kind, setKind] = createSignal<"pullRequests" | "issues">("pullRequests");
  const [filter, setFilter] = createSignal("open");
  const [items, setItems] = createSignal<GitHubItem[]>([]);
  const [selected, setSelected] = createSignal<GitHubItem>();
  const [files, setFiles] = createSignal<GitHubItem[]>([]);
  const [filePage, setFilePage] = createSignal(0);
  const [moreFiles, setMoreFiles] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailsLoaded, setDetailsLoaded] = createSignal(false);
  const [filesLoading, setFilesLoading] = createSignal(false);
  const [operation, setOperation] = createSignal("");
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let epoch = 0; let request = 0; let detailsRequest = 0; let fileRequest = 0; let disposed = false;
  const contextId = () => options.git.context()?.enabled ? options.git.context()?.repository?.id : undefined;
  const live = (token: number, id: string | undefined, name?: string) => !disposed && token === epoch && contextId() === id && (name === undefined || remote() === name);
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  const ready = () => !!contextId() && !!remote() && !!status()?.authenticated && !loading() && !operation() && !options.git.operation();
  const repository = () => status()?.repository;

  async function load() {
    const id = contextId(); if (!id || operation()) return;
    const token = epoch; const serial = ++request;
    setLoading(true); setError("");
    try {
      const repos = await transport.githubRepositories(id);
      if (!live(token, id) || serial !== request) return;
      setRepositories(repos);
      const name = repos.some(repo => repo.remoteName === remote()) ? remote() : repos[0]?.remoteName ?? "";
      const repo = repos.find(item => item.remoteName === name);
      const previous = repository();
      if (previous && repo && (previous.owner !== repo.owner || previous.name !== repo.name || previous.host !== repo.host || previous.remoteName !== repo.remoteName)) {
        detailsRequest++; fileRequest++; setSelected(undefined); setDetailsLoaded(false); setFiles([]); setDetailLoading(false); setFilesLoading(false); setRepositoryInfo(undefined);
      }
      setRemote(name);
      if (!name || !repo) { setStatus(undefined); setItems([]); return; }
      const connected = await transport.githubStatus(id, name, repo);
      if (!live(token, id, name) || serial !== request) return;
      setStatus(connected);
      if (!connected.authenticated) { setItems([]); return; }
      const [result, metadata] = await Promise.all([
        transport.githubRead(id, name, { kind: kind(), state: filter(), limit: 50 }, repo),
        transport.githubRead(id, name, { kind: "repository" }, repo),
      ]);
      if (live(token, id, name) && serial === request) { setItems(result.items); setRepositoryInfo(metadata.items[0]); }
    } catch (cause) { if (live(token, id) && serial === request) setError(message(cause)); }
    finally { if (live(token, id) && serial === request) setLoading(false); }
  }
  async function chooseRemote(name: string) { if (operation()) return; detailsRequest++; fileRequest++; setDetailLoading(false); setFilesLoading(false); setSelected(undefined); setDetailsLoaded(false); setFiles([]); setStatus(undefined); setRemote(name); await load(); }
  async function chooseKind(value: "pullRequests" | "issues") { if (operation()) return; detailsRequest++; fileRequest++; setDetailLoading(false); setFilesLoading(false); setKind(value); setSelected(undefined); setDetailsLoaded(false); setFiles([]); setItems([]); await load(); }
  async function chooseFilter(value: string) { if (operation()) return; setFilter(value); setItems([]); await load(); }
  async function detail(item: GitHubItem) {
    const id = contextId(); if (!id || !ready()) return;
    const name = remote(); const token = epoch; const serial = ++detailsRequest;
    fileRequest++; setFiles([]); setFilePage(0); setMoreFiles(false); setSelected(item); setDetailsLoaded(false); setDetailLoading(true); setError("");
    try {
      const result = await transport.githubRead(id, name, { kind: kind() === "pullRequests" ? "pullRequest" : "issue", number: item.number }, repository()!);
      if (live(token, id, name) && serial === detailsRequest) {
        if (!result.items[0]) throw new Error("GitHub returned no details for this item.");
        setSelected(result.items[0]); setDetailsLoaded(true);
      }
    } catch (cause) { if (live(token, id, name) && serial === detailsRequest) setError(message(cause)); }
    finally { if (live(token, id, name) && serial === detailsRequest) setDetailLoading(false); }
  }
  async function loadFiles(more = false) {
    const id = contextId(); const item = selected(); if (!id || !item || !detailsLoaded() || kind() !== "pullRequests" || filesLoading() || !ready()) return;
    const name = remote(); const token = epoch; const serial = ++fileRequest; const page = more ? filePage() + 1 : 1;
    setFilesLoading(true); setError("");
    try {
      const result = await transport.githubRead(id, name, { kind: "pullRequestFiles", number: item.number, page, expectedHead: item.headRefOid }, repository()!);
      if (!live(token, id, name) || serial !== fileRequest || selected()?.number !== item.number) return;
      batch(() => { setFiles(previous => more ? [...previous, ...result.items] : result.items); setFilePage(page); setMoreFiles(result.items.length === 30); });
    } catch (cause) { if (live(token, id, name) && serial === fileRequest) setError(message(cause)); }
    finally { if (live(token, id, name) && serial === fileRequest) setFilesLoading(false); }
  }
  async function mutate(label: string, action: (id: string, name: string) => Promise<string>) {
    const id = contextId(); if (!id || !ready()) return false;
    const token = epoch; const name = remote(); setOperation(label); setError(""); setNotice("");
    try { const output = await action(id, name); if (!live(token, id, name)) return false; setNotice(output || `${label} completed.`); return true; }
    catch (cause) { if (live(token, id, name)) setError(message(cause)); return false; }
    finally { if (live(token, id, name)) setOperation(""); }
  }
  const createPullRequest = (value: GitHubCreatePullRequest) => mutate("Create pull request", (id, name) => transport.githubCreatePullRequest(id, name, value, repository()!));
  const review = async (event: GitHubReviewEvent, body: string) => {
    const item = selected(); if (!item?.headRefOid || !detailsLoaded() || detailLoading()) return false;
    const ok = await mutate("Submit review", (id, name) => transport.githubReviewPullRequest(id, name, { number: item.number, expectedHead: item.headRefOid, event, body }, repository()!));
    if (ok) await detail(item);
    return ok;
  };
  async function currentBranch() {
    const id = contextId(); const branch = options.git.status()?.repository.branch;
    if (!id || !branch || !ready()) return;
    const token = epoch; const name = remote(); const serial = ++detailsRequest;
    setDetailsLoaded(false); setDetailLoading(true); setError("");
    try {
      const result = await transport.githubRead(id, name, { kind: "currentPullRequest", branch }, repository()!);
      if (!live(token, id, name) || serial !== detailsRequest) return;
      if (!result.items[0]) { setNotice("No pull request found for the current branch."); return; }
      setKind("pullRequests"); setSelected(result.items[0]); setDetailsLoaded(true); fileRequest++; setFiles([]); setFilePage(0); setMoreFiles(false);
    } catch (cause) { if (live(token, id, name) && serial === detailsRequest) setError(message(cause)); }
    finally { if (live(token, id, name) && serial === detailsRequest) setDetailLoading(false); }
  }
  const workspaceIdentity = createMemo(() => `${contextId()}:${options.generation()}`);
  createEffect(on(workspaceIdentity, () => {
    epoch++; request++; detailsRequest++; fileRequest++;
    batch(() => { setRepositories(undefined); setRemote(""); setStatus(undefined); setRepositoryInfo(undefined); setItems([]); setSelected(undefined); setDetailsLoaded(false); setFiles([]); setFilePage(0); setMoreFiles(false); setLoading(false); setDetailLoading(false); setFilesLoading(false); setOperation(""); setError(""); setNotice(""); });
  }));
  createEffect(() => { if (options.active() && contextId() && repositories() === undefined && !loading() && !error()) void load(); });
  onCleanup(() => { disposed = true; epoch++; });
  return { repositories, repositoryInfo, remote, status, kind, filter, items, selected, files, filePage, moreFiles, loading, detailLoading, detailsLoaded, filesLoading, operation, error, notice, ready, load, chooseRemote, chooseKind, chooseFilter, detail, loadFiles, currentBranch, createPullRequest, review, back: () => { detailsRequest++; fileRequest++; setSelected(undefined); setDetailsLoaded(false); setFiles([]); setDetailLoading(false); setFilesLoading(false); } };
}
export type GitHubWorkbench = ReturnType<typeof createGitHubWorkbench>;
