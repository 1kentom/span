import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { AgentCommand, AgentEvent, BufferSnapshot, EditProposal, InstalledAgent, PromptAttachment, RegistryAgent, SessionSummary } from "../bindings";
import { createAttachmentIntake } from "../components/attachments";
import type { Phase } from "../components/agent/types";
import { api, isDesktop } from "./client";
import {
  addFeedItem,
  initialAgentState,
  openPermission,
  reduceAgentEvent,
  resetConversation,
  resolvePermission,
  resolveProposal,
  unresolvedProposals,
  type AgentState,
  type Failure,
} from "./agent-session";
import { buildPrompt, coerceAnswer, formFields, leaf, promptCapabilities, saveName, splitCommandLine } from "./agent-view";
import { bytesToBase64, planAttachment, type Attachment } from "./attachments";

export type AgentPanelProps = {
  workspacePath?: string;
  workspaceGeneration?: number;
  activePath?: string;
  selectionContext?: { path: string; text: string; startLine?: number; endLine?: number };
  onBufferChanged?: (path: string, snapshot?: BufferSnapshot) => void;
  onOpenSettings?: () => void;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
  /** Called after the panel writes a file into the workspace, so the explorer can refresh. */
  onFilesChanged?: () => void;
  onProposalsChange?: (proposals: EditProposal[]) => void;
  onReviewBusyChange?: (busy: boolean) => void;
  onReviewInEditor?: (path: string) => void;
  onReviewReady?: (review: (proposalId: string, acceptedHunkIds: string[]) => Promise<void>) => void;
};

export type View = "session" | "history" | "connect" | "logs";
export type Menu = "model" | "agents" | "context" | "actions" | null;
export type Queued = { id: string; text: string; message: string; attachments: PromptAttachment[]; items: Attachment[] };
type Launch = { command: AgentCommand; name: string; id?: string };
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
  const [registryBusy, setRegistryBusy] = createSignal(false);
  const [installing, setInstalling] = createSignal<string>();
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
  const [attachments, setAttachments] = createSignal<Attachment[]>([]);
  const [viewing, setViewing] = createSignal<string>();
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [bannerDismissed, setBannerDismissed] = createSignal(false);
  const [pinned, setPinned] = createSignal(true);
  const [turnStart, setTurnStart] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const [form, setForm] = createSignal<{ requestId: string; index: number; values: Record<string, string | number | boolean>; error?: string }>();
  let history: string[] = [];
  let historyIndex = -1;
  let priority: string | undefined;
  let disposed = false;
  let agentEpoch = 0;
  let unsubscribe: (() => void) | undefined;
  let input: HTMLTextAreaElement | undefined;

  const selectionKey = createMemo(() => `${props.selectionContext?.path}:${props.selectionContext?.text}`);
  const selection = createMemo(() => (props.selectionContext?.text && hiddenSelection() !== selectionKey() ? props.selectionContext : undefined));
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

  function resetSessionUi() {
    setSessions([]);
    setSessionsError("");
    setQueue([]);
    setMenu(null);
    setPinned(true);
    setBannerDismissed(false);
    priority = undefined;
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
          setConnecting(undefined);
          setWorking(false);
          setPendingAction("");
          setView("session");
          setPrompt("");
          setContextPaths([]);
          setAttachments([]);
          setViewing(undefined);
          resetSessionUi();
          setHiddenSelection(selectionKey());
        });
      },
    ),
  );

  function receive(event: AgentEvent) {
    update((current) => reduceAgentEvent(current, event));
    if (event.kind === "complete") queueMicrotask(drainQueue);
    if (event.kind === "status" && event.state === "disconnected") setConnecting((current) => (current ? { ...current, failed: true } : current));
  }

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

  async function loadAgents() {
    if (!isDesktop || registryBusy()) return;
    setRegistryBusy(true);
    const [local, remote] = await Promise.allSettled([api.agentInstalled(), api.agentRegistry()]);
    if (local.status === "fulfilled") setInstalled(local.value);
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
  async function install(id: string) {
    const entry = registry().find((agent) => agent.id === id);
    if (!entry) return;
    const current = guard(agentEpoch);
    setInstalling(id);
    try {
      await api.agentInstall(id);
      if (!current()) return;
      setInstalled(await api.agentInstalled());
    } catch (cause) {
      if (current()) fail({ phase: "connect", message: `Could not install ${entry.name}: ${errorText(cause)}` });
    } finally {
      if (current()) setInstalling(undefined);
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

  async function compose(text: string, selected: ReturnType<typeof selection>) {
    const files = await Promise.all(contextPaths().map((path) => api.openBuffer(path)));
    const contexts = files.map((file) => `File: ${file.path}\n${file.text}`);
    if (selected) contexts.push(`Selected code from ${selected.path}${selected.startLine ? `, line ${selected.startLine}` : ""}:\n${selected.text}`);
    return contexts.length ? `${text}\n\nEditor context:\n${contexts.join("\n\n")}` : text;
  }
  async function dispatch(entry: Queued) {
    const current = guard(agentEpoch);
    update((previous) =>
      addFeedItem(
        { ...previous, running: true, stopRequested: false, status: "busy", statusMessage: "Agent is working", failure: undefined },
        { kind: "user", text: entry.text, attachments: entry.items.length ? entry.items : undefined },
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
      if (!prompt()) setPrompt(entry.text);
      if (!attachments().length && entry.items.length) setAttachments(entry.items);
    }
  }
  /** Sends plain prompt text, for Continue, agent slash commands and Compact. */
  const sendText = (text: string) => {
    if (!connected() || running()) return;
    void dispatch({ id: `q-${++queueCounter}`, text, message: text, attachments: [], items: [] });
  };
  async function send() {
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
      if (running() || !online()) setQueue((previous) => [...previous, entry]);
      else void dispatch(entry);
    } catch (cause) {
      if (current()) fail({ phase: "prompt", message: `Prompt failed: ${errorText(cause)}` });
    } finally {
      if (current()) setWorking(false);
    }
  }
  /** Queued follow-ups go out together once the agent finishes, unless one was picked with Send now. */
  function drainQueue() {
    const waiting = queue();
    if (!waiting.length || running() || !connected() || !online()) return;
    const chosen = priority ? waiting.find((entry) => entry.id === priority) : undefined;
    priority = undefined;
    if (chosen) {
      setQueue(waiting.filter((entry) => entry !== chosen));
      void dispatch(chosen);
      return;
    }
    setQueue([]);
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
    drainQueue();
  }
  const editQueued = (id: string, text: string) =>
    setQueue((previous) => previous.map((entry) => (entry.id === id ? { ...entry, text, message: text + entry.message.slice(entry.text.length) } : entry)));
  const removeQueued = (id: string) => setQueue((previous) => previous.filter((entry) => entry.id !== id));

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
  async function switchChat(start: () => Promise<string>, failure: string) {
    const current = guard(++agentEpoch);
    setMenu(null);
    setWorking(true);
    const previous = state();
    update((snapshot) => ({ ...resetConversation(snapshot), sessionId: undefined, failure: undefined }));
    setQueue([]);
    try {
      const id = await start();
      if (!current()) return;
      patch({ sessionId: id, status: "ready", statusMessage: "Connected and ready" });
      setView("session");
      followLatest();
      focusPrompt();
    } catch (cause) {
      if (!current()) return;
      patch({ feed: previous.feed, plan: previous.plan, usage: previous.usage, commands: previous.commands, sessionTitle: previous.sessionTitle, sessionId: previous.sessionId, failure: { phase: "session", message: `${failure}: ${errorText(cause)}` } });
    } finally {
      if (current()) setWorking(false);
    }
  }
  const newChat = () => switchChat(() => api.agentNewSession(), "Could not start a new chat");
  const resumeChat = (id: string) => switchChat(() => api.agentResumeSession(id), "Could not resume that chat");

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
  const findAttachment = (id: string | undefined) =>
    id === undefined
      ? undefined
      : attachments().find((item) => item.id === id) ??
        feed().flatMap((item) => (item.kind === "user" ? item.attachments ?? [] : [])).find((item) => item.id === id);
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
    registryName,
    installing,
    agentName,
    agentId,
    launch,
    selection,
    contextPaths,
    sessions,
    sessionsBusy,
    sessionsError,
    queue,
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
    send,
    sendText,
    drainQueue,
    sendQueuedNow,
    editQueued,
    removeQueued,
    clearQueue: () => setQueue([]),
    recallPrompt,
    setConfig,
    loadSessions,
    newChat,
    resumeChat,
    stop,
    answerPermission,
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
