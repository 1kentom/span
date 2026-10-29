import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { api } from "../lib/client";
import type { GitWorkbench } from "./git";

type Blame = Awaited<ReturnType<typeof api.gitBlame>>;

/** Blame is read for the active file only, and invalidated whenever HEAD or workspace changes. */
export function createGitLineInfo(options: {
  git: Pick<GitWorkbench, "context" | "status">;
  path: () => string | undefined;
  generation: () => number;
  available: boolean;
  blocked: () => boolean;
  transport?: Pick<typeof api, "gitBlame">;
}) {
  const transport = options.transport ?? api;
  const [enabled, setEnabled] = createSignal(true);
  const [value, setValue] = createSignal<{ path: string; generation: number; blame: Blame }>();
  const [error, setError] = createSignal("");
  let request = 0, disposed = false;
  const identity = createMemo(() => {
    const context = options.git.context(), status = options.git.status(), path = options.path();
    const prefix = context?.repository?.workspacePrefix.replace(/\/$/, "");
    const repositoryPath = prefix ? `${prefix}/${path}` : path;
    const unsupported = status?.entries.some(entry => entry.path === repositoryPath && (entry.conflicted || entry.untracked || entry.submodule || entry.unsupportedReason));
    return JSON.stringify([enabled(), options.available, options.blocked(), options.generation(), path, context?.enabled, context?.repository?.id, status?.repository.id, status?.repository.head, unsupported]);
  });
  createEffect(on(identity, () => {
    const context = options.git.context(), status = options.git.status(), path = options.path();
    const head = status?.repository.head;
    const generation = options.generation();
    const token = ++request;
    setValue(undefined); setError("");
    if (!enabled() || !options.available || options.blocked() || !path || path.includes("://") || !context?.enabled || !context.repository || !head || status?.repository.id !== context.repository.id) return;
    const prefix = context.repository.workspacePrefix.replace(/\/$/, "");
    const repositoryPath = prefix ? `${prefix}/${path}` : path;
    if (status.entries.some(entry => entry.path === repositoryPath && (entry.conflicted || entry.untracked || entry.submodule || entry.unsupportedReason))) return;
    const timer = setTimeout(() => {
      void transport.gitBlame(context, repositoryPath).then(blame => {
        if (disposed || token !== request || blame.repositoryId !== context.repository!.id || blame.path !== repositoryPath || blame.head !== head) return;
        setValue({ path, generation, blame });
      }).catch(cause => { if (!disposed && token === request) setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 180);
    onCleanup(() => clearTimeout(timer));
  }));
  onCleanup(() => { disposed = true; request++; });
  return {
    enabled, toggle: () => setEnabled(current => !current), error,
    blame: (path: string) => {
      const current = value(), context = options.git.context(), status = options.git.status();
      return enabled() && options.available && !options.blocked() && context?.enabled
        && current?.path === path && path === options.path() && current.generation === options.generation()
        && current.blame.repositoryId === context.repository?.id && current.blame.repositoryId === status?.repository.id
        && current.blame.head === status.repository.head ? current.blame : undefined;
    },
  };
}
export type GitLineInfo = ReturnType<typeof createGitLineInfo>;
