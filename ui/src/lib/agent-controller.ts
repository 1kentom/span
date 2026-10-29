import { batch, createComputed, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { AgentCommand, AgentEvent, ConfigOption, BufferSnapshot, EditProposal, InstalledAgent, SessionKey, SessionMetaPatch_Deserialize as SessionMetaPatch, SessionStates_Serialize as SessionStates } from "../bindings";
import { createAttachmentIntake, type AttachmentTabView } from "../components/attachments";
import type { AuthSecret, Phase } from "../components/agent/types";
import { agentAuthenticateWith, agentCancelTask, agentChildPermission, agentDelegationStatus, agentTaskTranscript, api, isDesktop, sessionExportMarkdown, sessionMetaSetArchived, sessionMetaSetTitle } from "./client";
import { exportFileName, exportTranscript, hasUntrackedEdits, hunkLineDelta, listedTitle, threadRowMeta } from "./session-threads";
import { childPermissions, isFinished, permissionWaitsOn, type ChildPermission } from "./agent-delegation";
import { agentCatalog } from "./agent-stores/catalog";
import { agentBackground } from "./agent-stores/background";
import { agentLimits } from "./agent-stores/limits";
import { agentHistory } from "./agent-stores/history";
import { agentConnection, NO_STATES } from "./agent-stores/connection";
import { liveAgentsOf, resolveInstalled, type LiveState } from "./live-agents";
import { removalBlockReason, type CatalogRow } from "./acp-catalog";
import { CHAT_LIMIT, attentionSessions, busyState, delegationMetaPatch, evictions, isBusyPromptError, newAttention, reduceBackground, rowStatus, subagentModelPatch, toBackground, turnMetaPatch, withConversation } from "./agent-chats";
import { createSavedImageStore } from "./agent-saved-images";
import { RUN_TEXT } from "./agent-hint-text";
import { classifyAgentError, isLimitKind, limitStatus, type AgentErrorInfo } from "./agent-errors";
import { activityLabel, clockText, outputPreview, runningTitle, runningTool, stillRunningText } from "./agent-running";
import { lastFinishedTool, runningTools, toolBarView } from "./agent-tool-bar";

import {
  addFeedItem,
  applyDelegationStatus,
  dropRequest,
  initialAgentState,
  openPermission,
  reduceAgentEvent,
  resetConversation,
  resolvePermission,
  resolveProposal,
  unresolvedProposals,
  type AgentState,
  type Failure,
  markUrlOpened,
} from "./agent-session";

import { buildPrompt, coerceAnswer, formFields, leaf, promptCapabilities, saveName, splitCommandLine, toolImages, toolLocations, workspaceRelative } from "./agent-view";
import { FOLDER_OUTLINE_LIMIT, bytesToBase64, classifyFile, createFileAttachment, createFolderAttachment, createWorkspaceFile, folderOutline, isInWorkspace, isTextLike, maxBytesFor, needsStoredLink, planAttachment, redactPaths, resolveMime, type Attachment, type PromptCapabilities } from "./attachments";
import { droppedPathInfo, droppedRelative, readDroppedFile } from "./native-drop";
import { uploadOrigin, type UploadRecorder } from "./uploads-desktop";
import { feedTurns } from "./agent-handoff";
import { moveItem } from "./agent-queue";
import { noteAgentUsed, readLastSession, writeLastSession } from "./last-session";
import { chooseRestores, readLastConfig, writeLastConfig, type SavedConfig } from "./last-config";
import { buildHandoff, carryFeed, withHandoff } from "./agent-handoff";
import { initialThreadState, sameKey, type Handoff, type Queued, type Rewind, type ThreadState } from "./agent-threads/thread-state";
import { createThreadRegistry } from "./agent-threads/threads";
import type { Thread, ThreadEvents } from "./agent-threads/thread";
import { sessionKeyId } from "./agent-stores/live-sessions";
import { editQueuedEntry, mergeQueued } from "./agent-threads/thread-queue";
import { createUsageRecorder } from "./usage";
import { BRANCH_CONTEXT_NOTE, branchCut, branchReason, changesAfter, type BranchMode } from "./agent-rewind";

const DELEGATION_POLL_MS = 3000;

export type AgentPanelProps = {
  workspacePath?: string;
  workspaceGeneration?: number;
  activePath?: string;
  selectionContext?: { path: string; text: string; startLine?: number; endLine?: number };
  /** Text another part of the app wants in the composer, for example the problems of a file. A new `id` appends it. */
  incomingPrompt?: { id: number; text: string };
  onBufferChanged?: (path: string, snapshot?: BufferSnapshot) => void;
  onOpenSettings?: () => void;
  /** Removes an installed agent from Span, and with `uninstall` also deletes its managed adapter files. */
  removeAgent?: (id: string, uninstall: boolean) => Promise<void>;
  /** Opens a workspace file in the editor, at `line` (1-based) when given. */
  /**
   * Opens a file the user did not click: follow mode and an export. Without it `onOpenFile` is used. The app keeps the
   * Agents page in place for these instead of switching to the editor.
   */
  onRevealFile?: (path: string, line?: number) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenExternal?: (url: string) => void;
  /** The merged `agents.delegation.enabled`. Unset means the default, which is on. */
  delegationEnabled?: boolean;
  /** Writes `agents.delegation.enabled` to the user settings file. Without it the switch is read-only. */
  onDelegationChange?: (enabled: boolean) => void;
  /** The merged `agents.healthCheck` (ADR 0010). Unset means the default, which is on; off hides every health dot. */
  healthCheck?: boolean;
  /** Called after the panel writes a file into the workspace, so the explorer can refresh. */
  onFilesChanged?: () => void;
  onProposalsChange?: (proposals: EditProposal[]) => void;
  onReviewBusyChange?: (busy: boolean) => void;
  onReviewInEditor?: (path: string, line?: number) => void;
  onReviewReady?: (review: (proposalId: string, acceptedHunkIds: string[]) => Promise<void>) => void;
  /** Receives the attach function for Explorer rows and editor tabs dragged onto the panel (workspace relative paths). */
  onAttachReady?: (attach: (paths: { path: string; isDir: boolean }[]) => void) => void;
  /** True while one of Span's own pointer drags (Explorer row, editor tab) is over the panel. */
  dropHover?: boolean;
  /** Opens an attachment as a workbench viewer tab. Without it attachments open in the panel's modal viewer. */
  onOpenAttachment?: (view: AttachmentTabView) => void;
  /** The uploads store (ADR 0006). With it, sent attachments are recorded and link fallbacks point at stored copies. */
  uploads?: UploadRecorder;
  /** Reads a PDF's page count for its tile. Without it the count is left out. */
  countPdfPages?: (bytes: Uint8Array) => Promise<number | undefined>;
  /** Bounded outline of a workspace folder from the backend (desktop). Without it the outline is built from listings. */
  folderOutline?: (path: string, limit: number) => Promise<{ text: string; files: number; truncated: boolean }>;
  /** Asks the user for a folder, starting in `defaultPath`. Resolves the absolute path, or null when cancelled. */
  pickFolder?: (defaultPath?: string) => Promise<string | null>;
};

/** Shown when a path from an agent or a message points outside the open workspace. */
export const OUTSIDE_WORKSPACE = "Outside this workspace, so it cannot be opened here";

export type View = "session" | "history" | "connect" | "logs";
/** The one open composer or header popover. A single value, so opening one closes any other. */
export type Menu = "model" | "mode" | "agents" | "attach" | "actions" | "usage" | null;
/** A queued message and a rewind pick are thread state (agent-threads/thread-state.ts). */
export type { Queued, Rewind };

export const ATTACH_UNAVAILABLE = "Attachments need the span desktop app, which sends them to a connected agent.";
export const NATIVE_UNAVAILABLE = "Browser preview cannot write to or open workspace files.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The text of a rejected call, including a plain `{ message }` object. */
const causeText = (error: unknown) => (error && typeof error === "object" && !(error instanceof Error) && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : errorText(error));
const utf8 = new TextEncoder();
let queueCounter = 0;

/** The key of the open chat before it has a session, or before its connection is known. */
const NO_KEY: SessionKey = { connectionId: "", sessionId: "" };
const transientKey = (key: SessionKey) => !key.connectionId || !key.sessionId;
/**
 * The sidebar's threads hear nothing on their own: the controller follows the focused connection's channel (connect,
 * resume and sign-in are still unkeyed) and routes each event to the thread of its key, see `receive`. The keyed
 * stream (live-sessions.ts) would deliver the same events a second time. ADR 0011, "Phase 2 status".
 */
const SIDEBAR_EVENTS: ThreadEvents = { onSession: () => () => undefined, onConnection: () => () => undefined };

/** Agent session state and actions for the sidebar. The panel component only renders what this returns. */
export function createAgentController(props: AgentPanelProps) {
  /**
   * Every chat this sidebar holds is a thread keyed by `SessionKey` (agent-threads/), and the open chat is the focused
   * thread: its conversation, composer, queue, steer, requests, rewind and scroll state live there, not in signals of
   * this controller. Switching chats focuses another thread, nothing is copied. The focused thread also carries the
   * connection's own fields (status, agent, logs, sign-in) in its `AgentState`, and they move with the focus.
   */
  const threads = createThreadRegistry({ events: SIDEBAR_EVENTS, pollDelegation: false });
  /** Puts `value` in the thread for `key`, replacing what it held. */
  function place(key: SessionKey, value: ThreadState): Thread {
    const thread = threads.open(key);
    thread.update(() => ({ ...value, key: thread.key }));
    return thread;
  }
  const blankThread = (conversation: AgentState): ThreadState => ({ ...initialThreadState(NO_KEY), conversation });
  const [focused, setFocused] = createSignal<Thread>(place(NO_KEY, blankThread(initialAgentState(isDesktop))));
  const threadState = createMemo(() => focused().state());
  const state = createMemo(() => threadState().conversation);
  /** Changes the open chat's thread. Never tracks: an effect that writes must not rerun on a chat switch. */
  const updateThread = (change: (current: ThreadState) => ThreadState) => untrack(focused).update(change);
  const update = (change: (current: AgentState) => AgentState) => updateThread((current) => ({ ...current, conversation: change(current.conversation) }));
  const patch = (values: Partial<AgentState>) => update((current) => ({ ...current, ...values }));
  /** One field of the open chat's thread, as a signal pair. */
  function threadField<K extends keyof ThreadState>(name: K) {
    const get = createMemo(() => threadState()[name]);
    const set = (value: ThreadState[K] | ((previous: ThreadState[K]) => ThreadState[K])) =>
      updateThread((current) => ({ ...current, [name]: typeof value === "function" ? (value as (previous: ThreadState[K]) => ThreadState[K])(current[name]) : value }));
    return [get, set] as const;
  }
  const feed = createMemo(() => state().feed);
  const sessionId = createMemo(() => state().sessionId);
  const savedImages = createSavedImageStore((path, root) => api.readImage(path, root));
  createEffect(() => {
    const root = props.workspacePath || "";
    const scope = JSON.stringify([root, props.workspaceGeneration, sessionId()]);
    const candidates = feed().flatMap((item) => item.kind === "tool" && item.event.status === "completed" && item.event.savedPath && !toolImages(item.event).length
      ? [{ id: `${item.event.sessionId}:${item.event.toolCallId}`, path: item.event.savedPath }] : []);
    savedImages.sync(scope, root, candidates);
  });
  onCleanup(() => savedImages.dispose());
  const running = createMemo(() => state().running);

  const [prompt, setPrompt] = threadField("draft");
  createEffect(on(() => props.incomingPrompt?.id, () => { const incoming = props.incomingPrompt; if (incoming?.text) { setView("session"); setPrompt(current => (current.trim() ? `${current}\n\n${incoming.text}` : incoming.text)); } }, { defer: true }));
  const [view, setView] = createSignal<View>("session");
  const [menu, setMenu] = createSignal<Menu>(null);
  const [working, setWorking] = createSignal(false);
  const [pendingAction, setPendingAction] = createSignal("");
  const catalog = agentCatalog.use();
  const background = agentBackground.use();
  // Before any effect reads it, and again on every change, so the store sees the setting exactly when the panel does.
  createComputed(() => background.setHealthOn(props.healthCheck !== false));
  const { health } = background;
  const { installed, registry, presets, registryBusy, installingIds, installErrors, installing, catalogSearch, setCatalogSearch, catalogRows, otherInstalled, registryName } = catalog;
  /** An installed agent waiting for the user to confirm its removal. Nothing is removed until confirmRemoval. */
  const [removal, setRemoval] = createSignal<{ entry: InstalledAgent; uninstall: boolean }>();
  /** The focused agent connection (see the connection store). */
  const connection = agentConnection.use();
  const { agentName, setAgentName, agentId, setAgentId, launch, setLaunch, connecting, setConnecting, sessionStates, setSessionStates, connectionKey, setConnectionKey, attentionAnnouncement, setAttentionAnnouncement, runtimeOf, isLive } = connection;
  /** Where the open chat's thread went when it moved to a new key, so a late result finds the chat it belongs to. */
  const movedTo = new WeakMap<Thread, Thread>();
  const followMoves = (thread: Thread) => {
    let current = thread;
    for (let next = movedTo.get(current); next; next = movedTo.get(current)) current = next;
    return current;
  };
  /** The open chat's key: its session on the current connection, or a transient key before either is known. */
  const openKey = createMemo<SessionKey>(() => {
    const id = state().sessionId;
    return id ? { connectionId: connectionKey() ?? "", sessionId: id } : NO_KEY;
  }, NO_KEY, { equals: sameKey });
  // The open chat got its session, lost it, or learned its connection (connect, sign-in, a new chat): its thread moves
  // to the new key with everything in it. A chat switch focuses the target thread first, so nothing moves then.
  createComputed(on(openKey, (key) => untrack(() => {
    const left = focused();
    if (sameKey(left.key, key)) return;
    const value = left.state();
    threads.close(key);
    const next = place(key, value);
    movedTo.set(left, next);
    setFocused(next);
    threads.close(left.key);
  })));
  const [contextPaths, setContextPaths] = createSignal<string[]>([]);
  const [hiddenSelection, setHiddenSelection] = createSignal("");
  /** The agent's session list and Span's metadata index (see the history store). */
  const sessionHistory = agentHistory.use();
  const { sessions, setSessions, sessionsBusy, sessionsError, setSessionsError, sessionScope, sessionMeta, keepSaved } = sessionHistory;
  /** Delegated child session id to its lead session id, so a child's model is recorded on the lead as a subagent. */
  const delegatedChildren = new Map<string, string>();
  /** Accepted edit totals per session in this run, added to what the store had when counting began. */
  const changeTotals = new Map<string, { paths: Set<string>; add: number; del: number; base: { files: number; add: number; del: number } }>();
  const [queue, setQueue] = threadField("queue");
  /**
   * True when the queue must not drain on its own: the last turn ended with an error, the connection dropped, or a
   * reconnect or chat switch happened since the messages were queued. The user sends it with Send queued.
   */
  const [queueHeld, setQueueHeld] = threadField("queueHeld");
  const [attachments, setAttachments] = threadField("attachments");
  const [viewing, setViewing] = createSignal<string>();
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);
  const [pinned, setPinned] = threadField("pinned");
  /** Follow the agent: open files from tool call locations. Kept in memory only, so it resets on reload. */
  const [following, setFollowing] = createSignal(false);
  /** Name of the file the UI just opened for the user. `equals: false` restarts the toast for the same name. */
  const [toast, setToast] = createSignal<string | undefined>(undefined, { equals: false });
  /** A click that could not open its path (outside the workspace), with the reason. Cleared by the note. */
  const [openRefusal, setOpenRefusal] = createSignal<{ path: string; reason: string } | undefined>(undefined, { equals: false });
  const [turnStart, setTurnStart] = threadField("turnStart");
  const [clock, setClock] = createSignal(Date.now());
  /** Elicitation form progress. The thread starts it at the first field when a new request arrives. */
  const [form, setForm] = threadField("form");
  /** Every chat Span holds besides the open one: live threads in the background (see agent-chats.ts). */
  const backgroundThreads = () => threads.list().filter((thread) => thread !== focused());
  const threadOf = (connection: string | undefined, sessionId: string | undefined) => (connection && sessionId ? threads.get({ connectionId: connection, sessionId }) : undefined);
  /** A prompt was refused because a turn is still running: the composer explains and offers steer or queue. */
  const [busyNotice, setBusyNotice] = threadField("busyNotice");
  /** First and latest update time of each tool call, keyed by session and tool call id. */
  const toolTimes = new Map<string, { start: number; last: number }>();
  /** agent_prompt calls still waiting for their turn to end. */
  let history: string[] = [];
  let historyIndex = -1;
  /** The queued message picked with Send now, until it goes out (or is dropped). The panel shows a spinner on it. */
  const [queueSending, setQueueSending] = threadField("queueSending");
  /** Feed ids of the open chat's user messages that went out through Send now, so the feed can tag them. Feed ids
   * restart per chat, so the flag lives on the feed item and travels with its chat. */
  const sentNowIds = createMemo<ReadonlySet<number>>(() => new Set(state().feed.flatMap((item) => (item.kind === "user" && item.sentNow ? [item.id] : []))));
  const pick = (id: string | undefined) => setQueueSending(id);
  /** A steer waiting for its turn to end, in the open chat. */
  const [steering, setSteering] = threadField("steering");
  /** The agent switch waiting for its new session or for its first prompt. Cleared once the context is sent. */
  const [handoff, setHandoff] = threadField("handoff");
  /**
   * The turn the provider refused for a missing sign-in, in the session it was sent to. Only this turn can be sent
   * again with another model; it is forgotten on any new prompt, chat switch, resume or connection.
   */
  const [refused, setRefused] = threadField("refused");
  /** Models that hit a usage limit (see the limits store). */
  const limits = agentLimits.use();
  /** The picker the limit card opened to resend the refused turn with: a pick there resends instead of only switching. */
  const [resendArmed, setResendArmed] = createSignal<"model" | "agents">();
  /** Session ids a prompt has gone out to, so a late options restore never races the user's own turn. */
  const prompted = new Set<string>();
  /** Bumped by every option change the user makes, so a restore running meanwhile stops instead of overwriting it. */
  let configEdits = 0;
  /** The options restore in flight. A send waits for it, and a user change goes out after it. */
  const [restoring, setRestoring] = createSignal<Promise<void>>();
  const [rewindPick, setRewind] = threadField("rewind");
  /** Counts dispatched turns of the open chat, so a steer can tell its own turn from a later one. */
  const turnCounter = () => untrack(threadState).turn;
  const followed = new Set<string>();
  let disposed = false;
  let agentEpoch = 0;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeStates: (() => void) | undefined;
  let input: HTMLTextAreaElement | undefined;

  const selectionKey = createMemo(() => `${props.selectionContext?.path}:${props.selectionContext?.text}`);
  const selection = createMemo(() => (props.selectionContext?.text && hiddenSelection() !== selectionKey() ? props.selectionContext : undefined));
  /** Name shown for the connected agent in sentences. */
  const agentLabel = () => state().agent?.title || state().agent?.name || agentName();
  const connected = createMemo(() => Boolean(sessionId()) && !["disconnected", "error", "unavailable", "connecting"].includes(state().status));
  /** The agent's prompt capabilities, plus Span's own `storeLinks` when the uploads store can hold link fallbacks. */
  const caps = createMemo<PromptCapabilities | undefined>(() => {
    const base = promptCapabilities(state().agent?.features);
    return base && props.uploads ? { ...base, storeLinks: true } : base;
  });
  /** Attachments the connected agent cannot take, with the reason. Unknown capabilities block nothing. */
  const blocked = createMemo(() => {
    const capabilities = caps();
    if (!capabilities) return [];
    return attachments().flatMap((item) => {
      const plan = planAttachment(item, capabilities);
      if (plan.mode === "refuse") return [{ item, reason: plan.reason }];
      return plan.mode === "audio" ? [{ item, reason: "Span cannot send audio to agents yet." }] : [];
    });
  });
  const proposals = createMemo<EditProposal[]>(() => unresolvedProposals(feed()), [], {
    equals: (previous, next) => previous.length === next.length && previous.every((proposal, index) => proposal === next[index]),
  });
  /** The picked message, only while it is still a user message of the open chat. */
  const rewind = createMemo(() => {
    const chosen = rewindPick();
    return chosen && chosen.sessionId === sessionId() && feed().some((item) => item.id === chosen.itemId && item.kind === "user") ? chosen : undefined;
  });
  const rewindFiles = createMemo(() => {
    const chosen = rewind();
    return chosen ? changesAfter(feed(), chosen.itemId, props.workspacePath) : [];
  });
  /** Why edit, resend or fork cannot start a new session right now. Pending proposals belong to this session. */
  const branchBlock = createMemo(() => {
    if (!connected()) return "Connect an agent first.";
    if (running()) return "Wait for the agent to finish this turn.";
    const pending = proposals().length;
    if (pending) return `${pending === 1 ? "1 edit waits" : `${pending} edits wait`} for review. Accept or reject ${pending === 1 ? "it" : "them"} before starting a new session.`;
    return undefined;
  });
  const canSend = createMemo(
    () => connected() && !working() && !pendingAction() && !restoring() && Boolean(prompt().trim() || attachments().length) && blocked().length === 0 && !(rewind()?.mode === "edit" && branchBlock()),
  );
  /** The sign-in card may offer another model: the open session's own prompt was refused. */
  const canRetryModel = createMemo(() => {
    const turn = refused();
    return Boolean(turn && state().auth && turn.sessionId === state().sessionId);
  });
  /** The limit the open session's own refused turn hit, while its card shows: the card can resend that turn. */
  const limitTurn = createMemo(() => {
    const turn = refused();
    return turn?.limit && turn.sessionId === state().sessionId && state().failure && !running() ? turn.limit : undefined;
  });
  const modelOption = () => state().config.find((candidate) => candidate.category === "model");
  /** Model values of the connected agent marked "Limit reached". */
  const limitedModelValues = createMemo<ReadonlySet<string>>(() => limits.limitedValues(agentId() ?? agentName()));
  /** Marks the current model as limited until `resetAt` (or the next successful turn). */
  const markLimited = (info: AgentErrorInfo) => limits.markLimited(info, agentId() ?? agentName(), modelOption()?.currentValue);
  /** A turn of the open session completed: the model it ran on works again. */
  const clearLimitAfterSuccess = () => limits.clearAfterSuccess(agentId() ?? agentName(), modelOption()?.currentValue);
  createEffect(on(menu, (open) => { if (open !== resendArmed()) setResendArmed(undefined); }));
  const permission = createMemo(() => openPermission(feed()));
  /** Open permission requests from delegated children, oldest first. */
  const childPermissionList = createMemo(() => childPermissions(state().strayPermissions, state().feed.flatMap((item) => (item.kind === "delegation" ? [item.task] : [])), state().childRequests));
  const childPermission = createMemo<ChildPermission | undefined>(() => childPermissionList()[0]);
  const elicitation = createMemo(() => state().elicitations[0]);
  const fields = createMemo(() => (elicitation()?.mode === "form" ? formFields(elicitation()!.schemaJson) : []));
  const phases = createMemo<Phase[]>(() => {
    const current = connecting();
    if (!current) return [];
    const snapshot = state();
    const launched = snapshot.logCount > current.logBase || Boolean(snapshot.agent);
    const ready = Boolean(snapshot.agent);
    const session = Boolean(snapshot.sessionId);
    const step = (done: boolean, active: boolean): Phase["state"] => (done ? "done" : active ? (current.failed ? "failed" : "active") : "pending");
    return [
      { id: "start", label: `Starting ${current.name}`, meta: current.command, state: step(launched, !launched) },
      { id: "handshake", label: "ACP handshake", meta: ready ? "ACP v1" : undefined, state: step(ready, launched && !ready) },
      { id: "session", label: snapshot.auth ? "Sign-in required" : "Creating session", state: snapshot.auth ? "pending" : step(session, ready && !session) },
    ];
  });

  const intake = createAttachmentIntake({
    items: attachments,
    onAdd: (added) => setAttachments((previous) => [...previous, ...added]),
    onPending: (placeholders) => setAttachments((previous) => [...previous, ...placeholders]),
    onSettled: (ids) => setAttachments((previous) => previous.filter((item) => !ids.includes(item.id))),
    unavailable: () => (isDesktop ? undefined : ATTACH_UNAVAILABLE),
    countPages: (bytes) => props.countPdfPages?.(bytes) ?? Promise.resolve(undefined),
    insertText: (text) => {
      setPrompt((previous) => (previous && !/\s$/.test(previous) ? `${previous} ${text}` : `${previous}${text}`));
      focusPrompt();
    },
  });

  createEffect(on(proposals, (list) => props.onProposalsChange?.(list)));
  createEffect(on(() => Boolean(pendingAction()), (busy) => props.onReviewBusyChange?.(busy)));
  /** True while the app reopens the last chat, so the fresh session it connects with is not remembered over it. */
  let restoringLast = false;
  createEffect(() => {
    const workspace = props.workspacePath;
    const agent = agentId();
    const id = sessionId();
    if (workspace && agent && id && !restoringLast) writeLastSession(workspace, { agentId: agent, sessionId: id });
  });
  /** The brand new session whose agent should get the user's remembered options once they arrive. Never a resumed chat. */
  const [freshSession, setFreshSession] = createSignal<{ id: string; saved?: SavedConfig }>();
  /** `saved` replaces the agent's remembered options, for a session that continues another one (edit, resend, fork). */
  const markFresh = (id: string | undefined, saved?: SavedConfig) => setFreshSession(id ? { id, saved } : undefined);
  createEffect(() => {
    const id = sessionId();
    const options = state().config;
    const fresh = freshSession();
    if (!id || id !== fresh?.id || !options.length) return;
    setFreshSession(undefined);
    void restoreConfig(id, options, fresh.saved);
  });
  createEffect(on(sessionId, (id) => {
    setBannerDismissed(false);
    if (id && state().canList) void loadSessions();
  }));
  const anyRunning = createMemo(() => running() || sessionStates().sessions.some((entry) => entry.state !== "idle"));
  createEffect(on(running, (now) => !now && setBusyNotice(false)));
  createEffect(() => {
    if (!anyRunning()) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  const fail = (failure: Failure) => patch({ failure });
  const focusPrompt = () => {
    if (view() === "logs") setView("session");
    queueMicrotask(() => input?.focus());
  };

  /** Session-scoped UI state. Queued messages and a pending steer survive (see `releaseSteer` and `holdQueue`). */
  function resetSessionUi() {
    setSessions([]);
    setSessionsError("");
    setMenu(null);
    setPinned(true);
    setBannerDismissed(false);
    pick(undefined);
    releaseSteer();
    holdQueue();
    followed.clear();
  }
  /** Stops the queue from draining on its own, when there is anything in it. */
  function holdQueue() {
    // A Send now that never got its turn boundary must not leave the row spinning and the order locked.
    pick(undefined);
    if (queue().length) setQueueHeld(true);
  }
  /**
   * The turn a steer was waiting on ended without the normal cancelled completion (prompt failure, an error event, a
   * dropped connection, a reconnect). The steer text goes back to the composer when it is empty, otherwise to the
   * front of the queue, and the steer is forgotten so it can never fire after some later, unrelated turn.
   */
  function releaseSteer() {
    const pending = steering();
    if (!pending) return;
    setSteering(undefined);
    const { entry } = pending;
    if (!prompt().trim() && !attachments().length) {
      setPrompt(entry.text);
      if (entry.items.length) setAttachments(entry.items);
    } else {
      setQueue((previous) => [entry, ...previous]);
      setQueueHeld(true);
    }
    patch({ stopRequested: false });
  }

  createEffect(
    on(
      () => [props.workspacePath, props.workspaceGeneration] as const,
      ([path, generation], previous) => {
        if (previous && path === previous[0] && generation === previous[1]) return;
        agentEpoch += 1;
        batch(() => {
          update(() => initialAgentState(isDesktop));
          setAgentName("Select agent");
          setAgentId(undefined);
          setRemoval(undefined);
          setConnecting(undefined);
          setWorking(false);
          setPendingAction("");
          setView("session");
          setPrompt("");
          setContextPaths([]);
          setAttachments([]);
          setViewing(undefined);
          // A different workspace: messages composed for the old one are dropped, not carried over.
          setSteering(undefined);
          setHandoff(undefined);
          setRefused(undefined);
          setQueue([]);
          setQueueHeld(false);
          forgetChats();
          resetSessionUi();
          setHiddenSelection(selectionKey());
        });
      },
    ),
  );

  /** Chats of a connection that ended, or of another workspace, are gone. The open chat's own fields stay as they are. */
  function forgetChats() {
    for (const thread of untrack(backgroundThreads)) threads.close(thread.key);
    toolTimes.clear();
    setSessionStates(NO_STATES);
    setAttentionAnnouncement("");
  }
  const sessionOf = (event: AgentEvent) => {
    const value = (event as { sessionId?: unknown }).sessionId;
    return typeof value === "string" && value ? value : undefined;
  };
  const usageRecorder = createUsageRecorder();
  function noteTool(event: AgentEvent) {
    if (event.kind !== "tool") return;
    const id = `${event.sessionId}:${event.toolCallId}`;
    const now = Date.now();
    const known = toolTimes.get(id);
    toolTimes.set(id, { start: known?.start ?? now, last: now });
    if (toolTimes.size > 500) toolTimes.delete(toolTimes.keys().next().value!);
  }
  function receive(event: AgentEvent) {
    const session = state().sessionId;
    const target = sessionOf(event);
    const connection = connectionKey();
    noteTool(event);
    // Usage counters for the Usage page (ADR 0012): one patch per finished turn of any chat on this connection.
    const usagePatch = usageRecorder.observe(event, { agentId: agentId(), model: ((target && target !== session ? threadOf(connection, target)?.state().conversation.config : state().config) ?? []).find((option) => option.category === "model")?.currentValue });
    if (usagePatch) void recordSessionMeta(usagePatch);
    const background = target && target !== session ? threadOf(connection, target) : undefined;
    if (background && background !== untrack(focused)) {
      // A chat in the background keeps working: its events update its own thread, never the open chat.
      background.update((chat) => reduceBackground(chat, event));
      return;
    }
    if (event.kind === "elicitationResolved") {
      for (const thread of untrack(backgroundThreads)) {
        if (thread.state().conversation.elicitations.some((pending) => pending.requestId === event.requestId)) thread.update((chat) => reduceBackground(chat, event));
      }
    }
    update((current) => reduceAgentEvent(current, event));
    // Follow mode reveals the lead session's own work only. Delegated children run in other sessions.
    if (event.kind === "tool" && following() && session && event.sessionId === session) followTool(event);
    if (event.kind === "delegation" && (event.event.kind === "taskFinished" || event.event.kind === "delegated")) void refreshDelegation();
    if (event.kind === "delegation" && event.event.kind === "delegated") {
      const lead = delegationMetaPatch(agentId(), event.event.lead.sessionId, event.event.agentName);
      if (lead) void recordSessionMeta(lead);
      delegatedChildren.set(event.event.child.sessionId, event.event.lead.sessionId);
      if (delegatedChildren.size > 200) delegatedChildren.delete(delegatedChildren.keys().next().value!);
    }
    if (event.kind === "config" && delegatedChildren.has(event.sessionId)) {
      const child = subagentModelPatch(agentId(), delegatedChildren.get(event.sessionId)!, event.options);
      if (child) void recordSessionMeta(child);
    }
    if (event.kind === "complete" && session && event.sessionId === session) {
      const agent = agentId();
      // Zero counters mean "no changes" only while every change in the feed went through review (ADR 0005).
      if (agent) void recordSessionMeta({ agentId: agent, sessionId: session, stopReasonLast: event.stopReason, changesTracked: !hasUntrackedEdits(state().feed, props.workspacePath) });
    }
    if (event.kind === "complete" && (!session || event.sessionId === session)) queueMicrotask(() => (flushSteer(), drainQueue()));
    if (event.kind === "complete" && session && event.sessionId === session && event.stopReason !== "refusal") clearLimitAfterSuccess();
    if (event.kind === "error" || (event.kind === "status" && ["error", "disconnected"].includes(event.state))) {
      // The turn ended abnormally: nothing queued or steered may go out on its own.
      releaseSteer();
      holdQueue();
    }
    if (event.kind === "status" && event.state === "disconnected") {
      setConnecting((current) => (current ? { ...current, failed: true } : current));
      forgetChats();
    }
  }

  /** Reads the backend session states after a connection is made, which also names the connection chats are keyed by. */
  async function refreshSessionStates() {
    try {
      const states = await api.agentSessionStates?.();
      if (states?.connectionId) {
        setConnectionKey(states.connectionId);
        receiveStates(states);
        return;
      }
    } catch {
      // Without states every row shows nothing, which is never wrong.
    }
    if (!connectionKey()) setConnectionKey(connection.localKey());
  }
  const chatTitle = (sessionId: string) => sessions().find((entry) => entry.sessionId === sessionId)?.title || threadOf(connectionKey(), sessionId)?.state().conversation.sessionTitle || "A background chat";
  /** Applies published session states. States of another connection are ignored. */
  function receiveStates(states: SessionStates) {
    if (!states.connectionId) return;
    const key = connectionKey();
    if (key !== states.connectionId) {
      // A local stand-in key is replaced only while nothing is stored under it.
      if (!(connected() && (!key || (key.startsWith("local-") && untrack(backgroundThreads).length === 0)))) return;
      setConnectionKey(states.connectionId);
    }
    const openId = state().sessionId;
    const fresh = newAttention(sessionStates(), states, openId);
    setSessionStates(states);
    if (fresh.length) setAttentionAnnouncement(`${chatTitle(fresh[0].sessionId)} is ${(fresh[0].state === "waitingForAnswer" ? RUN_TEXT.answer : RUN_TEXT.approval).toLowerCase()}`);
    // A background chat whose turn ended while away is idle, whatever it last showed. The open chat follows the
    // backend: running when a turn runs that this view did not start (a chat reopened while busy), idle when nothing
    // this view sent is still in flight. Both are the thread's own rule (thread-events.ts `applyRuntime`).
    const open = untrack(focused);
    for (const entry of states.sessions) {
      const thread = threadOf(states.connectionId, entry.sessionId);
      if (thread && thread !== open) thread.applyRuntime(entry, { focused: false, working: false });
    }
    const mine = states.sessions.find((entry) => entry.sessionId === openId);
    open.applyRuntime(mine, { focused: true, working: working() });
  }

  /** The finished event carries the reason; the status command adds the detail text. A failure here leaves the card as the events made it. */
  async function refreshDelegation() {
    try {
      const status = await agentDelegationStatus();
      if (!disposed) update((current) => applyDelegationStatus(current, status));
    } catch {
      // The card keeps what the events reported.
    }
  }

  /** Stops one delegated task. Only the card's Cancel button calls this. A refusal reaches the caller, which shows it on the card. */
  async function cancelTask(taskId: string) {
    await agentCancelTask(taskId);
    await refreshDelegation();
  }
  /** Reads a delegated task's child session for "Open session" on its card. Desktop only; read only. */
  const openTaskSession = isDesktop ? (taskId: string) => agentTaskTranscript(taskId) : undefined;
  const hasLiveTask = createMemo(() => state().feed.some((item) => item.kind === "delegation" && !isFinished(item.task.status)));
  // Progress text and results come from the polled status, so refresh it while a task is live.
  createEffect(() => {
    if (!isDesktop || !hasLiveTask()) return;
    const timer = setInterval(() => void refreshDelegation(), DELEGATION_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    props.onReviewReady?.(reviewHunks);
    props.onAttachReady?.((paths) => void attachWorkspacePaths(paths));
    if (isDesktop) {
      void api
        .onAgentEvent(receive)
        .then((cleanup) => {
          if (disposed) cleanup();
          else unsubscribe = cleanup;
        })
        .catch((cause) => fail({ phase: "session", message: `Agent event subscription failed: ${errorText(cause)}` }));
      void api
        .onAgentSessionStates?.(receiveStates)
        .then((cleanup) => {
          if (disposed) cleanup();
          else unsubscribeStates = cleanup;
        })
        .catch(() => undefined);
      void loadAgents().then(() => {
        background.warmStart(props.workspacePath);
        background.startHealth();
        return restoreLastSession();
      });
    }
    const goOnline = () => {
      setOnline(true);
      queueMicrotask(drainQueue);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    onCleanup(() => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    });
  });
  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribeStates?.();
  });

  const guard = (epoch: number) => () => !disposed && epoch === agentEpoch;

  const loadAgents = () => catalog.loadAgents(fail);
  /** On app open: reconnect the agent that had the last chat in this workspace and resume that chat when the agent can. */
  async function restoreLastSession() {
    const workspace = props.workspacePath;
    if (!workspace || disposed || sessionId() || launch()) return;
    const last = readLastSession(workspace);
    const entry = last && installed().find((agent) => agent.id === last.agentId);
    if (!last || !entry) return;
    restoringLast = true;
    let freshAtRestore: string | undefined;
    try {
      await connect(entry.launch, registryName(entry.id) || entry.id, entry.id);
      freshAtRestore = sessionId();
      if (disposed || !sessionId() || sessionId() === last.sessionId || !state().canLoad) return;
      // Only a chat the agent still lists is resumed, and a failed resume is dropped quietly: the saved id is just stale.
      if (state().canList) {
        await loadSessions();
        if (!sessions().some((entry) => entry.sessionId === last.sessionId)) return;
      }
      await resumeChat(last.sessionId);
      if (sessionId() !== last.sessionId) patch({ failure: undefined });
      else if (freshAtRestore) releaseUnusedSession(freshAtRestore);
    } finally {
      restoringLast = false;
      // The chat that was open could not be reopened, so the session left is a new one and gets its options back.
      if (freshAtRestore && sessionId() === freshAtRestore) markFresh(freshAtRestore);
      const id = sessionId();
      const agent = agentId();
      if (id && agent) writeLastSession(workspace, { agentId: agent, sessionId: id });
    }
  }
  /**
   * The connect before a restore opens a session that the resumed chat replaces at once. Close it (never delete) where
   * the agent can, so it does not linger as an empty live session. Only an idle session that never ran a turn.
   */
  function releaseUnusedSession(id: string) {
    const runtime = runtimeOf(id);
    if (!canClose() || id === sessionId() || (runtime && (runtime.state !== "idle" || runtime.queued > 0))) return;
    const gone = threadOf(connectionKey(), id);
    if (gone && gone.state().conversation.feed.length) return;
    void api
      .agentCloseSession(id)
      .then(() => {
        const thread = threadOf(connectionKey(), id);
        if (thread && thread !== untrack(focused)) threads.close(thread.key);
      })
      .catch(() => undefined);
  }
  /**
   * Starts `name` in a new session. With `switching` (the agent pickers), a chat with messages that moves to another
   * agent keeps its feed: a divider marks the switch and recent context goes out with the first prompt (issue #87).
   */
  async function connect(command: AgentCommand, name: string, id?: string, options: { switching?: boolean } = {}) {
    const current = guard(++agentEpoch);
    if (!props.workspacePath) {
      fail({ phase: "connect", message: "Open a folder before connecting an agent." });
      return;
    }
    const cwd = props.workspacePath;
    const hadSession = Boolean(sessionId());
    const carry = Boolean(options.switching && state().feed.length && (id !== agentId() || name !== agentName()));
    const leaving = sessionId();
    const leavingAgent = agentId();
    const link = carry && leaving && leavingAgent ? { agentId: leavingAgent, sessionId: leaving, name: agentLabel(), title: currentTitle() } : undefined;
    setHandoff(carry ? { from: agentLabel(), to: name, text: buildHandoff(state().feed, { from: agentLabel(), root: cwd }), link } : undefined);
    // The backend keeps the old connection until the new one is up (issue #87), so a failed switch can go back to it.
    const left = hadSession ? { name: agentName(), id: agentId(), launch: launch(), key: connectionKey(), states: sessionStates(), conversation: state(), chats: untrack(backgroundThreads).map((thread) => thread.state()) } : undefined;
    setRefused(undefined);
    batch(() => {
      setWorking(true);
      setMenu(null);
      setView("session");
      setAgentName(name);
      setAgentId(id);
      setLaunch({ command, name, id });
      if (id) noteAgentUsed(id);
      setConnecting({ name, command: [command.command, ...(command.args ?? [])].join(" "), logBase: state().logCount, failed: false });
      update((previous) => ({
        ...resetConversation(previous),
        // A switch keeps the messages on screen. Requests of the old session can no longer be answered.
        ...(carry ? { feed: carryFeed(previous.feed), nextId: previous.nextId } : {}),
        status: "connecting",
        statusMessage: `Starting ${name}`,
        sessionId: undefined,
        agent: undefined,
        auth: undefined,
        config: [],
        canLoad: false,
        canList: false,
        failure: undefined,
        lastError: undefined,
        stderr: [],
      }));
      forgetChats();
      setConnectionKey(undefined);
      resetSessionUi();
    });
    try {
      // agent_connect replaces the active agent itself, closing the old one only after the new one connected.
      const id = await api.agentConnect(command, cwd);
      if (!current()) return;
      if (id) {
        if (!restoringLast) markFresh(id);
        patch({ sessionId: id, status: "ready", statusMessage: "Connected and ready" });
        finishHandoff(id);
        setConnecting(undefined);
        focusPrompt();
        void refreshSessionStates();
      } else if (state().auth) {
        setConnecting(undefined);
        void refreshSessionStates();
      } else {
        throw new Error("The agent did not create a session.");
      }
    } catch (cause) {
      if (!current()) return;
      setHandoff(undefined);
      if (left && (await keptConnection(left.key))) {
        if (!current()) return;
        // The old agent is still connected: back to its chat as it was, with the error card over it.
        batch(() => {
          setConnecting(undefined);
          setAgentName(left.name);
          setAgentId(left.id);
          setLaunch(left.launch);
          setConnectionKey(left.key);
          for (const chat of left.chats) place(chat.key, chat);
          setSessionStates(left.states);
          update(() => ({ ...left.conversation, failure: { phase: "connect", message: errorText(cause), log: state().stderr } }));
        });
        void refreshSessionStates();
        return;
      }
      if (!current()) return;
      // A failed switch goes back to the chat it left, with the error card over it. The draft is never touched.
      if (carry) setConnecting(undefined);
      else setConnecting((previous) => (previous ? { ...previous, failed: true } : previous));
      update((previous) => ({ ...previous, status: "error", statusMessage: "Connection failed", failure: { phase: "connect", message: errorText(cause), log: previous.stderr } }));
    } finally {
      if (current()) setWorking(false);
    }
  }
  /** True when the backend's active connection is still `key`, the one a failed switch left. */
  async function keptConnection(key: string | undefined) {
    if (!key) return false;
    try {
      return (await api.agentSessionStates?.())?.connectionId === key;
    } catch {
      return false;
    }
  }
  /** The switched-to session is ready: mark the switch in the feed and arm the carried context for its first prompt. */
  function finishHandoff(id: string) {
    const pending = handoff();
    if (!pending || pending.sessionId) return;
    update((previous) => addFeedItem(previous, { kind: "handoff", from: pending.from, to: pending.to, carried: Boolean(pending.text) }));
    if (pending.link) linkThread(id, pending.link);
    setHandoff(pending.text ? { ...pending, sessionId: id } : undefined);
  }
  const connectInstalled = (id: string) => {
    const entry = installed().find((agent) => agent.id === id);
    if (entry) void connect(entry.launch, registryName(entry.id) || entry.id, entry.id, { switching: true });
  };
  /** Connects a backend preset (a known launch command). The command shown on the row is exactly what runs. */
  const connectPreset = (id: string) => {
    const preset = presets().find((entry) => entry.id === id);
    if (preset) void connect({ command: preset.launch.command, args: preset.launch.args, env: preset.launch.env }, preset.name, preset.id, { switching: true });
  };
  function connectCustom(line: string) {
    try {
      const [command, ...args] = splitCommandLine(line);
      if (!command) throw new Error("Enter an executable path or command.");
      void connect({ command, args, env: {} }, leaf(command));
    } catch (cause) {
      fail({ phase: "connect", message: errorText(cause) });
    }
  }
  const reconnect = () => {
    const last = launch();
    if (last) void connect(last.command, last.name, last.id);
  };
  /** Installs a registry agent (see the catalog store). */
  const install = (id: string) => catalog.install(id, fail);
  /** Connects, installs or prepares the local command for one curated row. Returns the command line for a local row. */
  function pickCatalog(row: CatalogRow): string | undefined {
    if (row.installed) {
      void connect(row.installed.launch, row.definition.name, row.definition.id, { switching: true });
      return undefined;
    }
    if (row.action === "install" && row.registry) {
      void install(row.registry.id);
      return undefined;
    }
    if (row.action === "local" && row.definition.localCommand) return [row.definition.localCommand.command, ...row.definition.localCommand.args].join(" ");
    return undefined;
  }
  /** Why the agent waiting for removal cannot be removed yet: it is connected and has edits, a request or a turn open. */
  const removalBlock = createMemo(() =>
    removalBlockReason(Boolean(sessionId()) && agentId() === removal()?.entry.id, running(), proposals().length, Boolean(permission())),
  );
  function requestRemoval(entry: InstalledAgent, uninstall: boolean) {
    setRemoval({ entry, uninstall });
  }
  /** Removes the agent the user confirmed. A connected session with that agent disconnects first and is awaited. */
  async function confirmRemoval() {
    const choice = removal();
    const removeAgent = props.removeAgent;
    if (!choice || !removeAgent || removalBlock() || working()) return;
    // Invalidate an in-flight connection to the adapter being removed. Unrelated sessions and their work stay.
    const target = agentId() === choice.entry.id;
    if (target) agentEpoch += 1;
    const current = guard(agentEpoch);
    setWorking(true);
    try {
      if (sessionId() && target) {
        await api.agentDisconnect();
        if (!current()) return;
        update((previous) => ({ ...previous, sessionId: undefined, auth: undefined, running: false, status: "disconnected", statusMessage: "No agent connected" }));
        setConnecting(undefined);
        forgetChats();
      }
      if (target) {
        setAgentId(undefined);
        if (launch()?.id === choice.entry.id) setLaunch(undefined);
      }
      await removeAgent(choice.entry.id, choice.uninstall);
      if (!current()) return;
      catalog.commitInstalledMutation((agents) => agents.filter((entry) => entry.id !== choice.entry.id));
      setRemoval(undefined);
      const installedRead = catalog.beginInstalledRead();
      try {
        const remaining = await api.agentInstalled();
        if (current()) catalog.applyInstalledSnapshot(installedRead, remaining);
      } catch (cause) {
        if (current()) fail({ phase: "connect", message: `Could not refresh installed agents: ${errorText(cause)}` });
      }
    } catch (cause) {
      if (current()) fail({ phase: "connect", message: `Could not remove agent: ${errorText(cause)}` });
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function disconnect() {
    const current = guard(++agentEpoch);
    setMenu(null);
    setWorking(true);
    try {
      await api.agentDisconnect();
      if (!current()) return;
      setHandoff(undefined);
      setRefused(undefined);
      update((previous) => addFeedItem({ ...previous, sessionId: undefined, auth: undefined, running: false, status: "disconnected", statusMessage: "No agent connected" }, { kind: "note", text: "Agent disconnected" }));
      setConnecting(undefined);
      forgetChats();
    } catch (cause) {
      if (current()) fail({ phase: "session", message: `Could not disconnect: ${errorText(cause)}` });
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function authenticate(methodId: string) {
    const current = guard(agentEpoch);
    setPendingAction("auth");
    patch({ failure: undefined });
    try {
      const id = await api.agentAuthenticate(methodId);
      if (!current()) return;
      markFresh(id);
      patch({ sessionId: id, auth: undefined, status: "ready", statusMessage: "Connected and ready" });
      finishHandoff(id);
      focusPrompt();
    } catch (cause) {
      if (current()) fail({ phase: "auth", message: errorText(cause) });
    } finally {
      if (current()) setPendingAction("");
    }
  }

  /**
   * The provider behind the current model refused the prompt. Switch the same session to another model and send the
   * refused turn again (its text, attachments and carried context), so one click recovers without a reconnect. Only the
   * turn this session refused is sent: a sign-in card from anything else (a failed resume) offers no resend.
   */
  async function retryWithModel(value: string) {
    const current = guard(agentEpoch);
    const option = state().config.find((candidate) => candidate.category === "model");
    const turn = refused();
    const id = state().sessionId;
    if (!option || !id || !turn || turn.sessionId !== id || running()) return;
    setPendingAction("auth");
    configEdits += 1;
    try {
      await api.agentSetConfig(option.id, value);
      const agent = agentId();
      if (agent) writeLastConfig(agent, option.id, value);
      if (!current() || refused() !== turn || state().sessionId !== id) return;
      setRefused(undefined);
      const { entry } = turn;
      // The refused bubble is replaced by the resent one, and the composer no longer holds the same text to send twice.
      update((previous) => ({ ...previous, auth: undefined, failure: undefined, status: "ready", statusMessage: "Connected and ready", feed: previous.feed.filter((item) => item.id !== turn.itemId) }));
      if (prompt() === entry.text) setPrompt("");
      if (entry.items.length && attachments().length === entry.items.length && attachments().every((item, index) => item.id === entry.items[index].id)) setAttachments([]);
      void dispatch(entry);
    } catch (cause) {
      if (current()) fail({ phase: "session", message: `Could not change the model: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }

  /**
   * Takes the refused turn off the card: its bubble leaves the feed (the resend adds it again) and the composer no
   * longer holds the same text and attachments to send twice. Returns the turn's entry.
   */
  function takeRefused(turn: NonNullable<ReturnType<typeof refused>>) {
    setRefused(undefined);
    const { entry } = turn;
    update((previous) => ({ ...previous, failure: undefined, status: "ready", statusMessage: "Connected and ready", feed: previous.feed.filter((item) => item.id !== turn.itemId) }));
    if (prompt() === entry.text) setPrompt("");
    if (entry.items.length && attachments().length === entry.items.length && attachments().every((item, index) => item.id === entry.items[index].id)) setAttachments([]);
    return entry;
  }
  /** Retry from the limit card: the same turn, same session and model. Only on a click, never on its own. */
  function retryLimited() {
    const turn = refused();
    if (!turn?.limit || turn.sessionId !== state().sessionId || running() || !connected()) return;
    void dispatch(takeRefused(turn));
  }
  /**
   * Continue with another agent from the limit card: the existing switch and handoff path (the chat's context goes
   * with the first prompt), then the refused turn is sent on the new agent.
   */
  async function switchAgentAndResend(id: string) {
    const turn = refused();
    const target = installed().find((agent) => agent.id === id);
    if (!target) return;
    if (!turn?.limit || turn.sessionId !== state().sessionId || running()) return connectInstalled(id);
    const entry = takeRefused(turn);
    await connect(target.launch, registryName(target.id) || target.id, target.id, { switching: true });
    if (disposed || agentId() !== id || !connected() || running()) {
      // The switch failed: the text goes back to the composer so nothing is lost.
      if (!prompt()) setPrompt(entry.text);
      if (!attachments().length && entry.items.length) setAttachments(entry.items);
      return;
    }
    void dispatch(entry);
  }
  /** Opens the model or agent picker from the limit card; a pick there resends the refused turn. */
  function openResendPicker(kind: "model" | "agents") {
    batch(() => {
      setResendArmed(kind);
      setMenu(kind);
    });
  }

  /**
   * Signs in with a method that needs a typed value. The secret is a parameter of this call only: it is not put in
   * state or the feed, not logged, and not kept in a closure after the request settles.
   */
  async function authenticateWith(methodId: string, secret: AuthSecret) {
    const current = guard(agentEpoch);
    setPendingAction("auth");
    patch({ failure: undefined });
    try {
      const id = await agentAuthenticateWith(methodId, secret);
      if (!current()) return;
      markFresh(id);
      patch({ sessionId: id, auth: undefined, status: "ready", statusMessage: "Connected and ready" });
      finishHandoff(id);
      focusPrompt();
    } catch (cause) {
      if (current()) fail({ phase: "auth", message: errorText(cause) });
    } finally {
      if (current()) setPendingAction("");
    }
  }

  async function compose(text: string, selected: ReturnType<typeof selection>) {
    const files = await Promise.all(contextPaths().map((path) => api.openBuffer(path)));
    const contexts = files.map((file) => `File: ${file.path}\n${file.text}`);
    if (selected) contexts.push(`Selected code from ${selected.path}${selected.startLine ? `, line ${selected.startLine}` : ""}:\n${selected.text}`);
    return contexts.length ? `${text}\n\nEditor context:\n${contexts.join("\n\n")}` : text;
  }
  async function dispatch(entry: Queued, options: { steered?: boolean; sentNow?: boolean } = {}) {
    const current = guard(agentEpoch);
    // A steer still waiting here belongs to an earlier turn; it must not fire after this one.
    if (steering() && !options.steered) releaseSteer();
    const turn = turnCounter() + 1;
    // The thread this prompt goes to: its prompts in flight settle there even when the user switches chats meanwhile.
    const owner = untrack(focused);
    updateThread((current) => ({ ...current, turn }));
    setBusyNotice(false);
    setRefused(undefined);
    const promptSession = state().sessionId;
    if (promptSession) prompted.add(promptSession);
    // The first prompt after an agent switch carries the context, exactly once. Slash commands go out unchanged.
    const waiting = handoff();
    const carried = waiting?.text && waiting.sessionId && waiting.sessionId === state().sessionId && !entry.message.trimStart().startsWith("/") ? waiting : undefined;
    if (carried) setHandoff(undefined);
    const message = carried ? withHandoff(carried.text!, entry.message) : entry.message;
    update((previous) =>
      addFeedItem(
        { ...previous, running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", failure: undefined },
        {
          kind: "user",
          text: entry.text,
          attachments: entry.items.length ? entry.items : undefined,
          ...(options.steered ? { steered: true } : {}),
          ...(options.sentNow ? { sentNow: true } : {}),
          ...(carried ? { context: carried.text, ...(carried.note ? { contextNote: carried.note } : {}) } : {}),
        },
      ),
    );
    const itemId = state().nextId;
    // The chat's title now, in case the user switches chats before the turn ends and the files are recorded.
    const promptTitle = currentTitle();
    // Captured now: the turn runs with this model, and the user may switch chats before it ends.
    const turnMeta = turnMetaPatch({ agentId: agentId(), sessionId: state().sessionId, connectionName: agentLabel(), config: state().config });
    setTurnStart(Date.now());
    setView("session");
    followLatest();
    followMoves(owner).update((current) => ({ ...current, promptsInFlight: current.promptsInFlight + 1 }));
    try {
      await api.agentPrompt(message, entry.attachments);
      if (turnMeta) void recordSessionMeta(turnMeta);
      void recordSent(entry.items, { sessionId: promptSession ?? null, agentId: agentId() ?? null, messageId: String(itemId), sessionTitle: (promptSession === sessionId() ? currentTitle() : undefined) ?? promptTitle ?? null });
    } catch (cause) {
      if (!current()) return;
      if (isBusyPromptError(cause)) {
        // Nothing was sent, so the carried context waits for the next prompt.
        if (carried && !handoff()) setHandoff(carried);
        // The session still runs a turn (for example one started before this chat was reopened). Nothing was sent:
        // show it as running, give the text back and offer steer or queue instead of an error card.
        const known = busyState(cause);
        update((previous) => ({ ...previous, running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", feed: previous.feed.filter((item) => item.id !== itemId) }));
        if (known?.startedAtMs) setTurnStart(known.startedAtMs);
        setBusyNotice(true);
        if (steering()?.turn === turn) {
          releaseSteer();
          return;
        }
        if (!prompt()) setPrompt(entry.text);
        if (!attachments().length && entry.items.length) setAttachments(entry.items);
        return;
      }
      // Usage limits, rate limits and overloads get their own card, which can send this exact turn again.
      const classified = classifyAgentError({ message: causeText(cause), agent: agentLabel() });
      const limit = isLimitKind(classified.kind) ? classified : undefined;
      update((previous) => ({
        ...previous,
        running: false,
        stopRequested: false,
        failure: { phase: "prompt", message: errorText(cause) },
        ...(previous.sessionId ? { status: "ready", statusMessage: limit ? limitStatus(limit) : "Prompt failed" } : {}),
      }));
      holdQueue();
      if ((state().auth || limit) && promptSession && promptSession === state().sessionId) {
        // Refused for a missing sign-in or a limit: the carried context waits for the resend and the card may send
        // this exact turn again with another model or agent.
        if (carried && !handoff()) setHandoff(carried);
        if (turn === turnCounter()) setRefused({ sessionId: promptSession, entry, itemId, ...(limit ? { limit } : {}) });
      }
      if (limit) markLimited(limit);
      if (steering()?.turn === turn) {
        // This turn was being steered: the user wants the steer, not this turn's text, back.
        releaseSteer();
        return;
      }
      if (turn !== turnCounter()) return;
      if (!prompt()) setPrompt(entry.text);
      if (!attachments().length && entry.items.length) setAttachments(entry.items);
    } finally {
      followMoves(owner).update((current) => ({ ...current, promptsInFlight: current.promptsInFlight - 1 }));
    }
  }
  /** Sends plain prompt text, for Continue, agent slash commands and Compact. */
  const sendText = (text: string) => {
    if (!connected() || running() || steering()) return;
    void dispatch({ id: `q-${++queueCounter}`, text, message: text, attachments: [], items: [] });
  };
  /** Enter while idle, and Tab or the send button while a turn runs: sends now, or queues behind the running turn. */
  const send = () => submit("queue");
  /**
   * Enter while a turn runs. ACP v1 has no steer primitive (there is no way to inject a message into a running
   * turn), so a steer is exactly: cancel the turn, wait for the cancel request to resolve and for the turn to end,
   * then send the message as the next prompt. The feed labels that message "Steered". Nothing here assumes the
   * agent supports anything beyond session/cancel and session/prompt.
   */
  const steer = () => submit("steer");
  async function submit(mode: "queue" | "steer") {
    const current = guard(agentEpoch);
    const capabilities = caps();
    if (!canSend() || !capabilities) return;
    const text = prompt().trim();
    setWorking(true);
    try {
      const stored = await storeLinkTargets(attachments(), capabilities);
      if (!current()) return;
      if (stored.failed.length) {
        intake.reject(stored.failed);
        return;
      }
      const items = stored.items;
      const built = buildPrompt(await compose(text, selection()), items, capabilities, props.workspacePath);
      if (!current()) return;
      if (built.blocked.length) {
        intake.reject(built.blocked.map(({ item, reason }) => ({ name: item.name, reason })));
        return;
      }
      if (text) history = [text, ...history.filter((entry) => entry !== text)].slice(0, 50);
      historyIndex = -1;
      setPrompt("");
      setAttachments([]);
      const entry: Queued = { id: `q-${++queueCounter}`, text, message: built.text, attachments: built.attachments, items };
      const editing = rewind();
      if (editing?.mode === "edit") {
        void branchFrom(editing.itemId, "edit", entry);
        return;
      }
      if (running()) setBusyNotice(false);
      if (mode === "steer" && running() && online()) void startSteer(entry);
      // A steer waiting for its cancel to resolve goes first, so anything sent meanwhile queues behind it.
      else if (running() || !online() || steering()) setQueue((previous) => [...previous, entry]);
      else void dispatch(entry);
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Prompt failed: ${errorText(cause)}` });
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function startSteer(entry: Queued) {
    const current = guard(agentEpoch);
    if (steering()) {
      // A steer is already waiting for its turn to end, so this one waits behind it.
      setQueue((previous) => [...previous, entry]);
      return;
    }
    const pending: NonNullable<ThreadState["steering"]> = { entry, cancelled: false, turn: turnCounter() };
    setSteering(pending);
    patch({ stopRequested: true, statusMessage: "Steering the agent" });
    try {
      await api.agentCancel();
    } catch (cause) {
      // Released meanwhile (the turn errored or the connection dropped): the entry already went back to the user.
      if (!current() || steering() !== pending) return;
      setSteering(undefined);
      setQueue((previous) => [entry, ...previous]);
      patch({ stopRequested: false, statusMessage: "Agent is working", failure: { phase: "prompt", message: `Could not cancel the turn, so the message was queued: ${errorText(cause)}` } });
      return;
    }
    if (!current() || steering() !== pending) return;
    pending.cancelled = true;
    flushSteer();
  }
  /** Sends the steer message once the cancel resolved and the cancelled turn ended. Called from both sides. */
  function flushSteer() {
    const waiting = steering();
    if (!waiting?.cancelled || running()) return;
    if (waiting.turn !== turnCounter()) {
      // Another turn ran since this steer started, so its moment has passed.
      releaseSteer();
      return;
    }
    const { entry } = waiting;
    setSteering(undefined);
    void dispatch(entry, { steered: true });
  }
  /** Queued follow-ups go out together once the agent finishes, unless one was picked with Send now. */
  function drainQueue(options: { force?: boolean } = {}) {
    const waiting = queue();
    if (!waiting.length || running() || !connected() || !online() || steering()) return;
    // A held queue goes out only on the user's word: Send queued, or Send now on one message (which sets `priority`).
    const priority = queueSending();
    if (queueHeld() && !options.force && !priority) return;
    const chosen = priority ? waiting.find((entry) => entry.id === priority) : undefined;
    pick(undefined);
    if (chosen) {
      const rest = waiting.filter((entry) => entry !== chosen);
      setQueue(rest);
      if (!rest.length) setQueueHeld(false);
      void dispatch(chosen, { sentNow: true });
      return;
    }
    setQueue([]);
    setQueueHeld(false);
    void dispatch(mergeQueued(waiting, `q-${++queueCounter}`));
  }
  function sendQueuedNow(id: string) {
    if (running()) {
      pick(id);
      void stop();
      return;
    }
    pick(id);
    drainQueue({ force: true });
  }
  /** Send queued: the user's explicit go-ahead for a held queue. */
  const sendQueued = () => drainQueue({ force: true });
  /** Replaces the typed part of a queued message. Text added to an attachment-only message gets a blank line before the attachments. */
  const editQueued = (id: string, text: string) => setQueue((previous) => previous.map((entry) => (entry.id === id ? editQueuedEntry(entry, text) : entry)));
  /** Moves a queued message to another position. Ignored while one is being sent, so the order cannot shift under it. */
  const reorderQueue = (from: number, to: number) => {
    if (queueSending()) return;
    setQueue((previous) => moveItem(previous, from, to));
  };
  const removeQueued = (id: string) =>
    setQueue((previous) => {
      if (queueSending() === id) pick(undefined);
      const next = previous.filter((entry) => entry.id !== id);
      if (!next.length) setQueueHeld(false);
      return next;
    });

  function recallPrompt(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    const area = event.currentTarget;
    if (event.key === "ArrowUp" && area.selectionStart === 0 && area.selectionEnd === 0) {
      if (historyIndex + 1 >= history.length) return;
      event.preventDefault();
      setPrompt(history[++historyIndex]);
    } else if (event.key === "ArrowDown" && historyIndex >= 0 && area.selectionStart === area.value.length) {
      event.preventDefault();
      historyIndex -= 1;
      setPrompt(historyIndex >= 0 ? history[historyIndex] : "");
    }
  }

  /**
   * Applies the options this agent had last time (or `saved`, the options of the session this one continues) to its
   * new session. Silent: the UI shows what the agent reports. Sending waits until it settles.
   */
  function restoreConfig(id: string, options: ConfigOption[], saved?: SavedConfig): Promise<void> {
    const agent = agentId();
    const values = saved ?? (agent ? readLastConfig(agent) : undefined);
    const restores = values ? chooseRestores(options, values) : [];
    if (!restores.length) return Promise.resolve();
    const current = guard(agentEpoch);
    const edits = configEdits;
    const run = (async () => {
      for (const [configId, value] of restores) {
        // A prompt to this session, or a change the user made meanwhile, wins over the remembered value.
        if (!current() || sessionId() !== id || running() || prompted.has(id) || configEdits !== edits) return;
        try {
          await api.agentSetConfig(configId, value);
        } catch {
          /* the agent may refuse, and the picker shows what it reports */
        }
      }
    })();
    const settled = run.finally(() => {
      if (restoring() === settled) setRestoring(undefined);
    });
    setRestoring(settled);
    return settled;
  }
  async function setConfig(configId: string, value: string) {
    const current = guard(agentEpoch);
    const option = state().config.find((candidate) => candidate.id === configId);
    if (!option || value === option.currentValue) return;
    configEdits += 1;
    setPendingAction(`config:${configId}`);
    try {
      // A restore value still in flight lands first, so this choice is the one that stays.
      await restoring();
      await api.agentSetConfig(configId, value);
      const agent = agentId();
      if (agent) writeLastConfig(agent, configId, value);
    } catch (cause) {
      if (current()) fail({ phase: "session", message: `Could not change ${option.name}: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }
  const setSessionScope = (scope: "workspace" | "all") => {
    if (scope === sessionScope()) return;
    sessionHistory.setSessionScope(scope);
    void loadSessions();
  };
  async function loadSessions() {
    if (!state().canList || sessionsBusy()) return;
    await sessionHistory.loadSessions(guard(agentEpoch));
  }
  /** Writes what Span observed about a session to the metadata store (see the history store). */
  const recordSessionMeta = (patch: SessionMetaPatch) => sessionHistory.recordSessionMeta(patch, guard(agentEpoch));
  /** Stored metadata for one of the connected agent's sessions. Sessions are keyed by agent and id (ADR 0005). */
  const sessionMetaOf = (sessionId: string) => sessionHistory.metaOf(agentId(), sessionId);
  /** Every stored segment of the chat thread that holds one of the connected agent's sessions (ADR 0005, thread links). */
  const threadFor = (sessionId: string) => sessionHistory.threadFor(agentId(), sessionId);
  /** The lead's state in the Live agents strip, from its turn and the requests that wait for the user. */
  const leadState = (): LiveState => (permission() || elicitation() ? "Waiting for you" : running() ? "Working" : connecting() ? "Starting" : "Idle");
  /**
   * Every agent involved in the open chat: the lead, the agents it delegated to and the agents of earlier segments of
   * this thread. The strip shows only when there is more than one.
   */
  /** The lead's current model name, for the Active agents card. Tolerates an option that lists no groups. */
  const leadModel = () => {
    const option = state().config.find((candidate) => candidate.category === "model");
    return (option?.groups ?? []).flatMap((group) => group.choices ?? []).find((choice) => choice.value === option?.currentValue)?.name;
  };
  const liveAgents = createMemo(() => {
    const current = state().sessionId;
    if (!connected() || !current) return [];
    const id = agentId();
    const earlier = threadFor(current)
      .segments.filter((segment) => !(segment.sessionId === current && (!id || segment.agentId === id)))
      .map((segment) => ({ id: segment.agentId, name: segment.connectionName || registryName(segment.agentId) || segment.agentId }));
    return liveAgentsOf({
      lead: { id, name: (id && registryName(id)) || agentLabel(), state: leadState(), detail: leadModel() },
      tasks: state().feed.flatMap((item) => (item.kind === "delegation" ? [item.task] : [])),
      waiting: (task) => childPermissionList().some((entry) => permissionWaitsOn(entry, task)),
      earlier,
      health: health(),
      resolve: (name) => resolveInstalled(name, installed().map((agent) => ({ id: agent.id, name: registryName(agent.id) }))),
    });
  });
  /** The open chat's title: the thread's user title, else the title it had when it switched agent, else the agent's. */
  const currentTitle = () => {
    const id = sessionId();
    return (id ? threadRowMeta(threadFor(id)).title : undefined) ?? listedTitle(state().sessionTitle) ?? (id ? listedTitle(sessions().find((entry) => entry.sessionId === id)?.title) : undefined);
  };
  /** The store keys a thread action writes: every stored segment, and the row's own session first (it may have no metadata yet). */
  function threadKeys(id: string): { agentId: string; sessionId: string }[] {
    const agent = agentId();
    const keys = agent ? [{ agentId: agent, sessionId: id }] : [];
    for (const segment of threadFor(id).segments) if (!keys.some((entry) => entry.agentId === segment.agentId && entry.sessionId === segment.sessionId) && segment.sessionId !== id) keys.push({ agentId: segment.agentId, sessionId: segment.sessionId });
    return keys;
  }
  /**
   * Links the session a switch started to the one it left, so History shows one row for the chat with every provider.
   * The earlier segment is recorded too, so its provider shows even when it never finished a turn.
   */
  function linkThread(id: string, link: NonNullable<Handoff["link"]>) {
    const agent = agentId();
    if (!agent || (agent === link.agentId && id === link.sessionId)) return;
    void recordSessionMeta({ agentId: link.agentId, sessionId: link.sessionId, connectionName: link.name });
    void recordSessionMeta({ agentId: agent, sessionId: id, connectionName: agentLabel(), continues: { agentId: link.agentId, sessionId: link.sessionId, title: link.title ?? null } });
  }
  /** Renaming stores a title in Span's metadata, which needs the desktop app and a known agent catalog id. */
  const canRename = () => isDesktop && Boolean(agentId());
  /** Renames the whole thread: every segment gets the title, so whichever segment is listed shows it. */
  async function renameChat(id: string, title: string) {
    if (!canRename()) return;
    const current = guard(agentEpoch);
    setSessionsError("");
    try {
      for (const entry of threadKeys(id)) {
        const saved = await sessionMetaSetTitle(entry.agentId, entry.sessionId, title);
        if (current()) keepSaved(saved);
      }
    } catch (cause) {
      if (current()) setSessionsError(`Could not rename that chat: ${errorText(cause)}`);
    }
  }
  /** Archive hides a thread from History until it is restored from the Archived filter. Only Span's metadata changes. */
  const canArchive = canRename;
  async function archiveChat(id: string, archived: boolean) {
    if (!canArchive()) return;
    const current = guard(agentEpoch);
    setSessionsError("");
    try {
      for (const entry of threadKeys(id)) {
        const saved = await sessionMetaSetArchived(entry.agentId, entry.sessionId, archived);
        if (current()) keepSaved(saved);
      }
    } catch (cause) {
      if (current()) setSessionsError(`Could not ${archived ? "archive" : "restore"} that chat: ${errorText(cause)}`);
    }
  }
  /**
   * Export as Markdown writes the chat into the workspace as a new file (never overwriting) and opens it. Only a chat
   * Span shows can be exported, so another row is resumed first.
   */
  const canExport = () => isDesktop && Boolean(props.workspacePath);
  async function exportChat(id: string) {
    if (!canExport()) return;
    if (id !== sessionId()) await resumeChat(id);
    if (id !== sessionId() || disposed) return;
    setSessionsError("");
    try {
      const title = currentTitle() ?? "Chat";
      const markdown = await sessionExportMarkdown(exportTranscript(title, state().feed));
      const saved = await api.saveAttachment("", exportFileName(title), bytesToBase64(new TextEncoder().encode(markdown)));
      props.onFilesChanged?.();
      (props.onRevealFile ?? props.onOpenFile)?.(saved.path);
    } catch (cause) {
      if (!disposed) setSessionsError(`Could not export that chat: ${errorText(cause)}`);
    }
  }
  /** Fork session: a new session that starts with the whole chat as carried context, like Fork on the last message. */
  const canFork = () => isDesktop && connected();
  async function forkChat(id: string) {
    if (!canFork()) return;
    if (id !== sessionId()) await resumeChat(id);
    if (id !== sessionId() || disposed) return;
    const last = [...feed()].reverse().find((item) => item.kind === "user");
    if (!last) return setSessionsError("Nothing to fork yet: this chat has no messages.");
    const reason = branchBlock();
    if (reason) return setSessionsError(`Could not fork that chat: ${reason}`);
    const title = currentTitle();
    await branchFrom(last.id, "fork");
    const agent = agentId();
    const forked = sessionId();
    if (agent && forked && forked !== id && title) {
      try {
        keepSaved(await sessionMetaSetTitle(agent, forked, `Fork of ${title}`));
      } catch {
        // The fork works without a stored title; History then shows the agent's.
      }
    }
  }
  /**
   * Accepted edits add to the session's file counters (ADR 0005, step 4): distinct paths and changed lines of the
   * accepted hunks, on top of what the store already had for the session.
   */
  function countAccepted(proposal: EditProposal, hunkIds?: readonly string[]) {
    const agent = agentId();
    const session = sessionId();
    if (!agent || !session) return;
    let totals = changeTotals.get(session);
    if (!totals) {
      const stored = sessionMetaOf(session);
      totals = { paths: new Set(), add: 0, del: 0, base: { files: stored?.filesChanged ?? 0, add: stored?.linesAdded ?? 0, del: stored?.linesRemoved ?? 0 } };
      changeTotals.set(session, totals);
    }
    let changed = false;
    for (const hunk of proposal.hunks) {
      if (hunkIds && !hunkIds.includes(hunk.id)) continue;
      const delta = hunkLineDelta(hunk.before, hunk.after);
      totals.add += delta.add;
      totals.del += delta.del;
      changed ||= delta.add > 0 || delta.del > 0;
    }
    if (changed) totals.paths.add(proposal.path);
    void recordSessionMeta({ agentId: agent, sessionId: session, filesChanged: totals.base.files + totals.paths.size, linesAdded: totals.base.add + totals.add, linesRemoved: totals.base.del + totals.del });
  }
  /** Puts the open chat in the background: its thread stays live in the registry and keeps receiving its events. */
  function stashOpenChat() {
    // A steer waiting on this chat's turn goes back to its composer text or queue first.
    releaseSteer();
    // A Send now picked here waits for this chat's turn boundary, which the chat leaves: it must not lock the order.
    pick(undefined);
    if (!state().sessionId || !connectionKey()) return;
    updateThread((chat) => toBackground({ ...chat, scrollTop: scrollers.content?.scrollTop, touchedAt: Date.now() }));
  }
  /** Shows another chat by focusing its thread. The chat left stays in the background, unless it is transient or `discard`. */
  function focusThread(next: Thread, options: { discard?: boolean } = {}) {
    const left = untrack(focused);
    if (left === next) return;
    setFocused(next);
    if (options.discard || transientKey(left.key)) threads.close(left.key);
  }
  /** Background chats beyond `CHAT_LIMIT` are closed, oldest idle first; a chat still working never is. */
  function pruneChats() {
    const held = new Map(untrack(backgroundThreads).map((thread) => [sessionKeyId(thread.key), thread] as const));
    const gone = evictions([...held].map(([id, thread]) => [id, thread.state()] as const), CHAT_LIMIT, (id) => isLive(held.get(id)!.key.sessionId));
    for (const id of gone) threads.close(held.get(id)!.key);
  }
  /**
   * Shows the chat of `target` (a new chat without one): a thread Span holds comes back exactly as it was when `live`,
   * otherwise only its draft and queue are kept and the agent replays the rest; a chat Span never held starts empty.
   * Returns the shown thread and what it held before.
   */
  function showChat(target: string | undefined, live: boolean, options: { discard?: boolean } = {}) {
    const fields = state();
    const left = untrack(focused);
    const connection = connectionKey();
    const key: SessionKey = target ? { connectionId: connection ?? "", sessionId: target } : NO_KEY;
    const held = threads.get(key);
    const stored = held && held !== left ? held.state() : undefined;
    const thread = held ?? threads.open(key);
    focusThread(thread, options);
    const full = Boolean(stored && live);
    thread.update((chat) => ({
      ...(stored ? chat : { ...blankThread(chat.conversation), key: chat.key }),
      conversation: full ? { ...withConversation(fields, chat.conversation), sessionId: target } : { ...resetConversation(fields), sessionId: target, failure: undefined },
      pinned: full ? chat.pinned : true,
      turnStart: full ? chat.turnStart : 0,
      queueSending: undefined,
      touchedAt: Date.now(),
    }));
    const top = full && stored && !stored.pinned ? stored.scrollTop : undefined;
    if (top !== undefined) requestAnimationFrame(() => scrollers.content?.scrollTo({ top }));
    return { thread, stored };
  }
  /**
   * Opens another chat. The chat being left stays a live thread in the background and keeps receiving its events. A
   * chat Span holds that is still working comes back exactly as it was; an idle one is replayed by the agent
   * (session/load), so only its draft and queue come from its thread; a chat Span never held shows only what loads.
   */
  async function switchChat(start: () => Promise<string>, failure: string, options: { keepView?: boolean; target?: string; discardOpen?: boolean; fresh?: boolean } = {}) {
    const current = guard(++agentEpoch);
    setMenu(null);
    setWorking(true);
    const left = untrack(focused);
    const previousId = state().sessionId;
    setRefused(undefined);
    if (options.discardOpen) releaseSteer();
    else stashOpenChat();
    followed.clear();
    setBusyNotice(false);
    const target = options.target;
    const live = isLive(target);
    const shown = showChat(target, live, { discard: options.discardOpen });
    setRefused(undefined);
    setBusyNotice(false);
    pruneChats();
    try {
      const id = await start();
      if (!current()) return;
      if (options.fresh) markFresh(id);
      const mine = runtimeOf(id);
      const busy = Boolean(mine && mine.state !== "idle");
      patch({ sessionId: id, status: busy ? "busy" : "ready", statusMessage: busy ? "Agent is working" : "Connected and ready", ...(busy ? { running: true } : {}) });
      if (busy && mine?.startedAtMs) setTurnStart(mine.startedAtMs);
      if (!options.keepView) {
        setView("session");
        if (!shown.stored || !live || shown.stored.pinned) followLatest();
        focusPrompt();
      }
    } catch (cause) {
      if (!current()) return;
      // Nothing changed on the backend: the target goes back to what it held and the chat that was open comes back.
      const fields = state();
      const target = untrack(focused);
      if (shown.stored) target.update(() => shown.stored!);
      if (threads.get(left.key) === left) {
        focusThread(left);
        left.update((chat) => ({ ...chat, conversation: { ...withConversation(fields, chat.conversation), sessionId: previousId } }));
        if (!left.state().pinned && left.state().scrollTop !== undefined) requestAnimationFrame(() => scrollers.content?.scrollTo({ top: left.state().scrollTop }));
      } else {
        showChat(previousId, false);
      }
      if (!shown.stored && target !== untrack(focused) && threads.get(target.key) === target) threads.close(target.key);
      patch({ sessionId: previousId, failure: { phase: "session", message: `${failure}: ${errorText(cause)}` } });
    } finally {
      if (current()) setWorking(false);
    }
  }
  const newChat = () => switchChat(() => api.agentNewSession(), "Could not start a new chat", { fresh: true });
  const resumeChat = (id: string) => (id === state().sessionId ? (setView("session"), Promise.resolve()) : switchChat(() => api.agentResumeSession(id), "Could not resume that chat", { target: id }));
  const canClose = createMemo(() => Boolean(state().agent?.features.canCloseSessions));
  const canDelete = createMemo(() => Boolean(state().agent?.features.canDeleteSessions));
  /**
   * Runs a close or delete on a stored session. When it was the active one, the desktop has already cleared the
   * active session, so a new session starts at once (staying on the history list) and the list is refreshed.
   */
  async function endSession(id: string, run: (id: string) => Promise<void>, failure: string) {
    const current = guard(agentEpoch);
    const active = id === state().sessionId;
    setPendingAction(`session:${id}`);
    setSessionsError("");
    try {
      await run(id);
    } catch (cause) {
      if (current()) setSessionsError(`${failure}: ${errorText(cause)}`);
      return;
    } finally {
      if (current()) setPendingAction("");
    }
    if (!current()) return;
    setSessions((previous) => previous.filter((session) => session.sessionId !== id));
    const gone = threadOf(connectionKey(), id);
    if (gone && gone !== untrack(focused)) threads.close(gone.key);
    if (active) {
      await switchChat(() => api.agentNewSession(), "Could not start a new chat", { keepView: true, discardOpen: true, fresh: true });
      // The desktop already cleared the active session, so a failed restart must not keep pointing at it.
      if (state().sessionId === id) patch({ sessionId: undefined });
    }
    if (!disposed) void loadSessions();
  }
  /** Deletes a stored session. Only call when `canDelete()` is true. */
  const deleteChat = (id: string) => (canDelete() ? endSession(id, (sessionId) => api.agentDeleteSession(sessionId), "Could not delete that chat") : Promise.resolve());
  /** Closes the live session without deleting it. Only the active session is open, so only it can be closed. */
  const closeChat = (id: string) => (canClose() && id === state().sessionId ? endSession(id, (sessionId) => api.agentCloseSession(sessionId), "Could not close that chat") : Promise.resolve());

  async function stop() {
    const current = guard(agentEpoch);
    if (!running() || state().stopRequested) return;
    patch({ stopRequested: true, statusMessage: "Waiting for cancellation" });
    try {
      await api.agentCancel();
    } catch (cause) {
      if (current()) patch({ stopRequested: false, failure: { phase: "prompt", message: `Could not cancel the turn: ${errorText(cause)}` } });
    }
  }
  async function answerPermission(requestId: string, optionId: string | null) {
    const current = guard(agentEpoch);
    setPendingAction(requestId);
    try {
      await api.agentPermission(requestId, optionId);
      if (current()) update((previous) => resolvePermission(previous, requestId));
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Permission response failed: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }
  /** Answers a delegated child's request. Only a click or key on the dock calls this; nothing the agents send can. */
  async function answerChildPermission(request: ChildPermission, optionId: string | null) {
    const current = guard(agentEpoch);
    const requestId = request.event.requestId;
    setPendingAction(requestId);
    try {
      await agentChildPermission(request.child.connectionId, request.child.sessionId, requestId, optionId);
      if (current()) update((previous) => dropRequest(previous, requestId));
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Permission response for ${request.agentName} failed: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }
  /** Edit: the message's text goes into the composer; the next send starts a new session from before it. */
  function editFrom(itemId: number) {
    const item = feed().find((entry) => entry.id === itemId);
    if (item?.kind !== "user") return;
    const draft = rewind()?.mode === "edit" ? rewind()!.draft : prompt();
    setRewind({ itemId, sessionId: sessionId(), mode: "edit", draft });
    setPrompt(item.text);
    focusPrompt();
  }
  /** Restore: shows the files changed since the message, with Revert and Keep. Nothing else changes. */
  function restoreTo(itemId: number) {
    if (feed().find((entry) => entry.id === itemId)?.kind !== "user") return;
    const draft = rewind()?.mode === "edit" ? rewind()!.draft : prompt();
    if (rewind()?.mode === "edit") setPrompt(draft);
    setRewind({ itemId, sessionId: sessionId(), mode: "restore", draft });
  }
  /** Leaves edit or restore. Edit gives the earlier draft back. */
  function cancelRewind() {
    const chosen = rewind();
    if (chosen?.mode === "edit") setPrompt(chosen.draft);
    setRewind(undefined);
  }
  /** Rejects edits after the message that still wait for review, so those files stay as they were. */
  async function revertFiles(ids: readonly string[] = rewindFiles().flatMap((file) => file.pending)) {
    if (pendingAction()) return;
    await reviewMany(ids, false);
    if (rewind()?.mode === "restore" && !rewindFiles().some((file) => file.pending.length)) setRewind(undefined);
  }
  /** Accepts the edits after the message that still wait for review. */
  async function keepFiles() {
    if (pendingAction()) return;
    await reviewMany(rewindFiles().flatMap((file) => file.pending), true);
    if (rewind()?.mode === "restore") setRewind(undefined);
  }
  /** Resend: the message goes out again as it was sent, attachments included, rebuilt like a composed prompt. */
  const resendFrom = (itemId: number) => {
    const item = feed().find((entry) => entry.id === itemId);
    const capabilities = caps();
    if (item?.kind !== "user" || !capabilities) return;
    const items = item.attachments ?? [];
    const built = buildPrompt(item.text, items, capabilities, props.workspacePath);
    if (built.blocked.length) {
      intake.reject(built.blocked.map(({ item: blockedItem, reason }) => ({ name: blockedItem.name, reason })));
      return;
    }
    void branchFrom(itemId, "resend", { id: `q-${++queueCounter}`, text: item.text, message: built.text, attachments: built.attachments, items: [...items] });
  };
  const forkFrom = (itemId: number) => void branchFrom(itemId, "fork");
  /**
   * ACP cannot rewind or fork a session, so edit, resend and fork start a new session with the agent. The feed up to the
   * cut is shown again with a divider, and those turns go out as context with the first prompt (agent-handoff.ts). The
   * original chat is stashed like any chat the user leaves. `entry` is sent right away (edit and resend).
   */
  async function branchFrom(itemId: number, mode: BranchMode, entry?: Queued) {
    const restore = () => {
      if (!entry || mode !== "edit") return;
      setPrompt(entry.text);
      if (entry.items.length) setAttachments(entry.items);
    };
    const snapshot = feed();
    const cut = branchCut(snapshot, itemId, mode);
    if (branchBlock() || cut === undefined) return restore();
    const editing = rewind();
    const earlier = snapshot.slice(0, cut);
    const from = agentLabel();
    const text = buildHandoff(earlier, { from, root: props.workspacePath, reason: branchReason(mode) });
    const before = sessionId();
    // The new session continues this one, so it starts on the same model and options, not the agent's defaults.
    const source: SavedConfig = Object.fromEntries(state().config.map((option) => [option.id, option.currentValue]));
    const draft = mode === "fork" ? { text: prompt(), items: attachments() } : undefined;
    if (editing?.mode === "edit") setPrompt(editing.draft);
    setRewind(undefined);
    await switchChat(() => api.agentNewSession(), "Could not start a new session from that message");
    const id = sessionId();
    if (!id || id === before) {
      if (mode === "edit" && editing) setRewind(editing);
      return restore();
    }
    update((previous) => ({
      ...previous,
      nextId: previous.nextId + 1,
      feed: [...carryFeed(earlier), { id: previous.nextId + 1, kind: "branch", mode, carried: Boolean(text) }, ...previous.feed],
    }));
    setHandoff(text ? { from, to: from, text, sessionId: id, note: BRANCH_CONTEXT_NOTE } : undefined);
    if (draft) {
      setPrompt(draft.text);
      setAttachments(draft.items);
    }
    // Options the agent already reported are set before the first prompt; ones that arrive later are set on arrival.
    if (state().config.length) await restoreConfig(id, state().config, source);
    else markFresh(id, source);
    if (entry && sessionId() === id) await dispatch(entry);
  }
  async function review(proposal: EditProposal, accept: boolean) {
    const current = guard(agentEpoch);
    setPendingAction(proposal.id);
    try {
      const buffer = await api.agentReview(proposal.id, accept, proposal.baseRevision);
      if (!current()) return;
      update((previous) => resolveProposal(previous, proposal.id, accept));
      if (accept) props.onBufferChanged?.(buffer.path, buffer);
      if (accept) countAccepted(proposal);
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Edit review failed, the editor buffer may have changed: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }
  async function reviewMany(ids: readonly string[], accept: boolean) {
    for (const id of ids) {
      const proposal = proposals().find((candidate) => candidate.id === id);
      if (proposal) await review(proposal, accept);
    }
  }
  async function reviewHunks(proposalId: string, acceptedHunkIds: string[]) {
    const current = guard(agentEpoch);
    const proposal = proposals().find((candidate) => candidate.id === proposalId);
    if (!proposal || pendingAction()) return;
    setPendingAction(proposal.id);
    try {
      const buffer = await api.agentReviewHunks(proposal.id, acceptedHunkIds, proposal.baseRevision);
      if (!current()) return;
      const accepted = acceptedHunkIds.length > 0;
      update((previous) => resolveProposal(previous, proposal.id, accepted));
      if (accepted) props.onBufferChanged?.(buffer.path, buffer);
      if (accepted) countAccepted(proposal, acceptedHunkIds);
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Hunk review failed, the editor buffer may have changed: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }

  async function answerForm(answer: { optionId?: string; text?: string }) {
    const pending = elicitation();
    const progress = form();
    if (!pending || !progress || progress.requestId !== pending.requestId) return;
    const list = fields();
    if (!list.length) return respondElicitation(pending.requestId, "accept", null);
    const field = list[progress.index];
    const result = coerceAnswer(field, answer);
    if ("error" in result) return setForm({ ...progress, error: result.error });
    const values = { ...progress.values, [field.key]: result.value };
    if (progress.index + 1 < list.length) return setForm({ requestId: progress.requestId, index: progress.index + 1, values });
    setForm({ ...progress, values, error: undefined });
    await respondElicitation(pending.requestId, "accept", JSON.stringify(values));
  }
  async function respondElicitation(requestId: string, action: "accept" | "decline" | "cancel", content: string | null = null) {
    const current = guard(agentEpoch);
    setPendingAction(requestId);
    try {
      await api.agentElicitation(requestId, action, content);
    } catch (cause) {
      if (current()) {
        const progress = form();
        if (progress?.requestId === requestId) setForm({ ...progress, error: errorText(cause) });
        else fail({ phase: "prompt", message: `Could not answer the agent: ${errorText(cause)}` });
      }
    } finally {
      if (current()) setPendingAction("");
    }
  }
  /** URL elicitation: the user has seen the full URL and clicked Open. Only then is it opened and accepted. */
  async function openElicitationUrl(requestId: string, url: string) {
    try {
      await api.openExternal(url);
    } catch (cause) {
      fail({ phase: "prompt", message: `Could not open the browser: ${errorText(cause)}` });
      return;
    }
    update((current) => markUrlOpened(current, requestId));
    await respondElicitation(requestId, "accept");
  }

  function addCurrentFile() {
    const path = props.activePath;
    if (path) setContextPaths((previous) => (previous.includes(path) ? previous : [...previous, path]));
    setMenu(null);
    focusPrompt();
  }
  const removeContextPath = (path: string) => setContextPaths((paths) => paths.filter((value) => value !== path));
  const hideSelection = () => setHiddenSelection(selectionKey());

  /** Replaces an attachment wherever it lives: the composer or a sent message. */
  function replaceAttachment(next: Attachment) {
    setAttachments((items) => items.map((item) => (item.id === next.id ? next : item)));
    update((previous) => ({
      ...previous,
      feed: previous.feed.map((item) =>
        item.kind === "user" && item.attachments?.some((attachment) => attachment.id === next.id)
          ? { ...item, attachments: item.attachments.map((attachment) => (attachment.id === next.id ? next : attachment)) }
          : item,
      ),
    }));
    setQueue((entries) => entries.map((entry) => ({ ...entry, items: entry.items.map((item) => (item.id === next.id ? next : item)) })));
  }
  /** A raster image a tool call carried as bytes, as a viewer item. Decoded only when the user opens it. */
  function toolImageAttachment(id: string): Attachment | undefined {
    for (const item of feed()) {
      if (item.kind !== "tool" || !id.startsWith(`${item.event.toolCallId}:image:`)) continue;
      const image = toolImages(item.event).find((candidate) => candidate.id === id);
      if (!image) continue;
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
      } catch {
        return undefined;
      }
      return { id, kind: "image", name: image.name, mime: image.mime, size: bytes.length, source: "dropped", bytes, status: "ready" };
    }
    return undefined;
  }
  const findAttachment = (id: string | undefined) =>
    id === undefined
      ? undefined
      : attachments().find((item) => item.id === id) ??
        feed().flatMap((item) => (item.kind === "user" ? item.attachments ?? [] : [])).find((item) => item.id === id) ??
        savedImages.findAttachment(id) ?? toolImageAttachment(id);
  const viewingItem = createMemo(() => findAttachment(viewing()));
  /** Set by the panel when a workbench can show attachments as tabs. */
  let attachmentOpener: ((item: Attachment) => void) | undefined;
  const setAttachmentOpener = (open: ((item: Attachment) => void) | undefined) => { attachmentOpener = open; };
  /** Chips and tiles call this: a workbench tab when one is wired, else the modal viewer. */
  function openAttachment(item: Attachment) {
    if (attachmentOpener) attachmentOpener(item);
    else setViewing(item.id);
  }
  const viewingInComposer = createMemo(() => attachments().some((item) => item.id === viewing()));
  /** Writes the bytes into the workspace (default folder assets) and turns the item into a workspace file. */
  async function saveAttachment(item: Attachment) {
    const data = item.bytes ?? (item.text !== undefined ? utf8.encode(item.text) : undefined);
    if (!data) throw new Error("The content is no longer available.");
    const saved = await api.saveAttachment("assets", saveName(item), bytesToBase64(data));
    replaceAttachment({ ...item, source: "workspace-file", path: saved.path, name: leaf(saved.path) });
    props.onFilesChanged?.();
  }
  const removeAttachment = (item: Attachment) => setAttachments((items) => items.filter((other) => other.id !== item.id));

  /** Attachment ids already written to the uploads store, so each sent attachment is recorded once. */
  const recordedIds = new Set<string>();
  /** The bytes the store keeps for an item: raw bytes, else its text. Workspace files and folder outlines are not stored. */
  const storableBytes = (item: Attachment) => (isInWorkspace(item) || item.kind === "folder" ? undefined : item.bytes ?? (item.text !== undefined ? utf8.encode(item.text) : undefined));
  /**
   * Link fallback (#91): content the agent cannot take inline is saved to the uploads store first and the item then
   * points at the stored copy, so the resource link names a file that exists. A failed save blocks the send with the reason.
   */
  async function storeLinkTargets(items: readonly Attachment[], capabilities: PromptCapabilities): Promise<{ items: Attachment[]; failed: { name: string; reason: string }[] }> {
    const recorder = props.uploads;
    const failed: { name: string; reason: string }[] = [];
    if (!recorder) return { items: [...items], failed };
    const out = await Promise.all(items.map(async (item) => {
      if (!needsStoredLink(item, capabilities) || (item.uploadId && item.path)) return item;
      try {
        const id = item.uploadId ?? (await recorder.add(saveName(item), bytesToBase64(item.bytes!), { origin: uploadOrigin(item.source), sessionId: state().sessionId ?? null, agentId: agentId() ?? null, sessionTitle: currentTitle() ?? null })).id;
        recordedIds.add(item.id);
        const next = { ...item, uploadId: id, path: await recorder.copyPath(id) };
        replaceAttachment(next);
        return next;
      } catch (cause) {
        failed.push({ name: item.name, reason: `Could not save it to Uploads for the link: ${errorText(cause)}` });
        return item;
      }
    }));
    return { items: out, failed };
  }
  /** Recording (#91): every sent attachment with content goes into the uploads store once, with its session, agent and message. */
  async function recordSent(items: readonly Attachment[], source: { sessionId: string | null; agentId: string | null; messageId: string; sessionTitle: string | null }) {
    const recorder = props.uploads;
    if (!recorder) return;
    for (const item of items) {
      const data = storableBytes(item);
      if (!data?.length || item.uploadId || recordedIds.has(item.id)) continue;
      recordedIds.add(item.id);
      try {
        const { id } = await recorder.add(saveName(item), bytesToBase64(data), { ...source, origin: uploadOrigin(item.source) });
        replaceAttachment({ ...item, uploadId: id });
      } catch (cause) {
        intake.reject([{ name: item.name, reason: `Sent, but not saved to Uploads: ${errorText(cause)}` }]);
      }
    }
  }

  /** Paste screenshot: reads a clipboard image from this click. Where the webview refuses, it says how to paste instead. */
  async function pasteScreenshot() {
    const keys = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd+V" : "Ctrl+V";
    const fallback = () => {
      intake.reject([{ name: "Paste screenshot", reason: `The clipboard image cannot be read from here. Click the prompt box and press ${keys}.` }]);
      focusPrompt();
    };
    const clipboard = typeof navigator !== "undefined" ? (navigator.clipboard as (Clipboard & { read?: () => Promise<ClipboardItem[]> }) | undefined) : undefined;
    if (!clipboard?.read) return fallback();
    try {
      for (const entry of await clipboard.read()) {
        const type = entry.types.find((value) => value.startsWith("image/"));
        if (!type) continue;
        const blob = await entry.getType(type);
        await intake.addFiles([new File([blob], `Screenshot.${type.slice(6).replace("jpeg", "jpg")}`, { type })], "pasted");
        return;
      }
      intake.reject([{ name: "Paste screenshot", reason: "The clipboard holds no image. Copy a screenshot first." }]);
    } catch {
      fallback();
    }
  }

  /**
   * Files and folders dropped from Finder or Explorer onto the panel (native drop). Only the dropped paths are read,
   * through Rust, which refuses any path that was not part of the latest drop. Workspace files become workspace file
   * chips (a mention by relative path, no copy, content embedded when within the limits); other files go through
   * the same intake as the attach menu, so the uploads store keeps them on send (ADR 0006).
   */
  async function attachDroppedPaths(paths: readonly string[]) {
    if (!paths.length) return;
    if (!isDesktop) {
      intake.reject(paths.map((path) => ({ name: leaf(path) || path, reason: ATTACH_UNAVAILABLE })));
      return;
    }
    const root = props.workspacePath;
    const files: File[] = [];
    const items: Attachment[] = [];
    for (const path of paths.slice(0, 128)) {
      const fallback = leaf(path.replaceAll("\\", "/")) || path;
      let info: Awaited<ReturnType<typeof droppedPathInfo>>;
      try {
        info = await droppedPathInfo(path);
      } catch (cause) {
        intake.reject([{ name: fallback, reason: errorText(cause) }]);
        continue;
      }
      const relative = droppedRelative(root, info.path);
      if (info.isDir) {
        if (relative !== undefined || droppedRelative(root, `${info.path}/x`) === "x") await attachWorkspaceFolder(relative ?? "");
        // Outside the project: a path mention only. The folder is never listed or read.
        else items.push(createFolderAttachment({ name: info.name, text: `${info.name}/ (folder outside the open project)\nPath: ${info.path}`, files: 0, truncated: false, path: info.path, source: "dropped" }));
        continue;
      }
      const mime = resolveMime(info.name, "");
      const limit = maxBytesFor(classifyFile(info.name, mime), mime);
      if (info.size > limit) {
        // A large workspace file still goes out as a link to its path. Anything else is refused unread.
        if (relative) items.push(createWorkspaceFile(relative, 0));
        else intake.reject([{ name: info.name, reason: `Larger than the attachment limit for this file type.` }]);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readDroppedFile(info.path, limit);
      } catch (cause) {
        intake.reject([{ name: info.name, reason: errorText(cause) }]);
        continue;
      }
      if (relative) items.push({ ...createFileAttachment({ name: info.name, mime, bytes, source: "dropped" }), source: "workspace-file", path: relative });
      else files.push(new File([bytes as BlobPart], info.name, { type: mime }));
    }
    if (items.length) intake.addItems(items);
    if (files.length) await intake.addFiles(files, "dropped");
    focusPrompt();
  }
  /**
   * Explorer rows and editor tabs dragged onto the panel (Span's own pointer gestures). Paths are workspace relative.
   * Files become workspace file chips with their current text when it is small; folders become outlines.
   */
  async function attachWorkspacePaths(paths: readonly { path: string; isDir: boolean }[]) {
    const items: Attachment[] = [];
    for (const entry of paths.slice(0, 128)) {
      const relative = workspaceRelative(props.workspacePath, entry.path) ?? (entry.path && !/^(?:\/|[A-Za-z]:)/.test(entry.path) ? entry.path : undefined);
      if (!relative) continue;
      if (entry.isDir) {
        await attachWorkspaceFolder(relative);
        continue;
      }
      const item = createWorkspaceFile(relative);
      if (isTextLike(item.name, item.mime)) {
        try {
          const text = (await api.openBuffer(relative)).text;
          const size = utf8.encode(text).length;
          if (size <= maxBytesFor(item.kind, item.mime)) Object.assign(item, { text, size });
        } catch {
          /* unreadable as text: the chip stays a link to the path */
        }
      }
      items.push(item);
    }
    if (items.length) intake.addItems(items);
    focusPrompt();
  }
  /** A workspace folder ("" is the root) as a bounded outline plus a link to the folder. */
  async function attachWorkspaceFolder(relative: string) {
    const root = props.workspacePath;
    if (!root) return;
    const name = relative ? leaf(relative) : leaf(root.replace(/[\\/]+$/, "")) || "workspace";
    // One backend call when the desktop offers it (workspace ignore rules apply); otherwise a listing per folder.
    let outline: { text: string; files: number; truncated: boolean };
    try {
      outline = props.folderOutline
        ? await props.folderOutline(relative || ".", FOLDER_OUTLINE_LIMIT)
        : await folderOutline(name, async (inner) => {
          const path = [relative, inner].filter(Boolean).join("/");
          return (await api.listDirectory(path)).map((entry) => ({ name: entry.name, isDir: entry.isDir }));
        });
    } catch (cause) {
      intake.reject([{ name, reason: `Could not outline the folder: ${errorText(cause)}` }]);
      return;
    }
    intake.addItems([createFolderAttachment({ name, text: outline.text, files: outline.files, truncated: outline.truncated, path: relative || ".", source: "workspace-file" })]);
  }

  /** Folder: a workspace folder becomes a bounded outline (text) plus a link to the folder. Folders outside the workspace are refused. */
  async function addFolder() {
    const root = props.workspacePath;
    if (!root || !props.pickFolder) {
      intake.reject([{ name: "Folder", reason: root ? "Folder picking needs the desktop app." : "Open a folder first." }]);
      return;
    }
    let chosen: string | null;
    try {
      chosen = await props.pickFolder(root);
    } catch (cause) {
      intake.reject([{ name: "Folder", reason: errorText(cause) }]);
      return;
    }
    if (!chosen) return;
    const trimmed = chosen.replace(/[\\/]+$/, "");
    const relative = trimmed === root.replace(/[\\/]+$/, "") ? "" : workspaceRelative(root, trimmed);
    if (relative === undefined) {
      intake.reject([{ name: leaf(trimmed) || trimmed, reason: "Outside this workspace, so it cannot be attached. Pick a folder inside it." }]);
      return;
    }
    await attachWorkspaceFolder(relative);
  }

  /** Earlier chats this window holds (other than the open one) that have something to export. */
  const earlierChats = createMemo(() => {
    const open = state().sessionId;
    return backgroundThreads().flatMap((thread) => {
      const { sessionId } = thread.key;
      if (transientKey(thread.key) || sessionId === open) return [];
      const turns = feedTurns(thread.state().conversation.feed).length;
      return turns ? [{ key: sessionKeyId(thread.key), sessionId, title: chatTitle(sessionId), turns }] : [];
    });
  });
  /** Earlier session: attaches that chat as a Markdown transcript built here, with absolute paths redacted. */
  function attachSession(key: string) {
    const chat = backgroundThreads().find((thread) => sessionKeyId(thread.key) === key)?.state();
    const entry = earlierChats().find((item) => item.key === key);
    if (!chat || !entry) {
      intake.reject([{ name: "Earlier session", reason: "That chat is no longer held in this window." }]);
      return;
    }
    const agent = chat.conversation.agent?.title || chat.conversation.agent?.name || "Agent";
    const body = feedTurns(chat.conversation.feed).map((turn) => `## ${turn.role === "user" ? "You" : agent}\n\n${turn.text}`).join("\n\n");
    const markdown = redactPaths(`# ${entry.title}\n\nTranscript exported by Span from an earlier chat. Absolute paths are redacted.\n\n${body}\n`, props.workspacePath);
    const slug = entry.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "session";
    intake.addItems([createFileAttachment({ name: `${slug}.md`, mime: "text/markdown", bytes: utf8.encode(markdown), source: "picked" })]);
  }

  /**
   * Opens a workspace file for the user and confirms it with a toast. The path is checked against the workspace
   * root first, because most callers pass a path an agent supplied. `opener` lets the changes card use the
   * review opener. Returns false when nothing was opened.
   */
  function openInEditor(path: string, line?: number, opener: ((path: string, line?: number) => void) | undefined = props.onOpenFile): boolean {
    const relative = workspaceRelative(props.workspacePath, path);
    if (!relative) {
      // Never silent: the user clicked something, so say why nothing opened and offer the path.
      if (path.trim()) setOpenRefusal({ path, reason: props.workspacePath ? OUTSIDE_WORKSPACE : "No folder is open, so it cannot be opened here" });
      return false;
    }
    if (!opener) return false;
    opener(relative, line);
    setToast(leaf(relative));
    return true;
  }
  /** Follow mode: reveal the first valid, not yet shown location of a tool call. Outside-root paths are ignored. */
  function followTool(event: Extract<AgentEvent, { kind: "tool" }>) {
    const typed = event.locations?.flatMap((location) => (location.path.trim() ? [{ path: location.path, line: location.line ?? undefined }] : []));
    for (const location of typed?.length ? typed : toolLocations(event.contentJson)) {
      const relative = workspaceRelative(props.workspacePath, location.path);
      if (!relative) continue;
      const key = `${event.toolCallId}:${relative}:${location.line ?? ""}`;
      if (followed.has(key)) return;
      followed.add(key);
      if (openInEditor(relative, location.line, props.onRevealFile ?? props.onOpenFile)) return;
    }
  }
  const toggleFollow = () => {
    followed.clear();
    setFollowing(!following());
  };
  /** Brings the editor selection back into the prompt after it was removed from the context list. */
  const showSelection = () => {
    setHiddenSelection("");
    setMenu(null);
    focusPrompt();
  };

  const scrollers: { content?: HTMLDivElement } = {};
  // Streaming text grows the feed every frame and several watchers ask to follow it: coalesce them into one scroll write
  // per animation frame, and skip it if the reader scrolled away before the frame ran.
  let scrollFrame: number | undefined;
  let scrollSmooth = false;
  const scrollToLatest = (smooth = false) => {
    scrollSmooth ||= smooth;
    if (scrollFrame !== undefined) return scrollFrame;
    scrollFrame = requestAnimationFrame(() => {
      const behavior = scrollSmooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto";
      scrollFrame = undefined;
      scrollSmooth = false;
      if (!pinned()) return;
      scrollers.content?.scrollTo({ top: scrollers.content.scrollHeight, behavior });
    });
    return scrollFrame;
  };
  function followLatest() {
    setPinned(true);
    scrollToLatest(true);
  }

  /** The step running in the open chat: the newest unfinished tool call. */
  const currentTool = createMemo(() => (running() ? runningTool(feed()) : undefined));
  /** What the activity bar says: thinking, the running command or tool, waiting for the user, or stopping. */
  const activity = createMemo(() => activityLabel({ tool: currentTool(), approval: Boolean(permission() || childPermission()), answer: Boolean(elicitation()), stopping: state().stopRequested }));
  /** The open chat's turn clock, ticking once a second outside any live region. */
  const turnElapsed = () => clockText(clock() - (turnStart() || clock()));
  /** The running step pinned above the composer: its own elapsed time, the output tail and the quiet still-running line. */
  const runningStep = createMemo(() => {
    const tool = currentTool();
    if (!tool) return undefined;
    const times = toolTimes.get(`${tool.sessionId}:${tool.toolCallId}`);
    const now = clock();
    const preview = outputPreview(tool);
    return { ...runningTitle(tool), id: tool.toolCallId, elapsed: clockText(now - (times?.start ?? (turnStart() || now))), lines: preview.lines, hidden: preview.hidden, full: preview.all, still: stillRunningText(now - (times?.last ?? now)) };
  });
  /**
   * The single running bar above the composer: the newest running tool (with a "+N more" count), a just-finished tool
   * while it settles, or the phase (thinking, waiting, stopping). Every timer comes from `clock` and a recorded start.
   */
  const toolBar = (browser = false) =>
    toolBarView({
      running: running() ? runningTools(feed()) : [],
      finished: running() ? lastFinishedTool(feed()) : undefined,
      timesOf: (event) => toolTimes.get(`${event.sessionId}:${event.toolCallId}`),
      now: clock(),
      turnStart: turnStart(),
      approval: Boolean(permission() || childPermission()),
      answer: Boolean(elicitation()) && elicitation()?.mode !== "url",
      browser: browser || elicitation()?.mode === "url",
      stopping: state().stopRequested,
    });
  /** User chats in the background that wait for an approval or an answer. */
  const attentionCount = createMemo(() => attentionSessions(sessionStates(), state().sessionId).length);
  /** A session list row's state from the backend, or undefined for a session Span does not hold. */
  const rowStatusOf = (sessionId: string) => rowStatus(runtimeOf(sessionId), { now: clock() });
  /** True when the composer should explain what Enter, Tab and Esc do while a turn runs. */
  const runHint = createMemo(() => running() && (busyNotice() || Boolean(prompt().trim())));

  return {
    props,
    state,
    sessionStates,
    rowStatus: rowStatusOf,
    attentionCount,
    attentionAnnouncement,
    busyNotice,
    dismissBusyNotice: () => setBusyNotice(false),
    runHint,
    activity,
    turnElapsed,
    runningStep,
    toolBar,
    chatCount: () => backgroundThreads().length,
    /** The open chat's thread, and the keys of every thread held. For tests and diagnostics; components read the fields above. */
    focusedThread: focused,
    threadKeys: () => threads.list().map((thread) => thread.key),
    feed,
    savedImage: savedImages.get,
    connected,
    running,
    caps,
    blocked,
    canSend,
    permission,
    elicitation,
    fields,
    form,
    phases,
    connecting,
    prompt,
    setPrompt,
    view,
    setView,
    menu,
    setMenu,
    working,
    pendingAction,
    installed,
    registry,
    registryBusy,
    presets,
    connectPreset,
    registryName,
    agentLabel,
    installing,
    installingIds,
    installErrors,
    catalogSearch,
    setCatalogSearch,
    catalogRows,
    otherInstalled,
    pickCatalog,
    removal,
    removalBlock,
    requestRemoval,
    cancelRemoval: () => setRemoval(undefined),
    confirmRemoval,
    agentName,
    agentId,
    launch,
    selection,
    contextPaths,
    sessions,
    sessionsBusy,
    sessionsError,
    queue,
    queueHeld,
    sendQueued,
    attachments,
    intake,
    viewing,
    setViewing,
    viewingItem,
    viewingInComposer,
    findAttachment,
    openAttachment,
    setAttachmentOpener,
    online,
    setOnline,
    bannerDismissed,
    setBannerDismissed,
    pinned,
    setPinned,
    following,
    toggleFollow,
    toast,
    clearToast: () => setToast(undefined),
    openRefusal,
    clearOpenRefusal: () => setOpenRefusal(undefined),
    pasteScreenshot,
    addFolder,
    attachDroppedPaths,
    attachWorkspacePaths,
    earlierChats,
    attachSession,
    openInEditor,
    canClose,
    canDelete,
    deleteChat,
    closeChat,
    sessionMetaOf,
    sessionMeta,
    threadFor,
    health,
    healthNow: background.healthNow,
    healthOn: () => props.healthCheck !== false,
    liveAgents,
    currentTitle,
    canRename,
    renameChat,
    canArchive,
    archiveChat,
    canExport,
    exportChat,
    canFork,
    forkChat,
    sessionScope,
    setSessionScope,
    showSelection,
    turnStart,
    clock,
    scrollers,
    setInput: (element: HTMLTextAreaElement) => (input = element),
    focusPrompt,
    scrollToLatest,
    followLatest,
    dismissFailure: () => patch({ failure: undefined }),
    leaveConnecting: () => setConnecting(undefined),
    loadAgents,
    connectInstalled,
    connectCustom,
    reconnect,
    retryWithModel,
    canRetryModel,
    limitTurn,
    limitedModelValues,
    retryLimited,
    switchAgentAndResend,
    openResendPicker,
    resendArmed,
    install,
    disconnect,
    authenticate,
    authenticateWith,
    send,
    steer,
    sendText,
    drainQueue,
    sendQueuedNow,
    editQueued,
    removeQueued,
    reorderQueue,
    queueSending,
    sentNowIds,
    clearQueue: () => {
      pick(undefined);
      setQueue([]);
      setQueueHeld(false);
    },
    recallPrompt,
    setConfig,
    loadSessions,
    newChat,
    resumeChat,
    stop,
    answerPermission,
    cancelTask,
    openTaskSession,
    childPermission,
    childPermissions: childPermissionList,
    answerChildPermission,
    review,
    reviewMany,
    rewind,
    rewindFiles,
    branchBlock,
    editFrom,
    restoreTo,
    cancelRewind,
    revertFiles,
    keepFiles,
    resendFrom,
    forkFrom,
    answerForm,
    respondElicitation,
    openElicitationUrl,
    addCurrentFile,
    removeContextPath,
    hideSelection,
    saveAttachment,
    removeAttachment,
  };
}

export type AgentController = ReturnType<typeof createAgentController>;
