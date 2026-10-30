import { createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup } from "solid-js";
import type { AgentKeyedEvent_Serialize as AgentKeyedEvent, EditProposal, SessionKey, SessionRuntimeState_Serialize as SessionRuntimeState } from "../../bindings";
import type { ChatSnapshot } from "../agent-chats";
import { childPermissions, isFinished } from "../agent-delegation";
import { applyDelegationStatus, openPermission, unresolvedProposals } from "../agent-session";
import { changesAfter } from "../agent-rewind";
import { chooseRestores, type SavedConfig } from "../last-config";
import { liveSessions, sessionKeyId, type LiveSessions } from "../agent-stores/live-sessions";
import { createThreadActions, defaultThreadClient, isConnected, type ThreadClient, type ThreadHooks } from "./thread-actions";
import { applyRuntime, reduceThreadEvent, type ThreadEffect, type ToolEvent } from "./thread-events";
import { clearQueue, editQueued, removeQueued, reorderQueue } from "./thread-queue";
import { initialThreadState, type ThreadSeed, type ThreadState } from "./thread-state";

export const DELEGATION_POLL_MS = 3000;

/** The keyed event source a thread follows. The app's live sessions store by default. */
export type ThreadEvents = Pick<LiveSessions, "onSession" | "onConnection">;

export type ThreadOptions = {
  seed?: ThreadSeed;
  /** Options the new session should get once the agent reports them (a branch, or a fresh session). */
  restore?: SavedConfig;
  events?: ThreadEvents;
  client?: ThreadClient;
  hooks?: ThreadHooks & {
    /** Every effect of an event, after the thread ran its own part. */
    onEffect?: (effect: ThreadEffect, state: ThreadState) => void;
  };
  /** Polls the delegation status while a delegated task runs. Off in tests that do not need it. */
  pollDelegation?: boolean;
  online?: () => boolean;
  /** Disposed with the calling owner (default). Off for a registry that disposes its threads itself. */
  owned?: boolean;
};

let queueCounter = 0;
const nextQueueId = () => `t-${++queueCounter}`;

/**
 * One agent thread (ADR 0011 phase 2): a self-contained store for one session key. It hears only its own keyed
 * events (and the connection level events of its connection, and its delegated children's permission requests),
 * keeps its feed, composer, queue, steer, requests, review, rewind and scroll state, and sends every command on its
 * own key. It lives in its own reactive root: `dispose` (or the calling owner's cleanup) unsubscribes and stops its
 * timers.
 */
export function createThread(key: SessionKey, options: ThreadOptions = {}) {
  let release!: () => void;
  const thread = createRoot((dispose) => {
    release = dispose;
    return build(key, options);
  });
  const dispose = () => {
    thread.markDisposed();
    release();
  };
  if (options.owned !== false && getOwner()) onCleanup(dispose);
  return { ...thread, dispose };
}

function build(key: SessionKey, options: ThreadOptions) {
  const [state, setState] = createSignal<ThreadState>(initialThreadState(key, options.seed));
  const [pending, setPending] = createSignal("");
  const [restoring, setRestoring] = createSignal<Promise<void>>();
  const client = options.client ?? defaultThreadClient();
  const hooks = options.hooks ?? {};
  const online = options.online ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  let disposed = false;
  const alive = () => !disposed;
  const set = (change: (current: ThreadState) => ThreadState) => {
    if (!disposed) setState(change);
  };
  /** First and latest update time of each tool call, for the tool bar. */
  const toolTimes = new Map<string, { start: number; last: number }>();
  /** Delegated child sessions this thread follows for permission requests. */
  const children = new Map<string, () => void>();
  let pendingMicrotask = false;

  const actions = createThreadActions({ key, get: state, set, alive, online, setPending, pending, client, hooks, nextId: nextQueueId });

  const events = options.events ?? liveSessions.use();
  const stops = [events.onSession(key, receive), events.onConnection(key.connectionId, receive)];
  onCleanup(() => {
    disposed = true;
    for (const stop of stops) stop();
    for (const stop of children.values()) stop();
    children.clear();
    toolTimes.clear();
  });

  function follow(child: SessionKey) {
    const id = sessionKeyId(child);
    if (children.has(id) || child.connectionId !== key.connectionId) return;
    children.set(id, events.onSession(child, receive));
  }
  function run(effect: ThreadEffect) {
    switch (effect.kind) {
      case "turnEnded":
        // After the event settles, like the sidebar: the steer first, then the queue.
        if (pendingMicrotask) break;
        pendingMicrotask = true;
        queueMicrotask(() => {
          pendingMicrotask = false;
          if (disposed) return;
          actions.flushSteer();
          actions.drain();
        });
        break;
      case "refreshDelegation":
        void refreshDelegation();
        break;
      case "delegated":
        follow(effect.child);
        break;
      case "tool": {
        const id = `${effect.event.sessionId}:${effect.event.toolCallId}`;
        const now = Date.now();
        toolTimes.set(id, { start: toolTimes.get(id)?.start ?? now, last: now });
        if (toolTimes.size > 500) toolTimes.delete(toolTimes.keys().next().value!);
        break;
      }
    }
    hooks.onEffect?.(effect, state());
  }
  /** Applies one keyed event. Exposed for replay and for the transitional sidebar adapter. */
  function receive(event: AgentKeyedEvent) {
    if (disposed) return;
    const step = reduceThreadEvent(state(), event);
    if (step.state !== state()) setState(step.state);
    for (const effect of step.effects) run(effect);
  }
  async function refreshDelegation() {
    try {
      const status = await client.delegationStatus();
      set((current) => ({ ...current, conversation: applyDelegationStatus(current.conversation, status) }));
    } catch {
      // The card keeps what the events reported.
    }
  }

  const conversation = createMemo(() => state().conversation);
  const feed = createMemo(() => conversation().feed);
  const running = createMemo(() => conversation().running);
  const connected = createMemo(() => isConnected(state()));
  const proposals = createMemo<EditProposal[]>(() => unresolvedProposals(feed()), [], {
    equals: (previous, next) => previous.length === next.length && previous.every((proposal, index) => proposal === next[index]),
  });
  const permission = createMemo(() => openPermission(feed()));
  const childPermissionList = createMemo(() => childPermissions(conversation().strayPermissions, feed().flatMap((item) => (item.kind === "delegation" ? [item.task] : [])), conversation().childRequests));
  const elicitation = createMemo(() => conversation().elicitations[0]);
  /** The picked message, only while it is still a user message of this thread. */
  const rewind = createMemo(() => {
    const chosen = state().rewind;
    return chosen && chosen.sessionId === conversation().sessionId && feed().some((item) => item.id === chosen.itemId && item.kind === "user") ? chosen : undefined;
  });
  const rewindFiles = (root?: string) => {
    const chosen = rewind();
    return chosen ? changesAfter(feed(), chosen.itemId, root) : [];
  };
  const canRetryModel = createMemo(() => {
    const turn = state().refused;
    return Boolean(turn && conversation().auth && turn.sessionId === conversation().sessionId);
  });
  const limitTurn = createMemo(() => {
    const turn = state().refused;
    return turn?.limit && turn.sessionId === conversation().sessionId && conversation().failure && !running() ? turn.limit : undefined;
  });

  // A new elicitation starts its form at the first field.
  createEffect(() => {
    const requestId = elicitation()?.requestId;
    set((current) => (current.form?.requestId === requestId ? current : { ...current, form: requestId ? { requestId, index: 0, values: {} } : undefined }));
  });
  // Progress text and results come from the polled status, so refresh it while a task is live.
  const hasLiveTask = createMemo(() => feed().some((item) => item.kind === "delegation" && !isFinished(item.task.status)));
  if (options.pollDelegation !== false) {
    createEffect(() => {
      if (!hasLiveTask()) return;
      const timer = setInterval(() => void refreshDelegation(), DELEGATION_POLL_MS);
      onCleanup(() => clearInterval(timer));
    });
  }
  // A new session gets its remembered (or continued) options once the agent reports them, unless a prompt went first.
  let restore = options.restore;
  createEffect(() => {
    const config = conversation().config;
    if (!restore || !config.length) return;
    const values = restore;
    restore = undefined;
    const restores = chooseRestores(config, values);
    if (!restores.length) return;
    const settled = (async () => {
      for (const [configId, value] of restores) {
        if (disposed || state().prompted || running()) return;
        try {
          await client.setConfig(key, configId, value);
        } catch {
          /* the agent may refuse, and the picker shows what it reports */
        }
      }
    })().finally(() => {
      if (restoring() === settled) setRestoring(undefined);
    });
    setRestoring(settled);
  });

  return {
    key,
    state,
    conversation,
    feed,
    running,
    connected,
    proposals,
    permission,
    childPermissions: childPermissionList,
    elicitation,
    rewind,
    rewindFiles,
    canRetryModel,
    limitTurn,
    pending,
    restoring,
    receive,
    /** The backend's runtime state of this session (focused: the sidebar shows it). */
    applyRuntime: (runtime: SessionRuntimeState | undefined, view: { focused: boolean; working: boolean }) => set((current) => applyRuntime(current, runtime, { ...view, now: Date.now() })),
    toolTimes: (event: ToolEvent) => toolTimes.get(`${event.sessionId}:${event.toolCallId}`),
    followedChildren: () => children.size,
    setDraft: (draft: string) => set((current) => ({ ...current, draft })),
    setAttachments: (attachments: ThreadState["attachments"]) => set((current) => ({ ...current, attachments })),
    setPinned: (pinned: boolean) => set((current) => ({ ...current, pinned })),
    setScrollTop: (scrollTop: number | undefined) => set((current) => ({ ...current, scrollTop })),
    dismissFailure: () => set((current) => ({ ...current, conversation: { ...current.conversation, failure: undefined } })),
    dismissBusyNotice: () => set((current) => ({ ...current, busyNotice: false })),
    editQueued: (id: string, text: string) => set((current) => editQueued(current, id, text)),
    removeQueued: (id: string) => set((current) => removeQueued(current, id)),
    reorderQueue: (from: number, to: number) => set((current) => reorderQueue(current, from, to)),
    clearQueue: () => set(clearQueue),
    /** Applies a change no event or action covers (the transitional sidebar adapter). */
    update: set,
    /** This thread as a background chat snapshot (agent-chats.ts), for the transitional adapter. */
    snapshot: (): ChatSnapshot => {
      const current = state();
      return { conversation: current.conversation, draft: current.draft, attachments: current.attachments, queue: current.queue, queueHeld: current.queueHeld, pinned: current.pinned, scrollTop: current.scrollTop, scrollAnchor: current.scrollAnchor, turnStart: current.turnStart, touchedAt: Date.now() };
    },
    markDisposed: () => {
      disposed = true;
    },
    ...actions,
    setConfig: (configId: string, value: string) => actions.setConfig(configId, value, restoring()),
  };
}

export type Thread = ReturnType<typeof createThread>;

/** The seed of a thread restored from a background chat snapshot (agent-chats.ts). */
export function seedFromSnapshot(chat: ChatSnapshot): ThreadSeed {
  return { conversation: chat.conversation, draft: chat.draft, attachments: chat.attachments, queue: chat.queue, queueHeld: chat.queueHeld, pinned: chat.pinned, scrollTop: chat.scrollTop, scrollAnchor: chat.scrollAnchor, turnStart: chat.turnStart };
}
