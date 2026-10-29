import { createSignal } from "solid-js";

/** The Git sidebar view holds repository workflows and commit history. */
export type GitSubView = "changes" | "history" | "branches" | "stashes" | "worktrees";
/** History covers the whole repository or the single file the user asked about. */
export type GitHistoryScope = "all" | "file";

export const GIT_SUBVIEW_KEY = "span.git.subview";

type GitViewStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): GitViewStorage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

/** Sidebar Git view state: the sub-view (remembered per session) and the history scope. */
export function createGitView(storage: GitViewStorage | undefined = defaultStorage()) {
  const read = (): GitSubView => {
    try { const value = storage?.getItem(GIT_SUBVIEW_KEY); return value && ["history", "branches", "stashes", "worktrees"].includes(value) ? value as GitSubView : "changes"; } catch { return "changes"; }
  };
  const [subView, setSubViewSignal] = createSignal<GitSubView>(read());
  const [scope, setScope] = createSignal<GitHistoryScope>("all");
  // An explicit file named by a context menu or editor action; undefined follows the active editor.
  const [target, setTarget] = createSignal<string>();
  function setSubView(next: GitSubView) {
    setSubViewSignal(next);
    try { storage?.setItem(GIT_SUBVIEW_KEY, next); } catch { /* Rendering does not depend on storage. */ }
  }
  /** Opens History over every commit, as the panel switch and generic commands do. */
  function showHistory() { setSubView("history"); }
  /** Opens History scoped to one file, as file context menus and editor actions do. */
  function showFileHistory(path: string) { setTarget(path); setScope("file"); setSubView("history"); }
  function chooseScope(next: GitHistoryScope) { if (next === "all") setTarget(undefined); setScope(next); }
  return { subView, setSubView, scope, setScope: chooseScope, target, showHistory, showFileHistory };
}

export type GitView = ReturnType<typeof createGitView>;
