import { batch, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { GitChange, GitCommit, GitContext, GitDiff, GitDiffSide, GitHistoryPage, GitStatus } from "../bindings";
import { api } from "../lib/client";

type GitTransport = Pick<typeof api, "gitContext" | "gitEnable" | "gitStatus" | "gitDiff" | "gitHistory" | "gitCommitDiff" | "gitStage" | "gitUnstage" | "gitCommit">;
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

export function createGitWorkbench(options: { root: () => string | undefined; generation: () => number; active: () => boolean; blocked: () => boolean; available: boolean; onOpenView: (key: string, title: string) => void; transport?: GitTransport }) {
  const transport = options.transport ?? api;
  const [context, setContext] = createSignal<GitContext>();
  const [status, setStatus] = createSignal<GitStatus>();
  const [loading, setLoading] = createSignal(false);
  const [operation, setOperation] = createSignal<string>();
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [warning, setWarning] = createSignal("");
  const [message, setMessageState] = createSignal("");
  let messageVersion = 0;
  function setMessage(value: string) { messageVersion++; setMessageState(value); }
  const [history, setHistory] = createSignal<GitHistoryPage>();
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal("");
  const [historyPath, setHistoryPath] = createSignal<string>();
  const [views, setViews] = createSignal<Record<string, GitView>>({});
  let epoch = 0; let disposed = false; let contextRequest = 0; let historyRequest = 0;
  let refreshPending: Promise<void> | undefined;
  const viewRequests = new Map<string, number>();
  const live = (token: number) => !disposed && epoch === token;
  const report = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  const changed = () => status()?.entries.filter(workingChange) || [];
  const staged = () => status()?.entries.filter(stagedChange) || [];
  const mutable = (entry: GitChange) => !!entry.path && !entry.unsupportedReason && !entry.conflicted && !entry.submodule;
  const ready = () => !!context()?.enabled && !!context()?.repository && !!status() && status()?.repository.id === context()?.repository?.id && !loading() && !operation() && !options.blocked();
  const canCommit = () => ready() && !!message().trim() && !!staged().length && !status()?.truncated && !status()?.operation && !status()?.entries.some(entry => entry.conflicted);

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
        if (next.repository?.id !== context()?.repository?.id) {
          setStatus(undefined);
          if (context()?.repository) { setViews({}); viewRequests.clear(); setHistory(undefined); historyRequest++; setHistoryLoading(false); }
        }
        setContext(next);
        if (!next.repository || !next.enabled) {
          setStatus(undefined); setError(""); setHistory(undefined); setHistoryLoading(false); historyRequest++;
          return;
        }
        const snapshot = await transport.gitStatus(next);
        if (!live(token) || request !== contextRequest) return;
        if (snapshot.repository.id !== next.repository.id) throw new Error("The Git repository changed. Refresh to review the current repository.");
        setStatus(snapshot); setError("");
      } catch (cause) { if (live(token) && request === contextRequest) setError(report(cause)); }
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
    setOperation("enable"); setError("");
    try {
      const snapshot = await transport.gitEnable(ctx);
      if (!live(token)) return false;
      if (snapshot.repository.id !== ctx.repository.id) throw new Error("The repository changed before Git was enabled. Refresh and review its location.");
      batch(() => { setContext({ ...ctx, enabled: true, repository: snapshot.repository }); setStatus(snapshot); });
      return true;
    } catch (cause) { if (live(token)) setError(report(cause)); return false; }
    finally { if (live(token)) setOperation(undefined); }
  }
  async function mutate(kind: "stage" | "unstage" | "commit", entries: GitChange[] = []) {
    if (!ready()) return false;
    const ctx = context()!; const before = status()!; const token = epoch; const draft = message(); const draftVersion = messageVersion;
    if (kind === "commit" && !canCommit()) return false;
    const paths = entries.filter(mutable).map(entry => entry.path!);
    if (kind !== "commit" && !paths.length) return false;
    setOperation(kind); setError(""); setNotice(""); setWarning("");
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
        if (committedId) {
          if (messageVersion === draftVersion) setMessage("");
          setNotice(`Committed ${committedId.slice(0, 8)}${committed ? `: ${committed.subject}` : ""}`);
          setWarning(commitWarning || "");
          setHistory(undefined); setHistoryLoading(false); setHistoryError(""); historyRequest++;
        }
      });
      return true;
    } catch (cause) { if (live(token)) setError(report(cause)); return false; }
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
      setViews(current => ({ ...current, [key]: { ...current[key], diff, loading: false } }));
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
    epoch++; contextRequest++; historyRequest++; refreshPending = undefined; viewRequests.clear();
    batch(() => { setContext(undefined); setStatus(undefined); setLoading(false); setOperation(undefined); setError(""); setNotice(""); setWarning(""); setMessage(""); setHistory(undefined); setHistoryPath(undefined); setHistoryLoading(false); setHistoryError(""); setViews({}); });
  }));
  createEffect(() => {
    if (!options.active() || options.blocked() || !options.available || !options.root()) return;
    if (!context() && !loading() && !error()) void refresh();
    if (!context()?.enabled) return;
    const timer = setInterval(() => { if (!operation()) void refresh(); }, 2500);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => { disposed = true; epoch++; });
  return { hasWorkspace: () => !!options.root(), context, status, loading, operation, error, notice, warning, message, setMessage, staged, changed, mutable, ready, canCommit, refresh, enable, stage: (entries: GitChange[]) => mutate("stage", entries), unstage: (entries: GitChange[]) => mutate("unstage", entries), commit: () => mutate("commit"), history, historyLoading, historyError, historyPath, loadHistory, views, openDiff, refreshView, retainViews };
}
export type GitWorkbench = ReturnType<typeof createGitWorkbench>;
