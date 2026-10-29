import type { BufferSnapshot, EditProposal, SessionKey } from "../../bindings";
import { agentChildPermission, agentDelegationStatus, agentSessions } from "../client";
import { busyState, isBusyPromptError } from "../agent-chats";
import type { ChildPermission } from "../agent-delegation";
import type { AgentErrorInfo } from "../agent-errors";
import { buildHandoff, carryFeed } from "../agent-handoff";
import { BRANCH_CONTEXT_NOTE, branchCut, branchReason, type BranchMode } from "../agent-rewind";
import { addFeedItem, dropRequest, markUrlOpened, resolvePermission, resolveProposal, type Failure } from "../agent-session";
import { coerceAnswer, formFields } from "../agent-view";
import type { SavedConfig } from "../last-config";
import { beginSteer, beginTurn, pickSending, planDrain, planFlushSteer, promptBusy, promptFailed, routeSubmit, settleTurn, steerCancelFailed, steerCancelled, takeRefused, type Dispatch } from "./thread-queue";
import type { Handoff, Queued, ThreadSeed, ThreadState } from "./thread-state";

/**
 * Actions of one thread (ADR 0011 phase 2). Every backend call goes to the keyed command for the thread's own key, so
 * a prompt, a cancel or an answer on one thread can never reach another session.
 */

/** The keyed backend commands a thread uses. Defaults to the real client; tests pass fakes. */
export type ThreadClient = {
  prompt: (key: SessionKey, text: string, attachments?: Queued["attachments"]) => Promise<void>;
  cancel: (key: SessionKey) => Promise<void>;
  permission: (key: SessionKey, requestId: string, optionId: string | null) => Promise<void>;
  elicitation: (key: SessionKey, requestId: string, action: "accept" | "decline" | "cancel", contentJson?: string | null) => Promise<void>;
  setConfig: (key: SessionKey, configId: string, value: string) => Promise<void>;
  review: (key: SessionKey, proposalId: string, accept: boolean, expectedRevision: number) => Promise<BufferSnapshot>;
  reviewHunks: (key: SessionKey, proposalId: string, acceptedHunkIds: string[], expectedRevision: number) => Promise<BufferSnapshot>;
  open: (options: { connectionId?: string }) => Promise<SessionKey>;
  /** A delegated child's request is answered on the child's own key. */
  childPermission: (connectionId: string, sessionId: string, requestId: string, optionId: string | null) => Promise<void>;
  delegationStatus: typeof agentDelegationStatus;
};

/** The real keyed client. Each call reads `agentSessions` when it runs, so holding a thread sends and imports nothing. */
export const defaultThreadClient = (): ThreadClient => ({
  prompt: (...args) => agentSessions.prompt(...args),
  cancel: (key) => agentSessions.cancel(key),
  permission: (...args) => agentSessions.permission(...args),
  elicitation: (...args) => agentSessions.elicitation(...args),
  setConfig: (...args) => agentSessions.setConfig(...args),
  review: (...args) => agentSessions.review(...args),
  reviewHunks: (...args) => agentSessions.reviewHunks(...args),
  open: (options) => agentSessions.open(options),
  childPermission: (...args) => agentChildPermission(...args),
  delegationStatus: () => agentDelegationStatus(),
});

/** What a thread tells its owner, for the parts that live outside it (metadata, remembered options, buffers). */
export type ThreadHooks = {
  /** The name the agent goes by in sentences, for limit cards. */
  agentLabel?: () => string;
  onPromptSent?: (entry: Queued, itemId: number) => void;
  onLimit?: (limit: AgentErrorInfo) => void;
  onConfigSet?: (configId: string, value: string) => void;
  onAccepted?: (proposal: EditProposal, buffer: BufferSnapshot, hunkIds?: readonly string[]) => void;
};

export type ThreadContext = {
  key: SessionKey;
  get: () => ThreadState;
  set: (change: (state: ThreadState) => ThreadState) => void;
  /** False once the thread is disposed: late results change nothing. */
  alive: () => boolean;
  online: () => boolean;
  setPending: (value: string) => void;
  pending: () => string;
  client: ThreadClient;
  hooks: ThreadHooks;
  nextId: () => string;
  now?: () => number;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The text of a rejected call, including a plain `{ message }` object. */
const causeText = (error: unknown) => (error && typeof error === "object" && !(error instanceof Error) && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : errorText(error));

/** True while the thread can take a prompt: it has its session and the connection is up. */
export const isConnected = (state: ThreadState) => Boolean(state.conversation.sessionId) && !["disconnected", "error", "unavailable", "connecting"].includes(state.conversation.status);

export function createThreadActions(ctx: ThreadContext) {
  const { key, get, set, client, hooks } = ctx;
  const now = ctx.now ?? Date.now;
  const fail = (failure: Failure) => set((state) => ({ ...state, conversation: { ...state.conversation, failure } }));
  const running = () => get().conversation.running;

  async function dispatch(entry: Queued, options: { steered?: boolean; sentNow?: boolean } = {}) {
    const start = beginTurn(get(), entry, { ...options, now: now() });
    set(() => start.state);
    try {
      await client.prompt(key, start.message, entry.attachments);
      hooks.onPromptSent?.(entry, start.itemId);
    } catch (cause) {
      if (!ctx.alive()) return;
      if (isBusyPromptError(cause)) {
        set((state) => promptBusy(state, start, entry, busyState(cause)));
        return;
      }
      const failed = promptFailed(get(), start, entry, { message: errorText(cause), cause: causeText(cause), agent: hooks.agentLabel?.() ?? "" });
      set(() => failed.state);
      if (failed.limit) hooks.onLimit?.(failed.limit);
    } finally {
      set(settleTurn);
    }
  }
  const run = (plan: { state: ThreadState; dispatch?: Dispatch }) => {
    set(() => plan.state);
    if (plan.dispatch) void dispatch(plan.dispatch.entry, plan.dispatch);
  };
  function flushSteer() {
    run(planFlushSteer(get()));
  }
  function drain(options: { force?: boolean } = {}) {
    run(planDrain(get(), { connected: isConnected(get()), online: ctx.online(), force: options.force, nextId: ctx.nextId }));
  }
  async function startSteer(entry: Queued) {
    const hadSteer = Boolean(get().steering);
    set((state) => beginSteer(state, entry));
    if (hadSteer) return;
    try {
      await client.cancel(key);
    } catch (cause) {
      if (ctx.alive()) set((state) => steerCancelFailed(state, entry, errorText(cause)));
      return;
    }
    if (!ctx.alive() || get().steering?.entry !== entry) return;
    set((state) => steerCancelled(state, entry));
    flushSteer();
  }
  /**
   * A composed message: steers the running turn (`steer`), or goes out now or behind the running turn (`queue`). ACP
   * v1 has no steer primitive, so a steer cancels the turn and sends the message as the next prompt.
   */
  function submit(entry: Queued, mode: "queue" | "steer") {
    if (running()) set((state) => ({ ...state, busyNotice: false }));
    const route = routeSubmit(get(), mode, ctx.online());
    if (route === "steer") void startSteer(entry);
    else if (route === "queue") set((state) => ({ ...state, queue: [...state.queue, entry] }));
    else void dispatch(entry);
  }
  /** Stops the running turn. */
  async function cancel() {
    if (!running() || get().conversation.stopRequested) return;
    set((state) => ({ ...state, conversation: { ...state.conversation, stopRequested: true, statusMessage: "Waiting for cancellation" } }));
    try {
      await client.cancel(key);
    } catch (cause) {
      if (ctx.alive()) set((state) => ({ ...state, conversation: { ...state.conversation, stopRequested: false, failure: { phase: "prompt", message: `Could not cancel the turn: ${errorText(cause)}` } } }));
    }
  }
  function sendQueuedNow(id: string) {
    set((state) => pickSending(state, id));
    if (running()) void cancel();
    else drain({ force: true });
  }
  /** Runs one request-answering call with the pending marker set, reporting a failure on the card. */
  async function answering(id: string, call: () => Promise<void>, failure: (cause: unknown) => void) {
    ctx.setPending(id);
    try {
      await call();
    } catch (cause) {
      if (ctx.alive()) failure(cause);
    } finally {
      if (ctx.alive()) ctx.setPending("");
    }
  }
  const answerPermission = (requestId: string, optionId: string | null) =>
    answering(requestId, async () => {
      await client.permission(key, requestId, optionId);
      if (ctx.alive()) set((state) => ({ ...state, conversation: resolvePermission(state.conversation, requestId) }));
    }, (cause) => fail({ phase: "prompt", message: `Permission response failed: ${errorText(cause)}` }));
  /** Answers a delegated child's request, on the child's key. Only the user's click calls this. */
  const answerChildPermission = (request: ChildPermission, optionId: string | null) =>
    answering(request.event.requestId, async () => {
      await client.childPermission(request.child.connectionId, request.child.sessionId, request.event.requestId, optionId);
      if (ctx.alive()) set((state) => ({ ...state, conversation: dropRequest(state.conversation, request.event.requestId) }));
    }, (cause) => fail({ phase: "prompt", message: `Permission response for ${request.agentName} failed: ${errorText(cause)}` }));
  const respondElicitation = (requestId: string, action: "accept" | "decline" | "cancel", content: string | null = null) =>
    answering(requestId, () => client.elicitation(key, requestId, action, content), (cause) => {
      const progress = get().form;
      if (progress?.requestId === requestId) set((state) => ({ ...state, form: { ...progress, error: errorText(cause) } }));
      else fail({ phase: "prompt", message: `Could not answer the agent: ${errorText(cause)}` });
    });
  /** One answer of an elicitation form; the last one sends every value. */
  async function answerForm(answer: { optionId?: string; text?: string }) {
    const pending = get().conversation.elicitations[0];
    const progress = get().form;
    if (!pending || !progress || progress.requestId !== pending.requestId) return;
    const list = pending.mode === "form" ? formFields(pending.schemaJson) : [];
    if (!list.length) return respondElicitation(pending.requestId, "accept", null);
    const field = list[progress.index];
    const result = coerceAnswer(field, answer);
    if ("error" in result) return set((state) => ({ ...state, form: { ...progress, error: result.error } }));
    const values = { ...progress.values, [field.key]: result.value };
    if (progress.index + 1 < list.length) return set((state) => ({ ...state, form: { requestId: progress.requestId, index: progress.index + 1, values } }));
    set((state) => ({ ...state, form: { ...progress, values, error: undefined } }));
    await respondElicitation(pending.requestId, "accept", JSON.stringify(values));
  }
  /** The user opened a URL request's page (the caller opened it): the record reads Opened and the request is accepted. */
  async function urlOpened(requestId: string) {
    set((state) => ({ ...state, conversation: markUrlOpened(state.conversation, requestId) }));
    await respondElicitation(requestId, "accept");
  }
  async function setConfig(configId: string, value: string, restoring?: Promise<void>) {
    const option = get().conversation.config.find((candidate) => candidate.id === configId);
    if (!option || value === option.currentValue) return;
    await answering(`config:${configId}`, async () => {
      await restoring;
      await client.setConfig(key, configId, value);
      hooks.onConfigSet?.(configId, value);
    }, (cause) => fail({ phase: "session", message: `Could not change ${option.name}: ${errorText(cause)}` }));
  }
  /** Switches this session to another model and sends the refused turn again. Only the turn this session refused. */
  async function retryWithModel(value: string) {
    const state = get();
    const option = state.conversation.config.find((candidate) => candidate.category === "model");
    const turn = state.refused;
    if (!option || !turn || turn.sessionId !== state.conversation.sessionId || running()) return;
    ctx.setPending("auth");
    try {
      await client.setConfig(key, option.id, value);
      hooks.onConfigSet?.(option.id, value);
      if (!ctx.alive() || get().refused !== turn) return;
      const taken = takeRefused(get(), { auth: undefined });
      set(() => taken.state);
      if (taken.entry) void dispatch(taken.entry);
    } catch (cause) {
      if (ctx.alive()) fail({ phase: "session", message: `Could not change the model: ${errorText(cause)}` });
    } finally {
      if (ctx.alive()) ctx.setPending("");
    }
  }
  /** Retry from the limit card: the same turn, same session and model. Only on a click. */
  function retryLimited() {
    const state = get();
    if (!state.refused?.limit || state.refused.sessionId !== state.conversation.sessionId || running() || !isConnected(state)) return;
    const taken = takeRefused(state);
    set(() => taken.state);
    if (taken.entry) void dispatch(taken.entry);
  }
  async function review(proposal: EditProposal, accept: boolean) {
    await answering(proposal.id, async () => {
      const buffer = await client.review(key, proposal.id, accept, proposal.baseRevision);
      if (!ctx.alive()) return;
      set((state) => ({ ...state, conversation: resolveProposal(state.conversation, proposal.id, accept) }));
      if (accept) hooks.onAccepted?.(proposal, buffer);
    }, (cause) => fail({ phase: "prompt", message: `Edit review failed, the editor buffer may have changed: ${errorText(cause)}` }));
  }
  async function reviewHunks(proposal: EditProposal, acceptedHunkIds: string[]) {
    if (ctx.pending()) return;
    await answering(proposal.id, async () => {
      const buffer = await client.reviewHunks(key, proposal.id, acceptedHunkIds, proposal.baseRevision);
      if (!ctx.alive()) return;
      const accepted = acceptedHunkIds.length > 0;
      set((state) => ({ ...state, conversation: resolveProposal(state.conversation, proposal.id, accepted) }));
      if (accepted) hooks.onAccepted?.(proposal, buffer, acceptedHunkIds);
    }, (cause) => fail({ phase: "prompt", message: `Hunk review failed, the editor buffer may have changed: ${errorText(cause)}` }));
  }
  /** Edit: the message's text goes into the composer; the next send starts a new session from before it. */
  function editFrom(itemId: number) {
    const state = get();
    const item = state.conversation.feed.find((entry) => entry.id === itemId);
    if (item?.kind !== "user") return;
    const draft = state.rewind?.mode === "edit" ? state.rewind.draft : state.draft;
    set((current) => ({ ...current, rewind: { itemId, sessionId: current.conversation.sessionId, mode: "edit", draft }, draft: item.text }));
  }
  /** Restore: shows the files changed since the message. Nothing else changes. */
  function restoreTo(itemId: number) {
    const state = get();
    if (state.conversation.feed.find((entry) => entry.id === itemId)?.kind !== "user") return;
    const editing = state.rewind?.mode === "edit";
    const draft = editing ? state.rewind!.draft : state.draft;
    set((current) => ({ ...current, draft: editing ? draft : current.draft, rewind: { itemId, sessionId: current.conversation.sessionId, mode: "restore", draft } }));
  }
  /** Leaves edit or restore. Edit gives the earlier draft back. */
  function cancelRewind() {
    set((state) => ({ ...state, draft: state.rewind?.mode === "edit" ? state.rewind.draft : state.draft, rewind: undefined }));
  }

  return { dispatch, submit, send: (entry: Queued) => submit(entry, "queue"), steer: (entry: Queued) => submit(entry, "steer"), queue: (entry: Queued) => set((state) => ({ ...state, queue: [...state.queue, entry] })), cancel, drain, flushSteer, sendQueuedNow, answerPermission, answerChildPermission, respondElicitation, answerForm, urlOpened, setConfig, retryWithModel, retryLimited, review, reviewHunks, editFrom, restoreTo, cancelRewind };
}
export type ThreadActions = ReturnType<typeof createThreadActions>;

/** Why edit, resend or fork cannot start a new session right now. Pending proposals belong to this session. */
export function branchBlock(state: ThreadState, pendingProposals: number): string | undefined {
  if (!isConnected(state)) return "Connect an agent first.";
  if (state.conversation.running) return "Wait for the agent to finish this turn.";
  if (pendingProposals) return `${pendingProposals === 1 ? "1 edit waits" : `${pendingProposals} edits wait`} for review. Accept or reject ${pendingProposals === 1 ? "it" : "them"} before starting a new session.`;
  return undefined;
}

/**
 * The seed of a thread that starts from an earlier message (edit, resend or fork). ACP cannot rewind or fork a session,
 * so the new session shows the feed up to the cut with a divider, and those turns go out as context with its first
 * prompt. `source` is the options the new session starts on. Undefined when the message cannot be cut there.
 */
export function branchSeed(state: ThreadState, itemId: number, mode: BranchMode, options: { from: string; root?: string; sessionId: string }): { seed: ThreadSeed; source: SavedConfig } | undefined {
  const feed = state.conversation.feed;
  const cut = branchCut(feed, itemId, mode);
  if (cut === undefined) return undefined;
  const earlier = feed.slice(0, cut);
  const text = buildHandoff(earlier, { from: options.from, root: options.root, reason: branchReason(mode) });
  const source: SavedConfig = Object.fromEntries(state.conversation.config.map((option) => [option.id, option.currentValue]));
  const nextId = state.conversation.nextId + 1;
  const seed: ThreadSeed = {
    conversation: { feed: [...carryFeed(earlier), { id: nextId, kind: "branch", mode, carried: Boolean(text) }], nextId },
    handoff: text ? { from: options.from, to: options.from, text, sessionId: options.sessionId, note: BRANCH_CONTEXT_NOTE } : undefined,
    ...(mode === "fork" ? { draft: state.draft, attachments: state.attachments } : {}),
  };
  return { seed, source };
}

/** The switched-to session is ready: a divider marks the switch and the carried context waits for the first prompt. */
export function finishHandoff(state: ThreadState, pending: Handoff): ThreadState {
  if (pending.sessionId) return state;
  const conversation = addFeedItem(state.conversation, { kind: "handoff", from: pending.from, to: pending.to, carried: Boolean(pending.text) });
  return { ...state, conversation, handoff: pending.text ? { ...pending, sessionId: state.key.sessionId } : undefined };
}
