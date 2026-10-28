import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { AgentCommand, AgentEvent, AgentPreset_Serialize, BufferSnapshot, EditProposal, InstalledAgent, PromptAttachment, RegistryAgent, SessionSummary } from "../bindings";
import { createAttachmentIntake } from "../components/attachments";
import type { AuthSecret, Phase } from "../components/agent/types";
import { agentAuthenticateWith, agentCancelTask, agentChildPermission, agentDelegationStatus, agentPresets, api, isDesktop } from "./client";
import { childPermissions, isFinished, type ChildPermission } from "./agent-delegation";
import { buildAgentCatalog, curatedAgent, removalBlockReason, type CatalogRow } from "./acp-catalog";

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
import { bytesToBase64, planAttachment, type Attachment } from "./attachments";

const DELEGATION_POLL_MS = 3000;

export type AgentPanelProps = {
  workspacePath?: string;
  workspaceGeneration?: number;
  activePath?: string;
  selectionContext?: { path: string; text: string; startLine?: number; endLine?: number };
  onBufferChanged?: (path: string, snapshot?: BufferSnapshot) => void;
  onOpenSettings?: () => void;
  /** Removes an installed agent from Span, and with `uninstall` also deletes its managed adapter files. */
  removeAgent?: (id: string, uninstall: boolean) => Promise<void>;
  /** Opens a workspace file in the editor, at `line` (1-based) when given. */
  onOpenFile?: (path: string, line?: number) => void;
  onOpenExternal?: (url: string) => void;
  /** Called after the panel writes a file into the workspace, so the explorer can refresh. */
  onFilesChanged?: () => void;
  onProposalsChange?: (proposals: EditProposal[]) => void;
  onReviewBusyChange?: (busy: boolean) => void;
  onReviewInEditor?: (path: string, line?: number) => void;
  onReviewReady?: (review: (proposalId: string, acceptedHunkIds: string[]) => Promise<void>) => void;
};

export type View = "session" | "history" | "connect" | "logs";
export type Menu = "model" | "agents" | "attach" | "actions" | null;
export type Queued = { id: string; text: string; message: string; attachments: PromptAttachment[]; items: Attachment[] };
type Launch = { command: AgentCommand; name: string; id?: string };
/** A steer waiting for its turn to end. `turn` is the turn it interrupts; a steer never outlives that turn. */
type Steering = { entry: Queued; cancelled: boolean; turn: number };
type Connecting = { name: string; command: string; logBase: number; failed: boolean };

export const ATTACH_UNAVAILABLE = "Attachments need the span desktop app, which sends them to a connected agent.";
export const NATIVE_UNAVAILABLE = "Browser preview cannot write to or open workspace files.";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const utf8 = new TextEncoder();
let queueCounter = 0;

/** Agent session state and actions for the sidebar. The panel component only renders what this returns. */
export function createAgentController(props: AgentPanelProps) {
  const [state, setState] = createSignal<AgentState>(initialAgentState(isDesktop));
  const update = (change: (current: AgentState) => AgentState) => setState(change);
  const patch = (values: Partial<AgentState>) => setState((current) => ({ ...current, ...values }));
  const feed = createMemo(() => state().feed);
  const sessionId = createMemo(() => state().sessionId);
  const running = createMemo(() => state().running);

  const [prompt, setPrompt] = createSignal("");
  const [view, setView] = createSignal<View>("session");
  const [menu, setMenu] = createSignal<Menu>(null);
  const [working, setWorking] = createSignal(false);
  const [pendingAction, setPendingAction] = createSignal("");
  const [installed, setInstalled] = createSignal<InstalledAgent[]>([]);
  const [registry, setRegistry] = createSignal<RegistryAgent[]>([]);
  const [presets, setPresets] = createSignal<AgentPreset_Serialize[]>([]);
  const [registryBusy, setRegistryBusy] = createSignal(false);
  /** Registry ids being installed. Each install keeps its own row state, so other rows stay usable meanwhile. */
  const [installingIds, setInstallingIds] = createSignal<string[]>([]);
  const [installErrors, setInstallErrors] = createSignal<Record<string, string>>({});
  /** The first install in flight, for views that show one install at a time. */
  const installing = () => installingIds()[0];
  const [catalogSearch, setCatalogSearch] = createSignal("");
  /** An installed agent waiting for the user to confirm its removal. Nothing is removed until confirmRemoval. */
  const [removal, setRemoval] = createSignal<{ entry: InstalledAgent; uninstall: boolean }>();
  const [agentName, setAgentName] = createSignal("Select agent");
  const [agentId, setAgentId] = createSignal<string>();
  const [launch, setLaunch] = createSignal<Launch>();
  const [connecting, setConnecting] = createSignal<Connecting>();
  const [contextPaths, setContextPaths] = createSignal<string[]>([]);
  const [hiddenSelection, setHiddenSelection] = createSignal("");
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [sessionsBusy, setSessionsBusy] = createSignal(false);
  const [sessionsError, setSessionsError] = createSignal("");
  const [queue, setQueue] = createSignal<Queued[]>([]);
  /**
   * True when the queue must not drain on its own: the last turn ended with an error, the connection dropped, or a
   * reconnect or chat switch happened since the messages were queued. The user sends it with Send queued.
   */
  const [queueHeld, setQueueHeld] = createSignal(false);
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [viewing, setViewing] = createSignal<string>();
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);
  const [pinned, setPinned] = createSignal(true);
  /** Follow the agent: open files from tool call locations. Kept in memory only, so it resets on reload. */
  const [following, setFollowing] = createSignal(false);
  /** Name of the file the UI just opened for the user. `equals: false` restarts the toast for the same name. */
  const [toast, setToast] = createSignal<string | undefined>(undefined, { equals: false });
  const [turnStart, setTurnStart] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const [form, setForm] = createSignal<{ requestId: string; index: number; values: Record<string, string | number | boolean>; error?: string }>();
  let history: string[] = [];
  let historyIndex = -1;
  let priority: string | undefined;
  let steering: Steering | undefined;
  /** Counts dispatched turns, so a steer can tell its own turn from a later one. */
  let turnCounter = 0;
  const followed = new Set<string>();
  let disposed = false;
  let agentEpoch = 0;
  /**
   * An installed-agent read started before an install or removal finished must not overwrite that change, so reads
   * and mutations each carry a generation and a stale snapshot is dropped.
   */
  let installedReadGeneration = 0;
  let installedMutationGeneration = 0;
  let unsubscribe: (() => void) | undefined;
  let input: HTMLTextAreaElement | undefined;

  const selectionKey = createMemo(() => `${props.selectionContext?.path}:${props.selectionContext?.text}`);
  const selection = createMemo(() => (props.selectionContext?.text && hiddenSelection() !== selectionKey() ? props.selectionContext : undefined));
  /** Name shown for the connected agent in sentences. */
  const agentLabel = () => state().agent?.title || state().agent?.name || agentName();
  const connected = createMemo(() => Boolean(sessionId()) && !["disconnected", "error", "unavailable", "connecting"].includes(state().status));
  const caps = createMemo(() => promptCapabilities(state().agent?.features));
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
  const canSend = createMemo(() => connected() && !working() && !pendingAction() && Boolean(prompt().trim() || attachments().length) && blocked().length === 0);
  const proposals = createMemo<EditProposal[]>(() => unresolvedProposals(feed()), [], {
    equals: (previous, next) => previous.length === next.length && previous.every((proposal, index) => proposal === next[index]),
  });
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
  });

  createEffect(on(proposals, (list) => props.onProposalsChange?.(list)));
  createEffect(on(() => Boolean(pendingAction()), (busy) => props.onReviewBusyChange?.(busy)));
  createEffect(on(() => elicitation()?.requestId, (requestId) => setForm(requestId ? { requestId, index: 0, values: {} } : undefined)));
  createEffect(on(sessionId, (id) => {
    setBannerDismissed(false);
    if (id && state().canList) void loadSessions();
  }));
  createEffect(() => {
    if (!running()) return;
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
    priority = undefined;
    releaseSteer();
    holdQueue();
    followed.clear();
  }
  /** Stops the queue from draining on its own, when there is anything in it. */
  function holdQueue() {
    if (queue().length) setQueueHeld(true);
  }
  /**
   * The turn a steer was waiting on ended without the normal cancelled completion (prompt failure, an error event, a
   * dropped connection, a reconnect). The steer text goes back to the composer when it is empty, otherwise to the
   * front of the queue, and the steer is forgotten so it can never fire after some later, unrelated turn.
   */
  function releaseSteer() {
    const pending = steering;
    if (!pending) return;
    steering = undefined;
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
          setState(initialAgentState(isDesktop));
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
          steering = undefined;
          setQueue([]);
          setQueueHeld(false);
          resetSessionUi();
          setHiddenSelection(selectionKey());
        });
      },
    ),
  );

  function receive(event: AgentEvent) {
    const session = state().sessionId;
    update((current) => reduceAgentEvent(current, event));
    // Follow mode reveals the lead session's own work only. Delegated children run in other sessions.
    if (event.kind === "tool" && following() && session && event.sessionId === session) followTool(event);
    if (event.kind === "delegation" && (event.event.kind === "taskFinished" || event.event.kind === "delegated")) void refreshDelegation();
    if (event.kind === "complete" && (!session || event.sessionId === session)) queueMicrotask(() => (flushSteer(), drainQueue()));
    if (event.kind === "error" || (event.kind === "status" && ["error", "disconnected"].includes(event.state))) {
      // The turn ended abnormally: nothing queued or steered may go out on its own.
      releaseSteer();
      holdQueue();
    }
    if (event.kind === "status" && event.state === "disconnected") setConnecting((current) => (current ? { ...current, failed: true } : current));
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
  const hasLiveTask = createMemo(() => state().feed.some((item) => item.kind === "delegation" && !isFinished(item.task.status)));
  // Progress text and results come from the polled status, so refresh it while a task is live.
  createEffect(() => {
    if (!isDesktop || !hasLiveTask()) return;
    const timer = setInterval(() => void refreshDelegation(), DELEGATION_POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    props.onReviewReady?.(reviewHunks);
    if (isDesktop) {
      void api
        .onAgentEvent(receive)
        .then((cleanup) => {
          if (disposed) cleanup();
          else unsubscribe = cleanup;
        })
        .catch((cause) => fail({ phase: "session", message: `Agent event subscription failed: ${errorText(cause)}` }));
      void loadAgents();
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
  });

  const guard = (epoch: number) => () => !disposed && epoch === agentEpoch;

  function beginInstalledRead() {
    return { read: ++installedReadGeneration, mutation: installedMutationGeneration };
  }
  function applyInstalledSnapshot(token: ReturnType<typeof beginInstalledRead>, snapshot: InstalledAgent[]) {
    if (disposed || token.read !== installedReadGeneration || token.mutation !== installedMutationGeneration) return false;
    setInstalled(snapshot);
    return true;
  }
  function commitInstalledMutation(change: (current: InstalledAgent[]) => InstalledAgent[]) {
    installedMutationGeneration += 1;
    installedReadGeneration += 1;
    setInstalled(change(installed()));
  }
  function upsertInstalled(current: InstalledAgent[], incoming: InstalledAgent) {
    const index = current.findIndex((entry) => entry.id === incoming.id);
    if (index < 0) return [...current, incoming];
    return current.map((entry, currentIndex) => (currentIndex === index ? incoming : entry));
  }

  async function loadAgents() {
    if (!isDesktop || registryBusy()) return;
    setRegistryBusy(true);
    const installedRead = beginInstalledRead();
    const [local, remote, preset] = await Promise.allSettled([api.agentInstalled(), api.agentRegistry(), agentPresets()]);
    // A preset list that fails to load only hides the preset rows; the rest of the screen still works.
    if (preset.status === "fulfilled") setPresets(preset.value);
    if (local.status === "fulfilled") applyInstalledSnapshot(installedRead, local.value);
    else fail({ phase: "connect", message: `Could not read installed agents: ${errorText(local.reason)}` });
    if (remote.status === "fulfilled") setRegistry(remote.value);
    else fail({ phase: "connect", message: `Could not load the ACP registry: ${errorText(remote.reason)}` });
    setRegistryBusy(false);
  }
  const registryName = (id: string) => registry().find((agent) => agent.id === id)?.name;

  async function connect(command: AgentCommand, name: string, id?: string) {
    const current = guard(++agentEpoch);
    if (!props.workspacePath) {
      fail({ phase: "connect", message: "Open a folder before connecting an agent." });
      return;
    }
    const cwd = props.workspacePath;
    const hadSession = Boolean(sessionId());
    batch(() => {
      setWorking(true);
      setMenu(null);
      setView("session");
      setAgentName(name);
      setAgentId(id);
      setLaunch({ command, name, id });
      setConnecting({ name, command: [command.command, ...(command.args ?? [])].join(" "), logBase: state().logCount, failed: false });
      update((previous) => ({
        ...resetConversation(previous),
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
      resetSessionUi();
    });
    try {
      if (hadSession) await api.agentDisconnect();
      if (!current()) return;
      const id = await api.agentConnect(command, cwd);
      if (!current()) return;
      if (id) {
        patch({ sessionId: id, status: "ready", statusMessage: "Connected and ready" });
        setConnecting(undefined);
        focusPrompt();
      } else if (state().auth) {
        setConnecting(undefined);
      } else {
        throw new Error("The agent did not create a session.");
      }
    } catch (cause) {
      if (!current()) return;
      setConnecting((previous) => (previous ? { ...previous, failed: true } : previous));
      update((previous) => ({ ...previous, status: "error", statusMessage: "Connection failed", failure: { phase: "connect", message: errorText(cause), log: previous.stderr } }));
    } finally {
      if (current()) setWorking(false);
    }
  }
  const connectInstalled = (id: string) => {
    const entry = installed().find((agent) => agent.id === id);
    if (entry) void connect(entry.launch, registryName(entry.id) || entry.id, entry.id);
  };
  /** Connects a backend preset (a known launch command). The command shown on the row is exactly what runs. */
  const connectPreset = (id: string) => {
    const preset = presets().find((entry) => entry.id === id);
    if (preset) void connect({ command: preset.launch.command, args: preset.launch.args, env: preset.launch.env }, preset.name, preset.id);
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
  /**
   * Installs a registry agent. The result lands on its row even when the user connects another agent or changes view
   * meanwhile, and a second click on the same row while it installs does nothing.
   */
  async function install(id: string) {
    const entry = registry().find((agent) => agent.id === id);
    if (!entry || installingIds().includes(id)) return;
    setInstallingIds((previous) => [...previous, id]);
    setInstallErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    try {
      const added = await api.agentInstall(id);
      if (disposed) return;
      commitInstalledMutation((current) => upsertInstalled(current, added));
    } catch (cause) {
      if (disposed) return;
      setInstallErrors((previous) => ({ ...previous, [id]: errorText(cause) }));
      fail({ phase: "connect", message: `Could not install ${curatedAgent(id)?.name || entry.name}: ${errorText(cause)}` });
    } finally {
      if (!disposed) setInstallingIds((previous) => previous.filter((installingId) => installingId !== id));
    }
  }
  const catalogRows = createMemo<CatalogRow[]>(() => buildAgentCatalog(registry(), installed(), catalogSearch()));
  /** Installed adapters outside the curated list. */
  const otherInstalled = createMemo(() => installed().filter((entry) => !curatedAgent(entry.id)));
  /** Connects, installs or prepares the local command for one curated row. Returns the command line for a local row. */
  function pickCatalog(row: CatalogRow): string | undefined {
    if (row.installed) {
      void connect(row.installed.launch, row.definition.name, row.definition.id);
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
      }
      if (target) {
        setAgentId(undefined);
        if (launch()?.id === choice.entry.id) setLaunch(undefined);
      }
      await removeAgent(choice.entry.id, choice.uninstall);
      if (!current()) return;
      commitInstalledMutation((agents) => agents.filter((entry) => entry.id !== choice.entry.id));
      setRemoval(undefined);
      const installedRead = beginInstalledRead();
      try {
        const remaining = await api.agentInstalled();
        if (current()) applyInstalledSnapshot(installedRead, remaining);
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
      update((previous) => addFeedItem({ ...previous, sessionId: undefined, auth: undefined, running: false, status: "disconnected", statusMessage: "No agent connected" }, { kind: "note", text: "Agent disconnected" }));
      setConnecting(undefined);
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
      patch({ sessionId: id, auth: undefined, status: "ready", statusMessage: "Connected and ready" });
      focusPrompt();
    } catch (cause) {
      if (current()) fail({ phase: "auth", message: errorText(cause) });
    } finally {
      if (current()) setPendingAction("");
    }
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
      patch({ sessionId: id, auth: undefined, status: "ready", statusMessage: "Connected and ready" });
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
  async function dispatch(entry: Queued, options: { steered?: boolean } = {}) {
    const current = guard(agentEpoch);
    // A steer still waiting here belongs to an earlier turn; it must not fire after this one.
    if (steering && !options.steered) releaseSteer();
    const turn = ++turnCounter;
    update((previous) =>
      addFeedItem(
        { ...previous, running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", failure: undefined },
        { kind: "user", text: entry.text, attachments: entry.items.length ? entry.items : undefined, ...(options.steered ? { steered: true } : {}) },
      ),
    );
    setTurnStart(Date.now());
    setView("session");
    followLatest();
    try {
      await api.agentPrompt(entry.message, entry.attachments);
    } catch (cause) {
      if (!current()) return;
      update((previous) => ({
        ...previous,
        running: false,
        stopRequested: false,
        failure: { phase: "prompt", message: errorText(cause) },
        ...(previous.sessionId ? { status: "ready", statusMessage: "Prompt failed" } : {}),
      }));
      holdQueue();
      if (steering?.turn === turn) {
        // This turn was being steered: the user wants the steer, not this turn's text, back.
        releaseSteer();
        return;
      }
      if (turn !== turnCounter) return;
      if (!prompt()) setPrompt(entry.text);
      if (!attachments().length && entry.items.length) setAttachments(entry.items);
    }
  }
  /** Sends plain prompt text, for Continue, agent slash commands and Compact. */
  const sendText = (text: string) => {
    if (!connected() || running() || steering) return;
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
    const items = attachments();
    setWorking(true);
    try {
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
      if (mode === "steer" && running() && online()) void startSteer(entry);
      // A steer waiting for its cancel to resolve goes first, so anything sent meanwhile queues behind it.
      else if (running() || !online() || steering) setQueue((previous) => [...previous, entry]);
      else void dispatch(entry);
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Prompt failed: ${errorText(cause)}` });
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function startSteer(entry: Queued) {
    const current = guard(agentEpoch);
    if (steering) {
      // A steer is already waiting for its turn to end, so this one waits behind it.
      setQueue((previous) => [...previous, entry]);
      return;
    }
    const pending: Steering = { entry, cancelled: false, turn: turnCounter };
    steering = pending;
    patch({ stopRequested: true, statusMessage: "Steering the agent" });
    try {
      await api.agentCancel();
    } catch (cause) {
      // Released meanwhile (the turn errored or the connection dropped): the entry already went back to the user.
      if (!current() || steering !== pending) return;
      steering = undefined;
      setQueue((previous) => [entry, ...previous]);
      patch({ stopRequested: false, statusMessage: "Agent is working", failure: { phase: "prompt", message: `Could not cancel the turn, so the message was queued: ${errorText(cause)}` } });
      return;
    }
    if (!current() || steering !== pending) return;
    pending.cancelled = true;
    flushSteer();
  }
  /** Sends the steer message once the cancel resolved and the cancelled turn ended. Called from both sides. */
  function flushSteer() {
    if (!steering?.cancelled || running()) return;
    if (steering.turn !== turnCounter) {
      // Another turn ran since this steer started, so its moment has passed.
      releaseSteer();
      return;
    }
    const { entry } = steering;
    steering = undefined;
    void dispatch(entry, { steered: true });
  }
  /** Queued follow-ups go out together once the agent finishes, unless one was picked with Send now. */
  function drainQueue(options: { force?: boolean } = {}) {
    const waiting = queue();
    if (!waiting.length || running() || !connected() || !online() || steering) return;
    // A held queue goes out only on the user's word: Send queued, or Send now on one message (which sets `priority`).
    if (queueHeld() && !options.force && !priority) return;
    const chosen = priority ? waiting.find((entry) => entry.id === priority) : undefined;
    priority = undefined;
    if (chosen) {
      const rest = waiting.filter((entry) => entry !== chosen);
      setQueue(rest);
      if (!rest.length) setQueueHeld(false);
      void dispatch(chosen);
      return;
    }
    setQueue([]);
    setQueueHeld(false);
    void dispatch({
      id: `q-${++queueCounter}`,
      text: waiting.map((entry) => entry.text).join("\n\n"),
      message: waiting.map((entry) => entry.message).join("\n\n"),
      attachments: waiting.flatMap((entry) => entry.attachments),
      items: waiting.flatMap((entry) => entry.items),
    });
  }
  function sendQueuedNow(id: string) {
    if (running()) {
      priority = id;
      void stop();
      return;
    }
    priority = id;
    drainQueue({ force: true });
  }
  /** Send queued: the user's explicit go-ahead for a held queue. */
  const sendQueued = () => drainQueue({ force: true });
  /** Replaces the typed part of a queued message. Text added to an attachment-only message gets a blank line before the attachments. */
  const editQueued = (id: string, text: string) =>
    setQueue((previous) =>
      previous.map((entry) => {
        if (entry.id !== id) return entry;
        const rest = entry.message.slice(entry.text.length);
        const joiner = !entry.text && rest && !rest.startsWith("\n") ? "\n\n" : "";
        return { ...entry, text, message: `${text}${joiner}${rest}` };
      }),
    );
  const removeQueued = (id: string) =>
    setQueue((previous) => {
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

  async function setConfig(configId: string, value: string) {
    const current = guard(agentEpoch);
    const option = state().config.find((candidate) => candidate.id === configId);
    if (!option || value === option.currentValue) return;
    setPendingAction(`config:${configId}`);
    try {
      await api.agentSetConfig(configId, value);
    } catch (cause) {
      if (current()) fail({ phase: "session", message: `Could not change ${option.name}: ${errorText(cause)}` });
    } finally {
      if (current()) setPendingAction("");
    }
  }
  async function loadSessions() {
    if (!state().canList || sessionsBusy()) return;
    const current = guard(agentEpoch);
    setSessionsBusy(true);
    setSessionsError("");
    try {
      const found = await api.agentListSessions();
      if (current()) setSessions(found);
    } catch (cause) {
      if (current()) setSessionsError(errorText(cause));
    } finally {
      if (current()) setSessionsBusy(false);
    }
  }
  async function switchChat(start: () => Promise<string>, failure: string, options: { keepView?: boolean } = {}) {
    const current = guard(++agentEpoch);
    setMenu(null);
    setWorking(true);
    const previous = state();
    update((snapshot) => ({ ...resetConversation(snapshot), sessionId: undefined, failure: undefined }));
    // Queued messages and a pending steer are kept for the new chat, but only go out when the user says so.
    releaseSteer();
    holdQueue();
    followed.clear();
    try {
      const id = await start();
      if (!current()) return;
      patch({ sessionId: id, status: "ready", statusMessage: "Connected and ready" });
      if (!options.keepView) {
        setView("session");
        followLatest();
        focusPrompt();
      }
    } catch (cause) {
      if (!current()) return;
      patch({ feed: previous.feed, plan: previous.plan, usage: previous.usage, commands: previous.commands, sessionTitle: previous.sessionTitle, sessionId: previous.sessionId, failure: { phase: "session", message: `${failure}: ${errorText(cause)}` } });
    } finally {
      if (current()) setWorking(false);
    }
  }
  const newChat = () => switchChat(() => api.agentNewSession(), "Could not start a new chat");
  const resumeChat = (id: string) => switchChat(() => api.agentResumeSession(id), "Could not resume that chat");
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
    if (active) {
      await switchChat(() => api.agentNewSession(), "Could not start a new chat", { keepView: true });
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
  async function review(proposal: EditProposal, accept: boolean) {
    const current = guard(agentEpoch);
    setPendingAction(proposal.id);
    try {
      const buffer = await api.agentReview(proposal.id, accept, proposal.baseRevision);
      if (!current()) return;
      update((previous) => resolveProposal(previous, proposal.id, accept));
      if (accept) props.onBufferChanged?.(buffer.path, buffer);
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
        toolImageAttachment(id);
  const viewingItem = createMemo(() => findAttachment(viewing()));
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

  /**
   * Opens a workspace file for the user and confirms it with a toast. The path is checked against the workspace
   * root first, because most callers pass a path an agent supplied. `opener` lets the changes card use the
   * review opener. Returns false when nothing was opened.
   */
  function openInEditor(path: string, line?: number, opener: ((path: string, line?: number) => void) | undefined = props.onOpenFile): boolean {
    const relative = workspaceRelative(props.workspacePath, path);
    if (!relative || !opener) return false;
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
      if (openInEditor(relative, location.line)) return;
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
  const scrollToLatest = (smooth = false) =>
    requestAnimationFrame(() => scrollers.content?.scrollTo({ top: scrollers.content.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
  function followLatest() {
    setPinned(true);
    scrollToLatest(true);
  }

  return {
    props,
    state,
    feed,
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
    openInEditor,
    canClose,
    canDelete,
    deleteChat,
    closeChat,
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
    clearQueue: () => {
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
    childPermission,
    childPermissions: childPermissionList,
    answerChildPermission,
    review,
    reviewMany,
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
