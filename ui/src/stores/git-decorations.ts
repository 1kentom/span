import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { GitContext, GitFileBaseline_Serialize } from "../bindings";
import { api } from "../lib/client";
import { gitFolderDecorations, gitPathDecorations } from "../lib/git-decorations";
import type { GitWorkbench } from "./git";

/** Read index baselines only after consent, and never let an old workspace response decorate a new one. */
export function createGitDecorations(options: {
  git: Pick<GitWorkbench, "context" | "status">;
  generation: () => number;
  paths: () => readonly string[];
  dirtyPaths: () => readonly string[];
  available: boolean;
  blocked?: () => boolean;
  transport?: { gitFileBaseline: (context: GitContext, path: string) => Promise<GitFileBaseline_Serialize> };
}) {
  const transport = options.transport ?? api;
  const [baselines, setBaselines] = createSignal<Record<string, GitFileBaseline_Serialize>>({});
  const files = createMemo(() => gitPathDecorations(options.git.context(), options.git.status(), options.dirtyPaths()));
  const folders = createMemo(() => gitFolderDecorations(files()));
  let epoch = 0, identity = "", disposed = false;
  const pending = new Map<string, number>();
  const attempted = new Set<string>();
  const failedAt = new Map<string, number>();
  let sequence = 0;
  createEffect(() => {
    const context = options.git.context(), status = options.git.status();
    const paths = [...new Set(options.paths().filter(path => !path.includes("://")))];
    const ready = options.available && context?.enabled && context.repository && status?.repository.id === context.repository.id;
    const nextIdentity = ready ? `${options.generation()}:${context.repository!.id}:${status!.repository.head}:${status!.indexRevision}` : `${options.generation()}:disabled`;
    if (identity !== nextIdentity) { identity = nextIdentity; epoch++; pending.clear(); attempted.clear(); failedAt.clear(); setBaselines({}); }
    if (!ready || options.blocked?.()) return;
    const prefix = context.repository!.workspacePrefix.replace(/\/$/, "");
    const token = epoch;
    // Bound concurrent native reads even when a restored session contains many tabs.
    const queue = paths.filter(path => !attempted.has(path) && (!failedAt.has(path) || Date.now() - failedAt.get(path)! >= 5_000));
    const load = async () => {
      while (queue.length && !disposed && epoch === token) {
        const path = queue.shift()!;
        if (attempted.has(path)) continue;
        const repositoryPath = prefix ? `${prefix}/${path}` : path;
        const entry = status!.entries.find(entry => entry.path === repositoryPath);
        attempted.add(path);
        if (entry?.conflicted || entry?.submodule || entry?.unsupportedReason) continue;
        const request = ++sequence;
        pending.set(path, request);
        try {
          const baseline = await transport.gitFileBaseline(context, repositoryPath);
          if (disposed || epoch !== token || pending.get(path) !== request) continue;
          if (baseline.repositoryId !== context.repository!.id || baseline.path !== repositoryPath || baseline.indexRevision !== status!.indexRevision) { attempted.delete(path); failedAt.set(path, Date.now()); continue; }
          setBaselines(current => ({ ...current, [path]: baseline }));
        } catch { if (!disposed && epoch === token) { attempted.delete(path); failedAt.set(path, Date.now()); } }
        finally { if (pending.get(path) === request) pending.delete(path); }
      }
    };
    const workers = Math.min(Math.max(0, 3 - pending.size), queue.length);
    for (let worker = 0; worker < workers; worker++) void load();
  });
  onCleanup(() => { disposed = true; epoch++; pending.clear(); });
  return {
    baseline: (path: string) => baselines()[path],
    status: (path: string, directory = false) => (directory ? folders() : files()).get(path),
  };
}
export type GitDecorations = ReturnType<typeof createGitDecorations>;
