import { createSignal, onCleanup } from "solid-js";
import type { SessionKey } from "../../bindings";
import type { BranchMode } from "../agent-rewind";
import { sessionKeyId } from "../agent-stores/live-sessions";
import { sharedStore } from "../agent-stores/shared";
import { branchBlock, branchSeed, defaultThreadClient } from "./thread-actions";
import { createThread, type Thread, type ThreadOptions } from "./thread";
import type { Queued, ThreadSeed } from "./thread-state";

/**
 * Every thread the app holds, one per session key (ADR 0011 phase 2). The sidebar shows one of them (the focused
 * thread) and the Agents page shows many; each thread hears only its own events. Closing a thread, or the last holder
 * letting go of the registry, disposes it.
 */
export function createThreadRegistry(defaults: Omit<ThreadOptions, "seed" | "restore" | "owned"> = {}) {
  const threads = new Map<string, Thread>();
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((value) => value + 1);
  onCleanup(() => {
    for (const thread of threads.values()) thread.dispose();
    threads.clear();
  });

  const get = (key: SessionKey) => threads.get(sessionKeyId(key));
  /** The thread for `key`, created (with `seed`) when the registry does not hold it yet. */
  function open(key: SessionKey, options: Pick<ThreadOptions, "seed" | "restore"> = {}): Thread {
    const existing = get(key);
    if (existing) return existing;
    const thread = createThread(key, { ...defaults, ...options, owned: false });
    threads.set(sessionKeyId(key), thread);
    bump();
    return thread;
  }
  /** Disposes the thread for `key`: it unsubscribes, stops its timers and is forgotten. */
  function close(key: SessionKey) {
    const id = sessionKeyId(key);
    const thread = threads.get(id);
    if (!thread) return false;
    threads.delete(id);
    thread.dispose();
    bump();
    return true;
  }
  /**
   * Edit, resend or fork from a message of `from`: a new session on the same connection, seeded with the feed up to the
   * message and the carried context, on the same options. `entry` goes out at once (edit and resend). Returns the new
   * thread, or undefined when the branch cannot start (the reason is the thread's `branchBlock`).
   */
  async function branch(from: Thread, itemId: number, mode: BranchMode, options: { agentLabel: string; root?: string; entry?: Queued }): Promise<Thread | undefined> {
    if (branchBlock(from.state(), from.proposals().length)) return undefined;
    const planned = branchSeed(from.state(), itemId, mode, { from: options.agentLabel, root: options.root, sessionId: "" });
    if (!planned) return undefined;
    const key = await (defaults.client ?? defaultThreadClient()).open({ connectionId: from.key.connectionId });
    const { handoff } = planned.seed;
    const seed: ThreadSeed = { ...planned.seed, handoff: handoff ? { ...handoff, sessionId: key.sessionId } : undefined };
    const thread = open(key, { seed, restore: planned.source });
    if (options.entry) void thread.dispatch(options.entry);
    return thread;
  }

  return {
    open,
    get,
    has: (key: SessionKey) => threads.has(sessionKeyId(key)),
    close,
    branch,
    /** Every held thread, reactive to opens and closes. */
    list: () => (version(), [...threads.values()]),
    size: () => (version(), threads.size),
  };
}

export type ThreadRegistry = ReturnType<typeof createThreadRegistry>;

/** The app's one thread registry. */
export const agentThreads = sharedStore(() => createThreadRegistry());
