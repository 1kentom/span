import { batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { GitChange, GitCommit, GitContext, GitDiff, GitDiffSide, GitHistoryPage, GitStatus, GitBranch, GitStash, GitWorktree, GitCommitDetails, GitRemoteAction, GitStashAction, GitHunkDiff, GitTag, GitIntegrationState, GitIntegrationResult, GitRebaseAction, GitRemotes } from "../bindings";
import { api } from "../lib/client";

type GitTransport = Pick<typeof api, "gitContext" | "gitEnable" | "gitStatus" | "gitDiff" | "gitHistory" | "gitCommitDiff" | "gitStage" | "gitUnstage" | "gitCommit"> & Partial<Pick<typeof api, "gitBranches" | "gitCheckout" | "gitRemote" | "gitStashes" | "gitStash" | "gitWorktrees" | "gitWorktreeAdd" | "gitWorktreeRemove" | "gitCommitDetails" | "gitHunkDiff" | "gitApplyHunk" | "gitTags" | "gitCreateTag" | "gitDeleteTag" | "gitMergeFastForward" | "gitIntegrationState" | "gitRebase" | "gitRebaseControl" | "gitMarkResolved" | "gitRemotes" | "gitDiscardFile">>;
export type GitView = {
  key: string;
  title: string;
  repositoryId: string;
  repositoryRoot: string;
  path?: string;
  side: GitDiffSide;
  commitId?: string;
  commit?: GitCommit;
  diff?: GitDiff;
  hunkData?: GitHunkDiff;
  loading: boolean;
  error?: string;
};
export const stagedChange = (entry: GitChange) => !["", ".", " ", "?", "!"].includes(entry.indexStatus);
export const workingChange = (entry: GitChange) => entry.untracked || !["", ".", " ", "!"].includes(entry.worktreeStatus);
export function workspaceGitPath(context: GitContext | undefined, path: string): string | undefined {
  const prefix = context?.repository?.workspacePrefix.replace(/\/$/, "");
  if (prefix === undefined) return;
  if (!prefix) return path;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : undefined;
}

type GitError = { message: string; helpUrl?: string };
function describeGitError(cause: unknown): GitError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const missing = /^Command ["'`]?(git_[a-z_]+)["'`]? not found\.?$/i.exec(message.trim());
  if (!missing) return { message };
  return {
    message: `This window's backend does not recognize ${missing[1]}. The frontend and backend may be different versions. Save your work and copy any unsent chat or commit drafts, then fully quit Span and reopen the latest app. If this is a development window, also stop and restart its development process.`,
    helpUrl: "https://github.com/1kentom/span/issues/154",
  };
}

export function createGitWorkbench(options: { root: () => string | undefined; generation: () => number; active: () => boolean; blocked: () => boolean; available: boolean; onOpenView: (key: string, title: string) => void; onOpenFile?: (repositoryPath: string) => void; onWorkingTreeChange?: () => void | Promise<void>; beforeWorkingTreeChange?: (action: string) => boolean; transport?: GitTransport }) {
  const transport = options.transport ?? api;
  const [context, setContext] = createSignal<GitContext>();
  const [status, setStatus] = createSignal<GitStatus>();
  const [loading, setLoading] = createSignal(false);
  const [operation, setOperation] = createSignal<string>();
  const [errorState, setErrorState] = createSignal<GitError>({ message: "" });
  const error = () => errorState().message;
  const errorHelp = () => errorState().helpUrl;
  let actionError = false;
  const setError = (cause: unknown, fromAction = false) => { actionError = !!cause && fromAction; setErrorState(describeGitError(cause)); };
  const [notice, setNotice] = createSignal("");
  const [warning, setWarning] = createSignal("");
  const [message, setMessageState] = createSignal("");
  const drafts = new Map<string, string>();
  let draftRoot = options.root();
  let messageVersion = 0;
  function setMessage(value: string) { messageVersion++; setMessageState(value); if (draftRoot) drafts.set(draftRoot, value); }
  const [history, setHistory] = createSignal<GitHistoryPage>();
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal("");
  const [historyPath, setHistoryPath] = createSignal<string>();
  const [integrationState, setIntegrationState] = createSignal<GitIntegrationState>();
  const [integrationLoading, setIntegrationLoading] = createSignal(false);
  const [integrationError, setIntegrationError] = createSignal("");
  let integrationRequest = 0;
  const [remotes, setRemotes] = createSignal<GitRemotes>();
  const [tags, setTags] = createSignal<GitTag[]>();
  const [branches, setBranches] = createSignal<GitBranch[]>();
  const [stashes, setStashes] = createSignal<GitStash[]>();
  const [worktrees, setWorktrees] = createSignal<GitWorktree[]>();
  const [resourceLoading, setResourceLoading] = createSignal<Record<string, boolean>>({});
  const [resourceErrors, setResourceErrors] = createSignal<Record<string, string>>({});
  const [commitDetails, setCommitDetails] = createSignal<GitCommitDetails>();
  const [detailsLoading, setDetailsLoading] = createSignal(false);
  const [detailsError, setDetailsError] = createSignal("");
  const resourceRequests = new Map<string, number>();
  let detailsRequest = 0;
  function resetResources() { integrationRequest++; setIntegrationState(undefined); setIntegrationLoading(false); setIntegrationError(""); setRemotes(undefined); setTags(undefined); setBranches(undefined); setStashes(undefined); setWorktrees(undefined); setResourceLoading({}); setResourceErrors({}); resourceRequests.forEach((request, key) => resourceRequests.set(key, request + 1)); setCommitDetails(undefined); setDetailsLoading(false); setDetailsError(""); detailsRequest++; }
  const [views, setViews] = createSignal<Record<string, GitView>>({});
  let epoch = 0; let disposed = false; let contextRequest = 0; let historyRequest = 0;
  let refreshPending: Promise<void> | undefined;
  const viewRequests = new Map<string, number>();
  const live = (token: number) => !disposed && epoch === token;
  const report = (cause: unknown) => describeGitError(cause).message;
  const changed = () => status()?.entries.filter(workingChange) || [];
  const staged = () => status()?.entries.filter(stagedChange) || [];
  const mutable = (entry: GitChange) => !!entry.path && !entry.unsupportedReason && !entry.conflicted && !entry.submodule;
  const ready = () => !!context()?.enabled && !!context()?.repository && !!status() && status()?.repository.id === context()?.repository?.id && !loading() && !operation() && !status()?.operation && !status()?.truncated && !options.blocked();
  const canCommit = () => ready() && !!message().trim() && !!staged().length && !status()?.truncated && !status()?.operation && !status()?.entries.some(entry => entry.conflicted);

  function beginMutation() { contextRequest++; refreshPending = undefined; setLoading(false); }
  function refreshMutableViews() {
    for (const [key, view] of Object.entries(views())) if (view.side !== "commit") void fetchView(key);
  }
  async function refresh() {
    if (!options.available || !options.root() || options.blocked() || operation()) return;
    if (refreshPending) return refreshPending;
    const token = epoch; const request = ++contextRequest; const root = options.root();
    setLoading(true);
    const task = (async () => {
      try {
        const next = await transport.gitContext();
        if (!live(token) || request !== contextRequest) return;
        if (next.workspaceRoot !== root) throw new Error("The Git workspace changed. Refresh after the folder finishes opening.");
        batch(() => {
          if (next.repository?.id !== context()?.repository?.id) {
            setStatus(undefined); resetResources();
            if (context()?.repository) { setViews({}); viewRequests.clear(); setHistory(undefined); historyRequest++; setHistoryLoading(false); }
          }
          setContext(next);
        });
        if (!next.repository || !next.enabled) {
          setStatus(undefined); setError(""); setHistory(undefined); setHistoryLoading(false); historyRequest++;
          return;
        }
        const snapshot = await transport.gitStatus(next);
        if (!live(token) || request !== contextRequest) return;
        if (snapshot.repository.id !== next.repository.id) throw new Error("The Git repository changed. Refresh to review the current repository.");
        const previous = status()?.repository;
        const headChanged = !!previous && (previous.head !== snapshot.repository.head || previous.branch !== snapshot.repository.branch);
        const indexChanged = !!status() && status()!.indexRevision !== snapshot.indexRevision;
        batch(() => {
          setStatus(snapshot); setContext({ ...next, repository: snapshot.repository }); if (!actionError) setError("");
          if (headChanged) { setHistory(undefined); historyRequest++; setHistoryLoading(false); resetResources(); }
        });
        if (headChanged || indexChanged) refreshMutableViews();
      } catch (cause) { if (live(token) && request === contextRequest && !actionError) setError(cause); }
      finally { if (live(token) && request === contextRequest) setLoading(false); }
    })();
    refreshPending = task;
    void task.finally(() => { if (refreshPending === task) refreshPending = undefined; });
    return task;
  }
  async function enable() {
    const ctx = context();
    if (!options.available || !ctx?.repository || ctx.enabled || loading() || operation() || options.blocked()) return false;
    const token = epoch;
    beginMutation(); setOperation("enable"); setError("");
    try {
      const snapshot = await transport.gitEnable(ctx);
      if (!live(token)) return false;
      if (snapshot.repository.id !== ctx.repository.id) throw new Error("The repository changed before Git was enabled. Refresh and review its location.");
      batch(() => { setContext({ ...ctx, enabled: true, repository: snapshot.repository }); setStatus(snapshot); });
      return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  async function mutate(kind: "stage" | "unstage" | "commit", entries: GitChange[] = []) {
    if (!ready()) return false;
    const ctx = context()!; const before = status()!; const token = epoch; const draft = message(); const draftVersion = messageVersion;
    if (kind === "commit" && !canCommit()) return false;
    const paths = entries.filter(mutable).map(entry => entry.path!);
    if (kind !== "commit" && !paths.length) return false;
    beginMutation(); setOperation(kind); setError(""); setNotice(""); setWarning("");
    let refreshAfterCommit = false;
    try {
      let next: GitStatus | null | undefined; let committed: GitCommit | undefined; let committedId: string | undefined; let commitWarning: string | undefined;
      if (kind === "commit") { const result = await transport.gitCommit(ctx, draft, before.indexRevision, before.stagedSnapshot); next = result.status; committed = result.commit ?? undefined; committedId = result.commitId; commitWarning = result.warning ?? undefined; }
      else next = await (kind === "stage" ? transport.gitStage : transport.gitUnstage)(ctx, paths, before.indexRevision);
      if (!live(token)) return false;
      if (next && next.repository.id !== ctx.repository!.id) {
        if (!committedId) throw new Error("The Git action returned a different repository.");
        next = undefined;
        commitWarning = "The commit was created, but its updated status belongs to a different repository. Refresh Git.";
      }
      refreshAfterCommit = !!committedId && !next;
      batch(() => {
        setStatus(next ?? undefined);
        if (next) setContext({ ...ctx, repository: next.repository });
        if (committedId) {
          if (messageVersion === draftVersion) setMessage("");
          setNotice(`Committed ${committedId.slice(0, 8)}${committed ? `: ${committed.subject}` : ""}`);
          setWarning(commitWarning || "");
          setHistory(undefined); setHistoryLoading(false); setHistoryError(""); historyRequest++; resetResources();
        }
      });
      if (next) refreshMutableViews();
      return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) { setOperation(undefined); if (refreshAfterCommit) void refresh(); } }
  }
  async function loadHistory(path: string | null | undefined = historyPath(), more = false) {
    const ctx = context(); if (!ctx?.repository || !ctx.enabled || !options.available || options.blocked()) return;
    if (more && historyLoading()) return;
    path = path ?? undefined;
    const previous = history(); const token = epoch; const request = ++historyRequest;
    const same = path === historyPath(); const append = more && same && !!previous;
    if (append && previous.nextSkip == null) return;
    setHistoryPath(path); setHistoryLoading(true); setHistoryError("");
    if (!append) setHistory(undefined);
    try {
      const page = await transport.gitHistory(ctx, { anchor: append ? previous.anchor ?? null : null, skip: append ? previous.nextSkip! : 0, limit: 50, path: path ?? null });
      if (!live(token) || request !== historyRequest) return;
      if (page.repositoryId !== ctx.repository.id) throw new Error("Git history belongs to a different repository.");
      setHistory(append ? { ...page, commits: [...previous.commits, ...page.commits.filter(commit => !previous.commits.some(old => old.id === commit.id))] } : page);
    } catch (cause) { if (live(token) && request === historyRequest) setHistoryError(report(cause)); }
    finally { if (live(token) && request === historyRequest) setHistoryLoading(false); }
  }
  type Resource = "branches" | "stashes" | "worktrees" | "tags" | "remotes";
  async function loadResource(kind: Resource) {
    const ctx = context();
    if (!options.available || !ctx?.enabled || !ctx.repository || options.blocked()) return;
    const token = epoch; const request = (resourceRequests.get(kind) || 0) + 1;
    resourceRequests.set(kind, request);
    setResourceLoading(current => ({ ...current, [kind]: true })); setResourceErrors(current => ({ ...current, [kind]: "" }));
    try {
      if (kind === "branches") {
        if (!transport.gitBranches) throw new Error("Branch management is unavailable in this backend.");
        const result = await transport.gitBranches(ctx);
        if (live(token) && resourceRequests.get(kind) === request && context()?.repository?.id === ctx.repository.id) setBranches(result);
      } else if (kind === "stashes") {
        if (!transport.gitStashes) throw new Error("Stash management is unavailable in this backend.");
        const result = await transport.gitStashes(ctx);
        if (live(token) && resourceRequests.get(kind) === request && context()?.repository?.id === ctx.repository.id) setStashes(result);
      } else if (kind === "remotes") {
        if (!transport.gitRemotes) throw new Error("Remote review is unavailable in this backend.");
        const result = await transport.gitRemotes(ctx);
        if (live(token) && resourceRequests.get(kind) === request && context()?.repository?.id === ctx.repository.id) setRemotes(result);
      } else if (kind === "tags") {
        if (!transport.gitTags) throw new Error("Tag management is unavailable in this backend.");
        const result = await transport.gitTags(ctx);
        if (live(token) && resourceRequests.get(kind) === request && context()?.repository?.id === ctx.repository.id) setTags(result);
      } else {
        if (!transport.gitWorktrees) throw new Error("Worktree management is unavailable in this backend.");
        const result = await transport.gitWorktrees(ctx);
        if (live(token) && resourceRequests.get(kind) === request && context()?.repository?.id === ctx.repository.id) setWorktrees(result);
      }
    } catch (cause) { if (live(token) && resourceRequests.get(kind) === request) setResourceErrors(current => ({ ...current, [kind]: report(cause) })); }
    finally { if (live(token) && resourceRequests.get(kind) === request) setResourceLoading(current => ({ ...current, [kind]: false })); }
  }
  async function repositoryAction(kind: string, action: (ctx: GitContext, before: GitStatus) => Promise<{ status: GitStatus; output?: string }>) {
    if (!ready() || status()?.operation || status()?.truncated) return false;
    const changesDisk = ["checkout", "create branch", "pull", "stash save", "stash apply", "stash pop", "merge"].includes(kind);
    if (changesDisk && options.beforeWorkingTreeChange?.(kind) === false) return false;
    const ctx = context()!; const before = status()!; const token = epoch;
    beginMutation(); setOperation(kind); setError(""); setWarning(""); setNotice("");
    try {
      const result = await action(ctx, before);
      if (!live(token)) return false;
      if (result.status.repository.id !== ctx.repository!.id) throw new Error("The Git action returned a different repository. Refresh and review the repository location.");
      batch(() => {
        setStatus(result.status); setContext({ ...ctx, repository: result.status.repository });
        setNotice(result.output?.trim() || `${kind.charAt(0).toUpperCase()}${kind.slice(1)} completed.`);
        setHistory(undefined); historyRequest++; setHistoryLoading(false);
        resetResources();
      });
      refreshMutableViews();
      if (changesDisk) { try { await options.onWorkingTreeChange?.(); } catch (cause) { if (live(token)) setWarning(`Git completed, but open files could not refresh: ${report(cause)}`); } }
      return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  const checkout = (branch: string, create = false) => repositoryAction(create ? "create branch" : "checkout", async (ctx, before) => {
    if (!transport.gitCheckout) throw new Error("Branch management is unavailable in this backend.");
    return { status: await transport.gitCheckout(ctx, branch, create, before.indexRevision) };
  });
  const remote = (action: GitRemoteAction) => repositoryAction(action, async ctx => {
    if (!transport.gitRemote || !remotes()) throw new Error("Review the repository remotes before running a network action.");
    return transport.gitRemote(ctx, action, remotes()!.configFingerprint);
  });
  const stash = (action: GitStashAction, id?: string, message?: string) => repositoryAction(`stash ${action}`, async (ctx, before) => {
    if (!transport.gitStash) throw new Error("Stash management is unavailable in this backend.");
    return transport.gitStash(ctx, action, id ?? null, message?.trim() || null, before.indexRevision);
  });
  const addWorktree = (path: string, branch: string) => repositoryAction("add worktree", async ctx => {
    if (!transport.gitWorktreeAdd) throw new Error("Worktree management is unavailable in this backend.");
    return transport.gitWorktreeAdd(ctx, path, branch);
  });
  const removeWorktree = (path: string) => repositoryAction("remove worktree", async ctx => {
    if (!transport.gitWorktreeRemove) throw new Error("Worktree management is unavailable in this backend.");
    return transport.gitWorktreeRemove(ctx, path);
  });
  const mergeFastForward = (target: string) => repositoryAction("merge", async (ctx, before) => {
    if (!transport.gitMergeFastForward) throw new Error("Fast-forward merge is unavailable in this backend.");
    return transport.gitMergeFastForward(ctx, target, before.indexRevision);
  });
  async function tagAction(name: string, target: string, remove: boolean) {
    if (!ready()) return false;
    const ctx = context()!; const token = epoch;
    beginMutation(); setOperation(remove ? "delete tag" : "create tag"); setError(""); setNotice("");
    try {
      if (!transport.gitCreateTag || !transport.gitDeleteTag) throw new Error("Tag management is unavailable in this backend.");
      const result = await (remove ? transport.gitDeleteTag(ctx, name, target) : transport.gitCreateTag(ctx, name, target));
      if (!live(token)) return false;
      setTags(result); setNotice(`${remove ? "Deleted" : "Created"} local tag ${name}.`); return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  async function applyHunk(key: string, hunkId: string) {
    const view = views()[key]; const ctx = context();
    if (!ready() || !ctx?.repository || !view?.path || !view.hunkData || view.side === "commit" || !transport.gitApplyHunk || view.repositoryId !== ctx.repository.id) return false;
    const token = epoch;
    beginMutation(); setOperation(view.side === "working" ? "stage hunk" : "unstage hunk"); setError(""); setNotice("");
    try {
      const next = await transport.gitApplyHunk(ctx, view.path, view.side, hunkId, view.hunkData.diff.indexRevision, view.hunkData.worktreeSnapshot);
      if (!live(token)) return false;
      if (next.repository.id !== ctx.repository.id) throw new Error("The hunk action returned a different repository.");
      setStatus(next); setNotice(view.side === "working" ? "Staged hunk." : "Unstaged hunk."); refreshMutableViews(); return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  const integrationReady = () => !!context()?.enabled && !!context()?.repository && !!status() && status()?.repository.id === context()?.repository?.id && !loading() && !operation() && !status()?.truncated && !options.blocked();
  async function loadIntegrationState() {
    const ctx = context(); if (!ctx?.enabled || !ctx.repository || options.blocked() || !transport.gitIntegrationState) return;
    const token = epoch; const request = ++integrationRequest;
    setIntegrationLoading(true); setIntegrationError("");
    try {
      const result = await transport.gitIntegrationState(ctx);
      if (!live(token) || request !== integrationRequest) return;
      if (result.status.repository.id !== ctx.repository.id) throw new Error("The conflict state belongs to a different repository.");
      setIntegrationState(result); setStatus(result.status);
    } catch (cause) { if (live(token) && request === integrationRequest) setIntegrationError(report(cause)); }
    finally { if (live(token) && request === integrationRequest) setIntegrationLoading(false); }
  }
  async function integrationAction(kind: string, action: (ctx: GitContext, before: GitStatus) => Promise<GitIntegrationResult>) {
    if (!integrationReady() || options.beforeWorkingTreeChange?.(kind) === false) return false;
    const ctx = context()!; const before = status()!; const token = epoch;
    beginMutation(); integrationRequest++; setIntegrationLoading(false); setOperation(kind); setError(""); setNotice(""); setWarning("");
    try {
      const result = await action(ctx, before);
      if (!live(token)) return false;
      if (result.state.status.repository.id !== ctx.repository!.id) throw new Error("The integration action returned a different repository.");
      batch(() => {
        setStatus(result.state.status); setContext({ ...ctx, repository: result.state.status.repository });
        resetResources(); setIntegrationState(result.state); setHistory(undefined); historyRequest++; setHistoryLoading(false);
        setNotice(result.output.trim() || (result.completed ? "Git integration completed." : "Resolve the remaining conflicts to continue."));
      });
      refreshMutableViews();
      try { await options.onWorkingTreeChange?.(); } catch (cause) { if (live(token)) setWarning(`Git completed, but open files could not refresh: ${report(cause)}`); }
      return true;
    } catch (cause) { if (live(token)) setError(cause, true); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  const rebase = (target: string) => {
    if (!ready()) return Promise.resolve(false);
    return integrationAction("rebase", async (ctx, before) => {
      if (!transport.gitRebase) throw new Error("Rebase is unavailable in this backend.");
      return transport.gitRebase(ctx, target, before.indexRevision);
    });
  };
  const rebaseControl = (action: GitRebaseAction) => integrationAction(`rebase ${action}`, async ctx => {
    if (!transport.gitRebaseControl || !transport.gitIntegrationState) throw new Error("Rebase controls are unavailable in this backend.");
    const fresh = await transport.gitIntegrationState(ctx);
    return transport.gitRebaseControl(ctx, action, fresh.status.indexRevision, fresh.worktreeSnapshot);
  });
  const markResolved = (path: string) => integrationAction("mark resolved", async ctx => {
    if (!transport.gitMarkResolved || !transport.gitIntegrationState) throw new Error("Conflict resolution is unavailable in this backend.");
    const fresh = await transport.gitIntegrationState(ctx);
    const state = await transport.gitMarkResolved(ctx, path, fresh.status.indexRevision, fresh.worktreeSnapshot);
    return { state, completed: !state.status.operation, output: `Marked ${path} resolved.` };
  });
  const discardFile = (path: string) => integrationAction("discard file", async ctx => {
    if (!transport.gitDiscardFile || !transport.gitIntegrationState) throw new Error("Recoverable file discard is unavailable in this backend.");
    const fresh = await transport.gitIntegrationState(ctx);
    const result = await transport.gitDiscardFile(ctx, path, fresh.status.indexRevision, fresh.worktreeSnapshot);
    return { state: result.state, completed: true, output: `Discarded saved changes in ${path}. Original bytes saved at ${result.recoveryPath}` };
  });
  async function loadCommitDetails(commit: GitCommit) {
    const ctx = context(); if (!ctx?.enabled || !ctx.repository || options.blocked() || !transport.gitCommitDetails) return;
    const token = epoch; const request = ++detailsRequest;
    setCommitDetails(undefined); setDetailsLoading(true); setDetailsError("");
    try { const result = await transport.gitCommitDetails(ctx, commit.id); if (live(token) && request === detailsRequest) setCommitDetails(result); }
    catch (cause) { if (live(token) && request === detailsRequest) setDetailsError(report(cause)); }
    finally { if (live(token) && request === detailsRequest) setDetailsLoading(false); }
  }
  function viewKey(path: string | undefined, side: GitDiffSide, commitId?: string) { return `${context()?.repository?.id}:${side}:${commitId || ""}:${path || ""}`; }
  async function fetchView(key: string) {
    const view = views()[key]; const ctx = context(); const before = status();
    if (!view || !ctx?.repository || !ctx.enabled || !before || options.blocked()) return;
    if (view.repositoryId !== ctx.repository.id) {
      setViews(current => ({ ...current, [key]: { ...current[key], loading: false, error: "The repository changed. Reopen this comparison from Source control." } }));
      return;
    }
    const token = epoch; const request = (viewRequests.get(key) || 0) + 1; viewRequests.set(key, request);
    setViews(current => ({ ...current, [key]: { ...current[key], loading: true, error: undefined } }));
    try {
      const diff = view.side === "commit"
        ? await transport.gitCommitDiff(ctx, view.commitId!, view.path ?? null)
        : await transport.gitDiff(ctx, view.path!, view.side, before.indexRevision);
      if (!live(token) || viewRequests.get(key) !== request || !views()[key]) return;
      if (diff.repositoryId !== ctx.repository.id) throw new Error("The comparison belongs to a different repository.");
      let hunkData: GitHunkDiff | undefined;
      if (transport.gitHunkDiff && view.side !== "commit" && view.path && diff.patch && !diff.binary && !diff.truncated && !diff.oldPath) {
        try { hunkData = await transport.gitHunkDiff(ctx, view.path, view.side, before.indexRevision); } catch { /* The full comparison remains available for unsupported partial staging. */ }
      }
      if (!live(token) || viewRequests.get(key) !== request || !views()[key]) return;
      setViews(current => ({ ...current, [key]: { ...current[key], diff: hunkData?.diff || diff, hunkData, loading: false } }));
    } catch (cause) { if (live(token) && viewRequests.get(key) === request && views()[key]) setViews(current => ({ ...current, [key]: { ...current[key], loading: false, error: report(cause) } })); }
  }
  function openDiff(path: string | undefined, side: GitDiffSide, commit?: GitCommit) {
    if (!context()?.enabled || !context()?.repository || !status() || options.blocked() || side !== "commit" && !path) return;
    const key = viewKey(path, side, commit?.id);
    const filename = path?.split("/").at(-1);
    const title = side === "commit" ? `${commit!.id.slice(0, 8)}${filename ? ` · ${filename}` : ""}` : `${filename} (${side === "staged" ? "Staged" : "Working"})`;
    batch(() => { setViews(current => ({ ...current, [key]: current[key] || { key, title, repositoryId: context()!.repository!.id, repositoryRoot: context()!.repository!.root, path, side, commitId: commit?.id, commit, loading: true } })); options.onOpenView(key, title); });
    void fetchView(key);
  }
  async function refreshView(key: string) { await refresh(); await fetchView(key); }
  function retainViews(keys: string[]) { const keep = new Set(keys); setViews(current => Object.fromEntries(Object.entries(current).filter(([key]) => keep.has(key)))); }
  createEffect(on(() => [options.root(), options.generation()] as const, () => {
    draftRoot = options.root(); messageVersion++;
    epoch++; contextRequest++; historyRequest++; resetResources(); refreshPending = undefined; viewRequests.clear();
    batch(() => { setContext(undefined); setStatus(undefined); setLoading(false); setOperation(undefined); setError(""); setNotice(""); setWarning(""); setMessageState(draftRoot ? drafts.get(draftRoot) || "" : ""); setHistory(undefined); setHistoryPath(undefined); setHistoryLoading(false); setHistoryError(""); setViews({}); });
  }));
  createEffect(() => {
    if ((!options.active() && !context()?.enabled) || options.blocked() || !options.available || !options.root()) return;
    if (!context() && !loading() && !error()) void refresh();
    if (!context()?.enabled) return;
    const timer = setInterval(() => { if (!operation()) void refresh(); }, 2500);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => { disposed = true; epoch++; });
  return { discardFile, supportsDiscard: () => !!transport.gitDiscardFile, remotes, integrationState, integrationLoading, integrationError, integrationReady, loadIntegrationState, rebase, rebaseControl, markResolved, openWorkingFile: (path: string) => options.onOpenFile?.(path), canOpenWorkingFile: () => !!options.onOpenFile, tags, createTag: (name: string, target: string) => tagAction(name, target, false), deleteTag: (name: string, objectId: string) => tagAction(name, objectId, true), mergeFastForward, applyHunk, branches, stashes, worktrees, resourceLoading, resourceErrors, loadResource, checkout, remote, stash, addWorktree, removeWorktree, commitDetails, detailsLoading, detailsError, loadCommitDetails, hasWorkspace: () => !!options.root(), context, status, loading, operation, error, errorHelp, notice, warning, message, setMessage, staged, changed, mutable, ready, canCommit, refresh, enable, stage: (entries: GitChange[]) => mutate("stage", entries), unstage: (entries: GitChange[]) => mutate("unstage", entries), commit: () => mutate("commit"), history, historyLoading, historyError, historyPath, loadHistory, views, openDiff, refreshView, retainViews };
}
export type GitWorkbench = ReturnType<typeof createGitWorkbench>;
