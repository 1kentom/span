import { createEffect, createSignal, onCleanup } from "solid-js";
import { commands } from "../bindings";
import type { GitContext, GitHistoryToolsQuery, GitHistoryToolsPage, GitReflogPage, GitRevisionContent, GitRevisionDiff, GitHistoryPage } from "../bindings";

type Transport = Pick<typeof commands, "gitHistoryTools" | "gitReflogPage" | "gitRevisionContent" | "gitRevisionDiff" | "gitLineHistory">;
export function createGitHistoryTools(options: { context: () => GitContext | undefined; transport?: Transport }) {
  const transport = options.transport ?? commands;
  const [history, setHistory] = createSignal<GitHistoryToolsPage>();
  const [reflog, setReflog] = createSignal<GitReflogPage>();
  const [content, setContent] = createSignal<GitRevisionContent>();
  const [comparison, setComparison] = createSignal<GitRevisionDiff>();
  const [lines, setLines] = createSignal<GitHistoryPage>();
  const [lineRange, setLineRange] = createSignal<{ revision: string; path: string; start: number; end: number }>();
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal<Record<string, boolean>>({});
  let epoch = 0, identity = "", disposed = false;
  const requests = new Map<string, number>();
  let query: GitHistoryToolsQuery = { heads: [], skip: 0, limit: 50, author: null, message: null, path: null };
  let range: { revision: string; path: string; start: number; end: number } | undefined;
  function sync() {
    const ctx = options.context();
    const key = ctx?.enabled && ctx.repository ? `${ctx.workspaceRoot}\0${ctx.repository.id}\0${ctx.repository.root}` : "";
    if (identity !== key) {
      identity = key; epoch++; requests.clear(); setHistory(undefined); setReflog(undefined); setContent(undefined); setComparison(undefined); setLines(undefined); setErrors({}); setBusy({}); range = undefined; setLineRange(undefined);
    }
    return key ? ctx : undefined;
  }
  createEffect(sync);
  onCleanup(() => { disposed = true; epoch++; });
  async function run<T>(key: string, fetch: (ctx: GitContext) => Promise<T>, accept: (value: T) => void) {
    const ctx = sync(); if (!ctx) return;
    const generation = epoch, request = (requests.get(key) ?? 0) + 1; requests.set(key, request);
    setBusy(value => ({ ...value, [key]: true })); setErrors(value => ({ ...value, [key]: "" }));
    const current = () => { sync(); return !disposed && epoch === generation && requests.get(key) === request; };
    try { const value = await fetch(ctx); if (current()) accept(value); }
    catch (error) { if (current()) setErrors(value => ({ ...value, [key]: error instanceof Error ? error.message : String(error) })); }
    finally { if (current()) setBusy(value => ({ ...value, [key]: false })); }
  }
  function search(filters: { author?: string; message?: string; path?: string } = {}, more = false) {
    sync();
    if (more && (busy().history || history()?.nextSkip == null)) return Promise.resolve();
    if (!more) { query = { heads: [], skip: 0, limit: 50, author: filters.author || null, message: filters.message || null, path: filters.path || null }; setHistory(undefined); }
    const request = { ...query, heads: more ? history()!.heads : [], skip: more ? history()!.nextSkip! : 0 };
    return run("history", ctx => transport.gitHistoryTools(ctx, request), page => {
      query = request;
      setHistory(previous => more && previous ? { ...page, refs: previous.refs, commits: [...previous.commits, ...page.commits] } : page);
    });
  }
  function loadReflog(more = false) {
    if (more && (busy().reflog || reflog()?.nextSkip == null)) return Promise.resolve();
    const skip = more ? reflog()!.nextSkip! : 0;
    return run("reflog", ctx => transport.gitReflogPage(ctx, skip, 50), page => setReflog(previous => more && previous ? { ...page, entries: [...previous.entries, ...page.entries] } : page));
  }
  function lineHistory(revision: string, path: string, start: number, end: number, more = false) {
    sync();
    if (more && (busy().lines || lines()?.nextSkip == null || !range)) return Promise.resolve();
    if (!more) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > 10_000_000) { setErrors(value => ({ ...value, lines: "Use whole line numbers from 1 to 10000000, with end at or after start." })); return Promise.resolve(); }
      range = { revision, path, start, end }; setLineRange(range); setLines(undefined);
    }
    const selected = { ...range! }, skip = more ? lines()!.nextSkip! : 0;
    // Subsequent pages use the resolved immutable revision returned by Git.
    const anchor = more ? lines()?.anchor ?? selected.revision : selected.revision;
    return run("lines", ctx => transport.gitLineHistory(ctx, anchor, selected.path, selected.start, selected.end, skip, 50), page => {
      range = { ...selected, revision: page.anchor ?? anchor }; setLineRange(range);
      setLines(previous => more && previous ? { ...page, commits: [...previous.commits, ...page.commits] } : page);
    });
  }
  return { history, reflog, content, comparison, lines, lineRange, busy, errors, search, loadReflog, lineHistory,
    read: (revision: string, path: string) => { setContent(undefined); return run("content", ctx => transport.gitRevisionContent(ctx, revision, path), setContent); },
    compare: (from: string, to: string | null, path: string | null) => { setComparison(undefined); return run("comparison", ctx => transport.gitRevisionDiff(ctx, from, to, path), setComparison); },
  };
}
