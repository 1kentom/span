import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  AgentCommand,
  AgentAuthMethod_Deserialize as AgentAuthMethod,
  BufferSnapshot,
  AgentEvent,
  ConfigOption_Deserialize as ConfigOption,
  EditProposal,
  InstalledAgent,
  RegistryAgent,
  SessionSummary,
} from "../bindings";
import {
  buildAgentCatalog,
  curatedAgent,
  agentFailureMessage,
  removalBlockReason,
  type CatalogRow,
} from "../lib/acp-catalog";
import { api, isDesktop } from "../lib/client";
import { FileIcon, Icon, MenuIcon } from "./Icon";
import { BrandIcon } from "./BrandIcon";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPermission } from "./AgentPermission";
import { AgentTool } from "./AgentTool";
import {
  formatElapsed,
  isNearBottom,
  isNestedTool,
  relativeTime,
  subagentChildren,
  toolSummary,
} from "../lib/agent-feed";
import "../styles/agent.css";

type AgentPanelProps = {
  workspacePath?: string;
  workspaceGeneration?: number;
  activePath?: string;
  selectionContext?: {
    path: string;
    text: string;
    startLine?: number;
    endLine?: number;
  };
  onBufferChanged?: (path: string, snapshot?: BufferSnapshot) => void;
  onOpenSettings?: () => void;
  removeAgent?: (id: string, uninstall: boolean) => Promise<void>;
  onOpenFile?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
  onProposalsChange?: (proposals: EditProposal[]) => void;
  onReviewBusyChange?: (busy: boolean) => void;
  onReviewInEditor?: (path: string) => void;
  onReviewReady?: (
    review: (proposalId: string, acceptedHunkIds: string[]) => Promise<void>,
  ) => void;
};
type Plan = Extract<AgentEvent, { kind: "plan" }>;
type Tool = Extract<AgentEvent, { kind: "tool" }>;
type Permission = Extract<AgentEvent, { kind: "permission" }>;
type FeedItem =
  | { id: number; kind: "user" | "text" | "thought" | "note"; text: string }
  | { id: number; kind: "plan"; event: Plan }
  | { id: number; kind: "tool"; event: Tool }
  | { id: number; kind: "permission"; event: Permission; resolved: boolean }
  | {
      id: number;
      kind: "proposal";
      proposal: EditProposal;
      resolution?: "accepted" | "rejected";
    };
type Menu =
  | "agent"
  | "session"
  | "context"
  | "custom"
  | "commands"
  | "remove"
  | "config"
  | null;
type Queued = { id: number; text: string; message: string };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const leaf = (path: string) => path.split("/").pop() || path;
const LOG_LIMIT = 240;
const FEED_LIMIT = 400;

export function AgentPanel(props: AgentPanelProps) {
  const [prompt, setPrompt] = createSignal("");
  const [feed, setFeed] = createSignal<FeedItem[]>([]);
  const [logs, setLogs] = createSignal<string[]>([]);
  const [logCount, setLogCount] = createSignal(0);
  const [showLogs, setShowLogs] = createSignal(false);
  const [menu, setMenu] = createSignal<Menu>(null);
  const [status, setStatus] = createSignal(
    isDesktop ? "disconnected" : "unavailable",
  );
  const [statusMessage, setStatusMessage] = createSignal(
    isDesktop ? "No agent connected" : "Agents require the desktop app",
  );
  const [sessionId, setSessionId] = createSignal<string>();
  const [agentName, setAgentName] = createSignal("Select agent");
  const [activeAgentId, setActiveAgentId] = createSignal<string>();
  const [catalogSearch, setCatalogSearch] = createSignal("");
  const [managementId, setManagementId] = createSignal<string>();
  const [removal, setRemoval] = createSignal<{
    entry: InstalledAgent;
    uninstall: boolean;
  }>();
  const [running, setRunning] = createSignal(false);
  const [stopRequested, setStopRequested] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [installingIds, setInstallingIds] = createSignal<string[]>([]);
  const [installErrors, setInstallErrors] = createSignal<Record<string, string>>({});
  const [error, setError] = createSignal("");
  const [installed, setInstalled] = createSignal<InstalledAgent[]>([]);
  const [registry, setRegistry] = createSignal<RegistryAgent[]>([]);
  const [registryBusy, setRegistryBusy] = createSignal(false);
  const [registryLoaded, setRegistryLoaded] = createSignal(false);
  const [executable, setExecutable] = createSignal("");
  const [argumentsJson, setArgumentsJson] = createSignal("[]");
  const [contextPaths, setContextPaths] = createSignal<string[]>([]);
  const [hiddenSelection, setHiddenSelection] = createSignal("");
  const [pendingAction, setPendingAction] = createSignal("");
  const [configOptions, setConfigOptions] = createSignal<ConfigOption[]>([]);
  const [authMethods, setAuthMethods] = createSignal<AgentAuthMethod[]>([]);
  const [authMessage, setAuthMessage] = createSignal("");
  const [authError, setAuthError] = createSignal("");
  const [authMethodBusy, setAuthMethodBusy] = createSignal("");
  const [authRetryMethod, setAuthRetryMethod] = createSignal<string>();
  const [configMenuId, setConfigMenuId] = createSignal("");
  const [canLoad, setCanLoad] = createSignal(false);
  const [canList, setCanList] = createSignal(false);
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [sessionsBusy, setSessionsBusy] = createSignal(false);
  const [sessionsError, setSessionsError] = createSignal("");
  const [queue, setQueue] = createSignal<Queued[]>([]);
  const [pinned, setPinned] = createSignal(true);
  const [turnStart, setTurnStart] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  let history: string[] = [];
  let historyIndex = -1;
  let nextId = 0;
  let input: HTMLTextAreaElement | undefined;
  let content: HTMLDivElement | undefined;
  const [feedElement, setFeedElement] = createSignal<HTMLDivElement>();
  let menuElement: HTMLDivElement | undefined;
  let disposed = false;
  let agentEpoch = 0;
  let installedReadGeneration = 0;
  let installedMutationGeneration = 0;
  let unsubscribe: (() => void) | undefined;
  const selectionKey = createMemo(
    () => `${props.selectionContext?.path}:${props.selectionContext?.text}`,
  );
  const selection = createMemo(() =>
    props.selectionContext?.text && hiddenSelection() !== selectionKey()
      ? props.selectionContext
      : undefined,
  );
  const connected = createMemo(
    () =>
      Boolean(sessionId()) &&
      !["disconnected", "error", "unavailable", "connecting"].includes(
        status(),
      ),
  );
  const canSend = createMemo(
    () =>
      connected() && !working() && !pendingAction() && Boolean(prompt().trim()),
  );
  const firstOpenPermission = createMemo(
    () =>
      feed().find((item) => item.kind === "permission" && !item.resolved)?.id,
  );
  const toolFor = (toolCallId: string) =>
    feed().find(
      (item) => item.kind === "tool" && item.event.toolCallId === toolCallId,
    );
  const unresolvedProposals = createMemo<EditProposal[]>(
    () =>
      feed().flatMap((item) =>
        item.kind === "proposal" && !item.resolution ? [item.proposal] : [],
      ),
    [],
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((proposal, index) => proposal === next[index]),
    },
  );
  createEffect(
    on(unresolvedProposals, (proposals) =>
      props.onProposalsChange?.(proposals),
    ),
  );
  createEffect(
    on(
      () => Boolean(pendingAction()),
      (busy) => props.onReviewBusyChange?.(busy),
    ),
  );
  const catalogRows = createMemo(() =>
    buildAgentCatalog(registry(), installed(), catalogSearch()),
  );
  const otherInstalled = createMemo(() =>
    installed().filter((entry) => !curatedAgent(entry.id)),
  );
  const removalBlock = createMemo(() =>
    removalBlockReason(
      Boolean(sessionId()) && activeAgentId() === removal()?.entry.id,
      running(),
      unresolvedProposals().length,
      feed().some((item) => item.kind === "permission" && !item.resolved),
    ),
  );
  const addItem = (item: FeedItem) =>
    setFeed((previous) => [...previous, item].slice(-FEED_LIMIT));
  const note = (text: string) => addItem({ id: ++nextId, kind: "note", text });
  const fail = (action: string, cause: unknown) =>
    setError(`${action}: ${errorText(cause)}`);
  const focusPrompt = () => {
    setShowLogs(false);
    input?.focus();
  };
  function beginInstalledRead() {
    return {
      read: ++installedReadGeneration,
      mutation: installedMutationGeneration,
    };
  }
  function applyInstalledSnapshot(
    token: ReturnType<typeof beginInstalledRead>,
    snapshot: InstalledAgent[],
  ) {
    if (
      disposed ||
      token.read !== installedReadGeneration ||
      token.mutation !== installedMutationGeneration
    )
      return false;
    setInstalled(snapshot);
    return true;
  }
  function commitInstalledMutation(
    update: (current: InstalledAgent[]) => InstalledAgent[],
  ) {
    installedMutationGeneration += 1;
    installedReadGeneration += 1;
    setInstalled(update(installed()));
  }
  function upsertInstalled(
    current: InstalledAgent[],
    incoming: InstalledAgent,
  ) {
    const index = current.findIndex((entry) => entry.id === incoming.id);
    if (index < 0) return [...current, incoming];
    return current.map((entry, currentIndex) =>
      currentIndex === index ? incoming : entry,
    );
  }

  createEffect(
    on(
      () => [props.workspacePath, props.workspaceGeneration] as const,
      ([path, generation], previous) => {
        if (previous && path === previous[0] && generation === previous[1])
          return;
        if (previous && (sessionId() || authMessage() || status() === "connecting")) {
          void api.agentDisconnect().catch(() => undefined);
        }
        agentEpoch += 1;
        setSessionId(undefined);
        setAuthMethods([]);
        setAuthMessage("");
        setAuthError("");
        setAuthRetryMethod(undefined);
        setAuthMethodBusy("");
        setAgentName("Select agent");
        setActiveAgentId(undefined);
        setRemoval(undefined);
        setManagementId(undefined);
        setRunning(false);
        setStopRequested(false);
        setWorking(false);
        setPendingAction("");
        setStatus(isDesktop ? "disconnected" : "unavailable");
        setStatusMessage(
          isDesktop ? "No agent connected" : "Agents require the desktop app",
        );
        setFeed([]);
        setLogs([]);
        setLogCount(0);
        setShowLogs(false);
        setMenu(null);
        setError("");
        setPrompt("");
        setContextPaths([]);
        resetSessionState();
        setHiddenSelection(selectionKey());
      },
    ),
  );

  function resetSessionState() {
    setConfigOptions([]);
    setConfigMenuId("");
    setSessions([]);
    setSessionsError("");
    setQueue([]);
    setCanLoad(false);
    setCanList(false);
    setPinned(true);
  }

  function receive(event: AgentEvent) {
    if (
      "sessionId" in event &&
      event.kind !== "session" &&
      sessionId() &&
      event.sessionId !== sessionId()
    )
      return;
    if (event.kind === "log") {
      setLogCount((count) => count + 1);
      setLogs((previous) =>
        [
          ...previous,
          `[${event.direction}] ${event.line.slice(0, 6000)}${event.line.length > 6000 ? " [line truncated]" : ""}`,
        ].slice(-LOG_LIMIT),
      );
    } else if (event.kind === "status") {
      setStatus(event.state);
      setStatusMessage(event.message);
      if (["error", "disconnected"].includes(event.state)) {
        setRunning(false);
        setStopRequested(false);
        setSessionId(undefined);
        setAuthMethods([]);
        setAuthMessage("");
        setAuthError("");
        setAuthRetryMethod(undefined);
      }
    } else if (event.kind === "session") {
      setSessionId(event.sessionId);
      setStatus("ready");
    } else if (event.kind === "capabilities") {
      setCanLoad(event.canLoadSession);
      setCanList(event.canListSessions);
    } else if (event.kind === "authenticationRequired") {
      setSessionId(undefined);
      setRunning(false);
      resetSessionState();
      setAuthMethods(event.methods);
      setAuthMessage(event.message);
      setAuthError("");
      setAuthMethodBusy("");
      setAuthRetryMethod(undefined);
      setAuthRetryMethod(undefined);
      setWorking(false);
      setStatus("auth-required");
      setStatusMessage("Sign in to continue");
    } else if (event.kind === "config") {
      setConfigOptions(event.options);
    } else if (event.kind === "user") {
      setFeed((previous) => {
        const last = previous[previous.length - 1];
        if (last && last.kind === "user")
          return [
            ...previous.slice(0, -1),
            { ...last, text: last.text + event.text },
          ];
        return [
          ...previous,
          { id: ++nextId, kind: "user" as const, text: event.text },
        ].slice(-FEED_LIMIT);
      });
    } else if (event.kind === "text" || event.kind === "thought") {
      setFeed((previous) => {
        const last = previous[previous.length - 1];
        if (
          last &&
          (last.kind === "text" || last.kind === "thought") &&
          last.kind === event.kind
        )
          return [
            ...previous.slice(0, -1),
            { ...last, text: last.text + event.text },
          ];
        return [
          ...previous,
          { id: ++nextId, kind: event.kind, text: event.text },
        ].slice(-FEED_LIMIT);
      });
    } else if (event.kind === "plan") {
      const existing = feed().findIndex((item) => item.kind === "plan");
      if (existing >= 0)
        setFeed((previous) =>
          previous.map((item, index) =>
            index === existing ? { id: item.id, kind: "plan", event } : item,
          ),
        );
      else addItem({ id: ++nextId, kind: "plan", event });
    } else if (event.kind === "tool") {
      const existing = feed().findIndex(
        (item) =>
          item.kind === "tool" && item.event.toolCallId === event.toolCallId,
      );
      if (existing >= 0)
        setFeed((previous) =>
          previous.map((item, index) =>
            index === existing && item.kind === "tool"
              ? {
                  ...item,
                  event: {
                    ...item.event,
                    ...event,
                    title: event.title ?? item.event.title,
                    status: event.status ?? item.event.status,
                  },
                }
              : item,
          ),
        );
      else addItem({ id: ++nextId, kind: "tool", event });
    } else if (event.kind === "permission") {
      addItem({ id: ++nextId, kind: "permission", event, resolved: false });
    } else if (event.kind === "permissionResolved") {
      setFeed((previous) =>
        previous.map((item) =>
          item.kind === "permission" && item.event.requestId === event.requestId
            ? { ...item, resolved: true }
            : item,
        ),
      );
    } else if (event.kind === "proposal") {
      addItem({ id: ++nextId, kind: "proposal", proposal: event.proposal });
    } else if (event.kind === "proposalResolved") {
      setFeed((previous) =>
        previous.map((item) =>
          item.kind === "proposal" && item.proposal.id === event.proposalId
            ? { ...item, resolution: event.accepted ? "accepted" : "rejected" }
            : item,
        ),
      );
    } else if (event.kind === "complete") {
      setRunning(false);
      setStopRequested(false);
      setStatus("ready");
      setStatusMessage(`Ready · ${event.stopReason.replaceAll("_", " ")}`);
      note(`Turn finished: ${event.stopReason.replaceAll("_", " ")}`);
      queueMicrotask(drainQueue);
    } else if (event.kind === "error") {
      setRunning(false);
      setStopRequested(false);
      if (sessionId()) {
        setStatus("ready");
        setStatusMessage("The last agent operation failed");
      }
      setError(agentFailureMessage(event.message));
    }
  }

  onMount(() => {
    props.onReviewReady?.(reviewHunks);
    if (isDesktop)
      void api
        .onAgentEvent(receive)
        .then((cleanup) => {
          if (disposed) cleanup();
          else unsubscribe = cleanup;
        })
        .catch((cause) => fail("Agent event subscription failed", cause));
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        focusPrompt();
      }
      if (event.key === "Escape") {
        if (menu()) {
          event.preventDefault();
          setMenu(null);
          input?.focus();
        } else if (running()) {
          event.preventDefault();
          void stop();
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    onCleanup(() => window.removeEventListener("keydown", keyboard));
  });
  onCleanup(() => {
    if (sessionId() || authMessage() || status() === "connecting") {
      void api.agentDisconnect().catch(() => undefined);
    }
    disposed = true;
    unsubscribe?.();
  });
  createEffect(() => {
    const value = prompt();
    if (input) {
      input.style.height = "auto";
      input.style.height = `${Math.min(180, Math.max(61, input.scrollHeight))}px`;
    }
    if (value === "/") setMenu("commands");
  });
  const scrollToLatest = (smooth = false) =>
    requestAnimationFrame(() =>
      content?.scrollTo({
        top: content.scrollHeight,
        behavior: smooth ? "smooth" : "auto",
      }),
    );
  function followLatest() {
    setPinned(true);
    scrollToLatest(true);
  }
  createEffect(() => {
    feed();
    logs();
    showLogs();
    queue();
    if (pinned()) scrollToLatest();
  });
  createEffect(() => {
    // Markdown and highlighting settle after the feed signal changes, so watch the real height.
    const element = feedElement();
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned()) scrollToLatest();
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    if (!running()) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    const open = menu();
    if (open)
      queueMicrotask(() =>
        menuElement
          ?.querySelector<HTMLElement>("input, button:not(:disabled)")
          ?.focus(),
      );
  });
  function menuKeyboard(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      setMenu(null);
      input?.focus();
      return;
    }
    if (
      !(event.target instanceof HTMLButtonElement) ||
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    )
      return;
    const options = [
      ...(menuElement?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) || []),
    ];
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
    options[next].focus();
  }

  async function loadAgents() {
    if (!isDesktop || registryBusy()) return;
    setRegistryBusy(true);
    setError("");
    const installedRead = beginInstalledRead();
    const results = await Promise.allSettled([
      api.agentInstalled(),
      api.agentRegistry(),
    ]);
    if (results[0].status === "fulfilled")
      applyInstalledSnapshot(installedRead, results[0].value);
    else fail("Could not read installed agents", results[0].reason);
    if (results[1].status === "fulfilled") setRegistry(results[1].value);
    else fail("Could not load the ACP registry", results[1].reason);
    setRegistryLoaded(true);
    setRegistryBusy(false);
  }
  function openMenu(next: Exclude<Menu, null>) {
    setMenu((current) => (current === next ? null : next));
    if (next === "agent" && !registryLoaded()) void loadAgents();
    if (next === "session" && connected() && canList()) void loadSessions();
  }
  function toggleConfig(option: ConfigOption) {
    if (menu() === "config" && configMenuId() === option.id) {
      setMenu(null);
      return;
    }
    setConfigMenuId(option.id);
    setMenu("config");
  }
  const choiceName = (option: ConfigOption) =>
    option.groups
      .flatMap((group) => group.choices)
      .find((choice) => choice.value === option.currentValue)?.name ??
    option.currentValue;
  async function connect(
    command: AgentCommand,
    name: string,
    identity?: string,
  ) {
    const epoch = ++agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    if (!props.workspacePath) {
      setError("Open a workspace folder before starting an agent.");
      return;
    }
    const cwd = props.workspacePath;
    setWorking(true);
    setError("");
    setMenu(null);
    setStatus("connecting");
    setStatusMessage(`Starting ${name}`);
    try {
      if (sessionId() || authMessage()) await api.agentDisconnect();
      if (!current()) return;
      setFeed([]);
      resetSessionState();
      setSessionId(undefined);
      setAuthMethods([]);
      setAuthMessage("");
      setAuthError("");
      setAuthMethodBusy("");
      setAuthRetryMethod(undefined);
      setAgentName(name);
      setActiveAgentId(identity);
      const id = await api.agentConnect(command, cwd);
      if (!current()) return;
      setSessionId(id ?? undefined);
      if (id) {
        setStatus("ready");
        setStatusMessage("Connected and ready");
        focusPrompt();
      }
    } catch (cause) {
      if (!current()) return;
      setStatus("error");
      setStatusMessage("Connection failed");
      fail(`Could not connect ${name}`, agentFailureMessage(errorText(cause)));
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function authenticate(method: AgentAuthMethod) {
    if (!authMethods().some((candidate) => candidate.methodId === method.methodId))
      return;
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setAuthMethodBusy(method.methodId);
    setAuthError("");
    setWorking(true);
    try {
      const id = await api.agentAuthenticate(method.methodId);
      if (!current()) return;
      setSessionId(id);
      setAuthMethods([]);
      setAuthMessage("");
      setAuthError("");
      setAuthRetryMethod(undefined);
      setStatus("ready");
      setStatusMessage("Connected and ready");
      focusPrompt();
    } catch (cause) {
      if (!current()) return;
      setAuthError(agentFailureMessage(errorText(cause)));
      setAuthRetryMethod(method.methodId);
      setStatus("auth-required");
      setStatusMessage("Sign in to continue");
    } finally {
      if (current()) {
        setWorking(false);
        setAuthMethodBusy("");
      }
    }
  }
  async function cancelAuthentication() {
    agentEpoch += 1;
    try {
      await api.agentDisconnect();
      setAuthMethods([]);
      setAuthMessage("");
      setAuthError("");
      setAuthRetryMethod(undefined);
      setSessionId(undefined);
      setActiveAgentId(undefined);
      setStatus("disconnected");
      setStatusMessage("No agent connected");
    } catch (cause) {
      setAuthError(errorText(cause));
    }
  }
  function pickCatalog(row: CatalogRow) {
    if (row.installed) {
      void connect(
        row.installed.launch,
        row.definition.name,
        row.definition.id,
      );
      return;
    }
    if (row.action === "install" && row.registry) {
      void install(row.registry);
      return;
    }
    if (row.action === "local" && row.definition.localCommand) {
      setExecutable(row.definition.localCommand.command);
      setArgumentsJson(JSON.stringify(row.definition.localCommand.args));
      setMenu("custom");
    }
  }
  function requestRemoval(entry: InstalledAgent, uninstall: boolean) {
    setRemoval({ entry, uninstall });
    setManagementId(undefined);
    setMenu("remove");
  }
  async function confirmRemoval() {
    const choice = removal();
    const removeAgent = props.removeAgent;
    if (!choice || !removeAgent || removalBlock() || working()) return;
    // Invalidate an in-flight connection to the adapter being removed. Leave
    // unrelated active sessions and their async work alone.
    const isActiveTarget = activeAgentId() === choice.entry.id;
    if (isActiveTarget) agentEpoch += 1;
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setWorking(true);
    setError("");
    try {
      if (sessionId() && activeAgentId() === choice.entry.id) {
        await api.agentDisconnect();
        if (!current()) return;
        setSessionId(undefined);
        setActiveAgentId(undefined);
        setRunning(false);
        setStatus("disconnected");
        setStatusMessage("No agent connected");
      }
      await removeAgent(choice.entry.id, choice.uninstall);
      if (!current()) return;
      commitInstalledMutation((currentAgents) =>
        currentAgents.filter((entry) => entry.id !== choice.entry.id),
      );
      setRemoval(undefined);
      setMenu("agent");
      const installedRead = beginInstalledRead();
      try {
        const remaining = await api.agentInstalled();
        if (current()) applyInstalledSnapshot(installedRead, remaining);
      } catch (cause) {
        if (current()) fail("Could not refresh installed agents", cause);
      }
    } catch (cause) {
      if (current()) fail("Could not remove agent", cause);
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function connectCustom(event: SubmitEvent) {
    event.preventDefault();
    try {
      const args: unknown = JSON.parse(argumentsJson());
      if (
        !Array.isArray(args) ||
        args.some((value) => typeof value !== "string")
      )
        throw new Error(
          'Arguments must be a JSON array of strings, for example ["--stdio"].',
        );
      if (!executable().trim())
        throw new Error("Enter an executable path or command.");
      await connect(
        { command: executable().trim(), args, env: {} },
        leaf(executable().trim()),
      );
    } catch (cause) {
      fail("Custom agent", cause);
    }
  }
  async function install(entry: RegistryAgent) {
    if (installingIds().includes(entry.id)) return;
    setInstallingIds((previous) => [...previous, entry.id]);
    setInstallErrors((previous) => {
      const next = { ...previous };
      delete next[entry.id];
      return next;
    });
    setError("");
    try {
      const installedAgent = await api.agentInstall(entry.id);
      if (disposed) return;
      commitInstalledMutation((currentAgents) =>
        upsertInstalled(currentAgents, installedAgent),
      );
      note(
        `${curatedAgent(entry.id)?.name || entry.name} installed. Choose it in the agent list to connect.`,
      );
    } catch (cause) {
      if (disposed) return;
      setInstallErrors((previous) => ({
        ...previous,
        [entry.id]: errorText(cause),
      }));
      fail(`Could not install ${entry.name}`, cause);
    } finally {
      if (!disposed)
        setInstallingIds((previous) =>
          previous.filter((installingId) => installingId !== entry.id),
        );
    }
  }
  async function disconnect() {
    const epoch = ++agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setMenu(null);
    setWorking(true);
    try {
      await api.agentDisconnect();
      if (!current()) return;
      setSessionId(undefined);
      setRunning(false);
      setStatus("disconnected");
      setStatusMessage("No agent connected");
      setActiveAgentId(undefined);
      note("Agent disconnected.");
    } catch (cause) {
      if (!current()) return;
      fail("Could not disconnect", cause);
    } finally {
      if (current()) setWorking(false);
    }
  }
  async function compose(text: string, selected: ReturnType<typeof selection>) {
    const files = await Promise.all(
      contextPaths().map((path) => api.openBuffer(path)),
    );
    const contexts = files.map((file) => `File: ${file.path}\n${file.text}`);
    if (selected)
      contexts.push(
        `Selected code from ${selected.path}${selected.startLine ? `, line ${selected.startLine}` : ""}:\n${selected.text}`,
      );
    return contexts.length
      ? `${text}\n\nEditor context:\n${contexts.join("\n\n")}`
      : text;
  }
  async function dispatch(text: string, message: string) {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    addItem({ id: ++nextId, kind: "user", text });
    setRunning(true);
    setStopRequested(false);
    setTurnStart(Date.now());
    setStatus("busy");
    setStatusMessage("Agent is working");
    setShowLogs(false);
    followLatest();
    try {
      await api.agentPrompt(message);
    } catch (cause) {
      if (!current()) return;
      setRunning(false);
      setStopRequested(false);
      if (sessionId()) {
        setStatus("ready");
        setStatusMessage("Prompt failed");
      }
      if (!prompt()) setPrompt(text);
      fail("Prompt failed", cause);
    }
  }
  async function send() {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    if (!canSend()) return;
    const text = prompt().trim();
    const selected = selection();
    setWorking(true);
    setError("");
    try {
      const message = await compose(text, selected);
      if (!current()) return;
      history = [text, ...history.filter((entry) => entry !== text)].slice(0, 50);
      historyIndex = -1;
      setPrompt("");
      if (running()) {
        setQueue((previous) => [...previous, { id: ++nextId, text, message }]);
        return;
      }
      void dispatch(text, message);
    } catch (cause) {
      if (!current()) return;
      fail("Prompt failed", cause);
    } finally {
      if (current()) setWorking(false);
    }
  }
  /** Queued steering messages go out together once the agent finishes or is stopped. */
  function drainQueue() {
    const waiting = queue();
    if (!waiting.length || running() || !connected()) return;
    setQueue([]);
    void dispatch(
      waiting.map((entry) => entry.text).join("\n\n"),
      waiting.map((entry) => entry.message).join("\n\n"),
    );
  }
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
  async function setConfig(option: ConfigOption, value: string) {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    if (value === option.currentValue) {
      setMenu(null);
      input?.focus();
      return;
    }
    setPendingAction(`config:${option.id}`);
    setError("");
    try {
      await api.agentSetConfig(option.id, value);
      if (!current()) return;
      setMenu(null);
      input?.focus();
    } catch (cause) {
      if (!current()) return;
      fail(`Could not change ${option.name}`, cause);
    } finally {
      if (current()) setPendingAction("");
    }
  }
  async function loadSessions() {
    if (!canList() || sessionsBusy()) return;
    const epoch = agentEpoch;
    setSessionsBusy(true);
    setSessionsError("");
    try {
      const found = await api.agentListSessions();
      if (epoch === agentEpoch && !disposed) setSessions(found);
    } catch (cause) {
      if (epoch === agentEpoch && !disposed) setSessionsError(errorText(cause));
    } finally {
      if (epoch === agentEpoch && !disposed) setSessionsBusy(false);
    }
  }
  async function switchChat(start: () => Promise<string>, failure: string) {
    const epoch = ++agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setMenu(null);
    setWorking(true);
    setError("");
    const previousFeed = feed();
    const previousSession = sessionId();
    setFeed([]);
    setQueue([]);
    setSessionId(undefined);
    setRunning(false);
    try {
      const id = await start();
      if (!current()) return;
      setSessionId(id);
      setStatus("ready");
      setStatusMessage("Connected and ready");
      followLatest();
      focusPrompt();
    } catch (cause) {
      if (!current()) return;
      setFeed(previousFeed);
      setSessionId(previousSession);
      fail(failure, cause);
    } finally {
      if (current()) setWorking(false);
    }
  }
  const newChat = () => switchChat(() => api.agentNewSession(), "Could not start a new chat");
  const resumeChat = (summary: SessionSummary) =>
    switchChat(
      () => api.agentResumeSession(summary.sessionId),
      "Could not resume that chat",
    );
  async function stop() {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    if (!running() || stopRequested()) return;
    setStopRequested(true);
    setStatusMessage("Waiting for cancellation");
    try {
      await api.agentCancel();
    } catch (cause) {
      if (!current()) return;
      setStopRequested(false);
      fail("Could not cancel the turn", cause);
    }
  }
  async function permission(event: Permission, optionId: string | null) {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setPendingAction(event.requestId);
    setError("");
    try {
      await api.agentPermission(event.requestId, optionId);
      if (!current()) return;
      setFeed((previous) =>
        previous.map((item) =>
          item.kind === "permission" && item.event.requestId === event.requestId
            ? { ...item, resolved: true }
            : item,
        ),
      );
    } catch (cause) {
      if (!current()) return;
      fail("Permission response failed", cause);
    } finally {
      if (current()) setPendingAction("");
    }
  }
  async function review(proposal: EditProposal, accept: boolean) {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    setPendingAction(proposal.id);
    setError("");
    try {
      const buffer = await api.agentReview(
        proposal.id,
        accept,
        proposal.baseRevision,
      );
      if (!current()) return;
      setFeed((previous) =>
        previous.map((item) =>
          item.kind === "proposal" && item.proposal.id === proposal.id
            ? { ...item, resolution: accept ? "accepted" : "rejected" }
            : item,
        ),
      );
      if (accept) props.onBufferChanged?.(buffer.path, buffer);
    } catch (cause) {
      if (!current()) return;
      fail("Edit review failed, the editor buffer may have changed", cause);
    } finally {
      if (current()) setPendingAction("");
    }
  }
  async function reviewHunks(proposalId: string, acceptedHunkIds: string[]) {
    const epoch = agentEpoch;
    const current = () => !disposed && epoch === agentEpoch;
    const proposal = unresolvedProposals().find(
      (candidate) => candidate.id === proposalId,
    );
    if (!proposal || pendingAction()) return;
    setPendingAction(proposal.id);
    setError("");
    try {
      const buffer = await api.agentReviewHunks(
        proposal.id,
        acceptedHunkIds,
        proposal.baseRevision,
      );
      if (!current()) return;
      const accepted = acceptedHunkIds.length > 0;
      setFeed((previous) =>
        previous.map((item) =>
          item.kind === "proposal" && item.proposal.id === proposal.id
            ? { ...item, resolution: accepted ? "accepted" : "rejected" }
            : item,
        ),
      );
      if (accepted) props.onBufferChanged?.(buffer.path, buffer);
    } catch (cause) {
      if (!current()) return;
      fail("Hunk review failed, the editor buffer may have changed", cause);
    } finally {
      if (current()) setPendingAction("");
    }
  }
  function addCurrentFile() {
    if (props.activePath)
      setContextPaths((previous) =>
        previous.includes(props.activePath!)
          ? previous
          : [...previous, props.activePath!],
      );
    setMenu(null);
    focusPrompt();
  }
  function commandAction(action: () => void) {
    if (prompt() === "/") setPrompt("");
    setMenu(null);
    action();
  }

  return (
    <section class="agent-panel" aria-label="AI Assistant">
      <header class="agent-header">
        <button
          class="agent-tab"
          role="tab"
          aria-selected={!showLogs()}
          onClick={() => setShowLogs(false)}
        >
          AI Assistant{" "}
          <span
            class="agent-dot"
            classList={{ ready: connected(), busy: running() }}
            aria-hidden="true"
          />
        </button>
        <button
          class="agent-icon-button"
          aria-label={connected() ? "New chat" : "Agent session options"}
          title={connected() ? "New chat" : "Agent sessions"}
          aria-haspopup={connected() ? undefined : "menu"}
          aria-expanded={connected() ? undefined : menu() === "session"}
          disabled={working()}
          onClick={() => (connected() ? void newChat() : openMenu("session"))}
        >
          <Icon name="Add" size={17} />
        </button>
        <span class="agent-header-spacer" />
        <button
          class="agent-log-tab"
          classList={{ active: showLogs() }}
          title="Inspect actual ACP traffic"
          aria-pressed={showLogs()}
          onClick={() => setShowLogs((value) => !value)}
        >
          ACP log
        </button>
      </header>
      <Show when={status() === "auth-required"}>
        <section class="agent-auth-panel" aria-label="Agent sign in">
          <div class="agent-auth-heading">
            <strong>Sign in to {agentName()}</strong>
            <span>{authMessage()}</span>
          </div>
          <Show when={authMethods().length === 0}>
            <p class="agent-auth-unavailable">
              This adapter has no login method Span can run.
            </p>
          </Show>
          <For each={authMethods()}>
            {(method) => (
              <button
                class="agent-auth-method"
                disabled={working()}
                onClick={() => void authenticate(method)}
              >
                <span class="agent-menu-copy">
                  <strong>{method.name}</strong>
                  <Show when={method.description}>
                    <small>{method.description}</small>
                  </Show>
                </span>
                <Show
                  when={authMethodBusy() === method.methodId}
                  fallback={<Icon name="arrow-right4" size={15} />}
                >
                  <span class="agent-auth-spinner" aria-label="Signing in" />
                </Show>
              </button>
            )}
          </For>
          <Show when={authError()}>
            <p class="agent-auth-error" role="alert">{authError()}</p>
          </Show>
          <div class="agent-auth-actions">
            <Show when={authError() && authRetryMethod()}>
              <button
                aria-label="Try again"
                disabled={working()}
                onClick={() => {
                  const method = authMethods().find(
                    (entry) => entry.methodId === authRetryMethod(),
                  );
                  if (method) void authenticate(method);
                }}
              >
                Try again
              </button>
            </Show>
            <button onClick={() => void cancelAuthentication()}>
              Cancel and disconnect
            </button>
          </div>
        </section>
      </Show>
      <Show when={error()}>
        <div class="agent-error" role="alert">
          <div class="agent-error-top">
            <span>{error()}</span>
            <button
              class="agent-icon-button"
              aria-label="Dismiss agent error"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        </div>
      </Show>
      <div
        class="agent-content"
        ref={content}
        onScroll={() => content && setPinned(isNearBottom(content))}
      >
        <Show
          when={showLogs()}
          fallback={
            <Show
              when={feed().length}
              fallback={
                <div class="agent-empty">
                  <span class="agent-logo" aria-hidden="true" />
                  <h2>AI Assistant</h2>
                  <p>
                    Ask a question or hand off a task. Select code in the editor
                    to bring it along as context.
                  </p>
                  <div class="agent-shortcuts">
                    <button class="agent-shortcut" onClick={focusPrompt}>
                      <span class="agent-keys" aria-hidden="true">
                        <kbd>⌘</kbd>
                        <kbd>.</kbd>
                      </span>
                      <span>
                        Ask agent{" "}
                        <span class="agent-muted">Editor &amp; Terminal</span>
                      </span>
                    </button>
                    <button
                      class="agent-shortcut"
                      onClick={() => openMenu("context")}
                    >
                      <span class="agent-keys" aria-hidden="true">
                        <kbd>⌥</kbd>
                        <kbd>↩</kbd>
                      </span>
                      <span>
                        Agent actions <span class="agent-muted">Editor</span>
                      </span>
                    </button>
                    <button
                      class="agent-shortcut"
                      onClick={() => openMenu("commands")}
                    >
                      <span class="agent-keys" aria-hidden="true">
                        <kbd>/</kbd>
                      </span>
                      <span>
                        Commands <span class="agent-muted">Chat</span>
                      </span>
                    </button>
                  </div>
                  <div class="agent-connection">
                    <span
                      class="agent-dot"
                      classList={{
                        ready: connected(),
                        connecting: working(),
                        error: status() === "error",
                      }}
                      aria-hidden="true"
                    />
                    <span>{statusMessage()}</span>
                    <button
                      class="agent-link"
                      onClick={() => openMenu("agent")}
                    >
                      {isDesktop ? "Configure" : "View agent settings"}
                    </button>
                  </div>
                </div>
              }
            >
              <div
                class="agent-feed"
                ref={setFeedElement}
                aria-live="polite"
                aria-relevant="additions text"
              >
                <For each={feed()}>
                  {(item) => (
                    <>
                      <Show
                        when={
                          item.kind === "user" ||
                          item.kind === "text" ||
                          item.kind === "thought" ||
                          item.kind === "note"
                        }
                      >
                        {(_match) => {
                          const message = item as Extract<
                            FeedItem,
                            { text: string }
                          >;
                          const rich =
                            message.kind === "text" ||
                            message.kind === "thought";
                          return (
                            <div class={`agent-message ${message.kind}`}>
                              {message.kind === "thought" && (
                                <div class="agent-message-label">Thinking</div>
                              )}
                              <Show when={rich} fallback={message.text}>
                                <AgentMarkdown
                                  text={message.text}
                                  workspaceRoot={props.workspacePath || ""}
                                  streaming={
                                    running() &&
                                    feed()[feed().length - 1]?.id === message.id
                                  }
                                  onOpenFile={props.onOpenFile}
                                  onOpenExternal={props.onOpenExternal}
                                />
                              </Show>
                            </div>
                          );
                        }}
                      </Show>
                      <Show when={item.kind === "plan"}>
                        {(_match) => {
                          const plan = item as Extract<
                            FeedItem,
                            { kind: "plan" }
                          >;
                          return (
                            <article class="agent-card">
                              <div class="agent-card-header">
                                <Icon name="TaskSquare" size={14} />
                                <span class="agent-card-title">Plan</span>
                              </div>
                              <ol class="agent-plan">
                                <For each={plan.event.entries}>
                                  {(entry) => (
                                    <li class={entry.status}>
                                      <span
                                        class="agent-plan-check"
                                        aria-label={entry.status.replaceAll(
                                          "_",
                                          " ",
                                        )}
                                      >
                                        {entry.status === "completed"
                                          ? "✓"
                                          : entry.status === "in_progress"
                                            ? "◉"
                                            : "○"}
                                      </span>
                                      <span>{entry.content}</span>
                                    </li>
                                  )}
                                </For>
                              </ol>
                            </article>
                          );
                        }}
                      </Show>
                      <Show
                        when={
                          item.kind === "tool" &&
                          !isNestedTool(feed(), item.event)
                        }
                      >
                        {(_match) => {
                          const tool = item as Extract<
                            FeedItem,
                            { kind: "tool" }
                          >;
                          return (
                            <AgentTool
                              tool={tool.event}
                              children={subagentChildren(
                                feed(),
                                tool.event.toolCallId,
                              )}
                            />
                          );
                        }}
                      </Show>
                      <Show when={item.kind === "permission"}>
                        {(_match) => {
                          const request = item as Extract<
                            FeedItem,
                            { kind: "permission" }
                          >;
                          const related = () => {
                            const found = toolFor(request.event.toolCallId);
                            return found?.kind === "tool"
                              ? toolSummary(found.event.contentJson)
                              : "";
                          };
                          return (
                            <AgentPermission
                              title={request.event.title}
                              summary={related()}
                              options={request.event.options}
                              resolved={request.resolved}
                              active={firstOpenPermission() === request.id}
                              busy={Boolean(pendingAction())}
                              onChoose={(optionId) =>
                                void permission(request.event, optionId)
                              }
                            />
                          );
                        }}
                      </Show>
                      <Show when={item.kind === "proposal"}>
                        {(_match) => {
                          const edit = item as Extract<
                            FeedItem,
                            { kind: "proposal" }
                          >;
                          return (
                            <article class="agent-card agent-proposal">
                              <div class="agent-card-header">
                                <Icon name="DocumentText" size={14} />
                                <span class="agent-card-title">
                                  Proposed edit
                                </span>
                                <span
                                  class={`agent-state ${edit.resolution || ""}`}
                                >
                                  {edit.resolution || "review required"}
                                </span>
                              </div>
                              <span class="agent-proposal-path">
                                {edit.proposal.path}
                              </span>
                              <div class="agent-proposal-summary">
                                {edit.proposal.hunks.length}{" "}
                                {edit.proposal.hunks.length === 1
                                  ? "hunk"
                                  : "hunks"}{" "}
                                · base revision {edit.proposal.baseRevision}
                              </div>
                              <For each={edit.proposal.hunks}>
                                {(hunk) => (
                                  <details open>
                                    <summary class="agent-card-body">
                                      {hunk.id} · {hunk.from}:{hunk.to}
                                    </summary>
                                    <pre class="agent-proposal-diff">
                                      <For each={hunk.before.split("\n")}>
                                        {(line) => (
                                          <div class="removed">- {line}</div>
                                        )}
                                      </For>
                                      <For each={hunk.after.split("\n")}>
                                        {(line) => (
                                          <div class="added">+ {line}</div>
                                        )}
                                      </For>
                                    </pre>
                                  </details>
                                )}
                              </For>
                              <Show when={!edit.resolution}>
                                <div class="agent-actions">
                                  <Show when={props.onReviewInEditor}>
                                    <button
                                      class="agent-action"
                                      onClick={() =>
                                        props.onReviewInEditor?.(
                                          edit.proposal.path,
                                        )
                                      }
                                    >
                                      Review in editor
                                    </button>
                                  </Show>
                                  <button
                                    class="agent-action primary"
                                    disabled={Boolean(pendingAction())}
                                    onClick={() =>
                                      void review(edit.proposal, true)
                                    }
                                  >
                                    Accept into editor
                                  </button>
                                  <button
                                    class="agent-action"
                                    disabled={Boolean(pendingAction())}
                                    onClick={() =>
                                      void review(edit.proposal, false)
                                    }
                                  >
                                    Reject edit
                                  </button>
                                </div>
                              </Show>
                              <div class="agent-unsaved-note">
                                {edit.resolution === "accepted"
                                  ? "Accepted in the editor. Use Save to write this file to disk."
                                  : edit.resolution === "rejected"
                                    ? "Rejected. This proposal did not change the file."
                                    : "Review the proposed hunks in the editor. Acceptance changes the editor buffer. Save is a separate action."}
                              </div>
                            </article>
                          );
                        }}
                      </Show>
                    </>
                  )}
                </For>
                <Show when={running()}>
                  <div class="agent-working" role="status">
                    <span class="agent-working-dots" aria-hidden="true" />
                    <span>
                      {stopRequested() ? "Stopping" : "Working"} ·{" "}
                      {formatElapsed(clock() - turnStart())}
                    </span>
                  </div>
                </Show>
              </div>
            </Show>
          }
        >
          <div class="agent-log-note">
            ACP traffic · latest {logs().length} of {logCount()} lines · up to
            6,000 characters per line
          </div>
          <Show
            when={logs().length}
            fallback={
              <div class="agent-log-empty">
                No ACP traffic recorded.{" "}
                {isDesktop
                  ? "Connect an agent to inspect its protocol messages."
                  : "A native agent connection is unavailable in browser preview."}
              </div>
            }
          >
            <pre class="agent-logs">{logs().join("\n")}</pre>
          </Show>
        </Show>
      </div>
      <Show when={!pinned() && (feed().length > 0 || showLogs())}>
        <button
          class="agent-jump"
          aria-label="Jump to latest message"
          onClick={followLatest}
        >
          <Icon name="arrow-down4" size={11} />
          {running() ? "New activity" : "Latest"}
        </button>
      </Show>
      <footer class="agent-footer">
        <div
          class="agent-composer"
          onKeyDown={(event) => {
            if (event.key === "Escape" && menu()) {
              event.stopPropagation();
              setMenu(null);
            }
          }}
        >
          <Show when={menu()}>
            <button
              class="agent-menu-dismiss"
              aria-label="Close agent menu"
              tabindex="-1"
              onClick={() => setMenu(null)}
            />
            <div
              class="agent-menu"
              ref={menuElement}
              onKeyDown={menuKeyboard}
              role="dialog"
              aria-label={`${menu()} options`}
            >
              <Show when={menu() === "agent"}>
                <div class="agent-menu-heading">
                  <span>Agents</span>
                  <button
                    class="agent-icon-button"
                    aria-label="Refresh agent registry"
                    disabled={registryBusy()}
                    onClick={() => void loadAgents()}
                  >
                    <Icon name="Refresh" size={14} />
                  </button>
                </div>
                <label class="agent-catalog-search">
                  <Icon name="SearchNormal1" size={14} />
                  <span class="agent-sr-only">Search curated agents</span>
                  <input
                    placeholder="Search agents"
                    value={catalogSearch()}
                    onInput={(event) =>
                      setCatalogSearch(event.currentTarget.value)
                    }
                  />
                </label>
                <Show when={!isDesktop}>
                  <div class="agent-menu-note">
                    Open span desktop to install or connect an ACP agent.
                  </div>
                </Show>
                <Show
                  when={catalogRows().length}
                  fallback={
                    <div class="agent-menu-note">
                      No curated agents match this search.
                    </div>
                  }
                >
                  <For each={catalogRows()}>
                    {(row) => (
                      <div
                        class="agent-catalog-entry"
                        aria-busy={installingIds().includes(row.definition.id)}
                      >
                        <button
                          class="agent-menu-item agent-catalog-row"
                          classList={{
                            "is-installing": installingIds().includes(
                              row.definition.id,
                            ),
                          }}
                          disabled={
                            !isDesktop ||
                            (row.action === "connect" && working()) ||
                            (row.action === "local" && working()) ||
                            (row.action === "install" &&
                              installingIds().includes(row.definition.id)) ||
                            row.action === "unavailable"
                          }
                          onClick={() => pickCatalog(row)}
                        >
                          <Show
                            when={row.definition.brand === "glm"}
                            fallback={
                              <BrandIcon id={row.definition.brand} size={20} />
                            }
                          >
                            <span class="agent-glm-mark" aria-hidden="true" />
                          </Show>
                          <span class="agent-menu-copy">
                            <strong>{row.definition.name}</strong>
                            <small>
                              {row.installed
                                ? `Installed · ${row.installed.version}`
                                : installErrors()[row.definition.id]
                                  ? "Installation failed. Retry."
                                  : row.definition.detail}
                            </small>
                            <Show when={installErrors()[row.definition.id]}>
                              {(message) => (
                                <small
                                  class="agent-install-error"
                                  role="status"
                                  title={message()}
                                >
                                  {message()}
                                </small>
                              )}
                            </Show>
                          </span>
                          <span class="agent-menu-trailing">
                            {installingIds().includes(row.definition.id) ? (
                              <span class="agent-install-progress" role="status">
                                <span
                                  class="agent-install-spinner"
                                  aria-hidden="true"
                                />
                                <span>Installing…</span>
                              </span>
                            ) : row.action === "connect" ? (
                              <Icon name="arrow-right4" size={16} />
                            ) : row.action === "install" ? (
                              <span class="agent-install-action">
                                <MenuIcon name="install" size={14} />
                                {installErrors()[row.definition.id]
                                  ? "Retry"
                                  : "Install"}
                              </span>
                            ) : row.action === "local" ? (
                              "Use local CLI"
                            ) : registryBusy() ? (
                              "Loading"
                            ) : (
                              "Unavailable"
                            )}
                          </span>
                        </button>
                        <Show
                          when={props.removeAgent ? row.installed : undefined}
                        >
                          {(entry) => (
                            <>
                              <button
                                class="agent-row-overflow"
                                aria-label={`Manage ${row.definition.name}`}
                                aria-expanded={
                                  managementId() === row.definition.id
                                }
                                onClick={() =>
                                  setManagementId((value) =>
                                    value === row.definition.id
                                      ? undefined
                                      : row.definition.id,
                                  )
                                }
                              >
                                ···
                              </button>
                              <Show when={managementId() === row.definition.id}>
                                <div class="agent-row-management">
                                  <button
                                    onClick={() =>
                                      requestRemoval(entry(), false)
                                    }
                                  >
                                    <Icon name="CloseCircle" size={14} />
                                    Remove from Span
                                  </button>
                                  <button
                                    onClick={() =>
                                      requestRemoval(entry(), true)
                                    }
                                  >
                                    <MenuIcon name="trash" size={14} />
                                    Uninstall managed adapter
                                  </button>
                                </div>
                              </Show>
                            </>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={registryBusy()}>
                  <div class="agent-menu-note" role="status">
                    Loading verified registry metadata…
                  </div>
                </Show>
                <div class="agent-menu-divider" />
                <button
                  class="agent-menu-item agent-catalog-row"
                  onClick={() => setMenu("custom")}
                >
                  <Icon name="Code1" size={20} />
                  <span class="agent-menu-copy">
                    <strong>Custom ACP command</strong>
                    <small>Advanced · use a local ACP executable</small>
                  </span>
                  <Icon name="arrow-right4" size={16} />
                </button>
                <Show when={otherInstalled().length}>
                  <details class="agent-other-installed">
                    <summary>
                      Other installed adapters ({otherInstalled().length})
                    </summary>
                    <div class="agent-menu-note">
                      Kept on this device. These adapters are outside the
                      curated list.
                    </div>
                    <For each={otherInstalled()}>
                      {(entry) => (
                        <div class="agent-other-row">
                          <span class="agent-menu-copy">
                            <strong>{entry.id}</strong>
                            <small>Managed adapter · {entry.version}</small>
                          </span>
                          <Show when={props.removeAgent}>
                            <button
                              class="agent-icon-button"
                              aria-label={`Manage ${entry.id}`}
                              onClick={() =>
                                setManagementId((value) =>
                                  value === entry.id ? undefined : entry.id,
                                )
                              }
                            >
                              ···
                            </button>
                          </Show>
                          <Show when={managementId() === entry.id}>
                            <div class="agent-row-management">
                              <button
                                onClick={() => requestRemoval(entry, false)}
                              >
                                <Icon name="CloseCircle" size={14} />
                                Remove from Span
                              </button>
                              <button
                                onClick={() => requestRemoval(entry, true)}
                              >
                                <MenuIcon name="trash" size={14} />
                                Uninstall managed adapter
                              </button>
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </details>
                </Show>
                <Show when={props.onOpenSettings}>
                  <button
                    class="agent-menu-item agent-settings-link"
                    onClick={() => {
                      setMenu(null);
                      props.onOpenSettings?.();
                    }}
                  >
                    <Icon name="Setting2" size={16} />
                    <span class="agent-menu-copy">Open settings</span>
                  </button>
                </Show>
              </Show>
              <Show when={menu() === "remove" && removal()}>
                {(choice) => (
                  <div class="agent-removal-confirmation">
                    <h3>
                      {choice().uninstall
                        ? "Uninstall managed adapter?"
                        : "Remove agent from Span?"}
                    </h3>
                    <p>
                      {curatedAgent(choice().entry.id)?.name ||
                        choice().entry.id}
                    </p>
                    <p>
                      {choice().uninstall
                        ? "Deletes only this adapter's files managed by Span. Your separate CLI installation, account and project files are kept."
                        : "Removes this adapter from Span's installed list. Its managed files stay on this device."}
                    </p>
                    <Show
                      when={
                        activeAgentId() === choice().entry.id && sessionId()
                      }
                    >
                      <p>The connected session will disconnect first.</p>
                    </Show>
                    <Show when={removalBlock()}>
                      <p class="agent-removal-block" role="status">
                        {removalBlock()}
                      </p>
                    </Show>
                    <div class="agent-actions">
                      <button
                        class="agent-action"
                        disabled={working()}
                        onClick={() => {
                          setRemoval(undefined);
                          setMenu("agent");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        class="agent-action danger"
                        disabled={working() || Boolean(removalBlock())}
                        onClick={() => void confirmRemoval()}
                      >
                        {working()
                          ? "Removing…"
                          : choice().uninstall
                            ? "Uninstall adapter"
                            : "Remove from Span"}
                      </button>
                    </div>
                  </div>
                )}
              </Show>
              <Show when={menu() === "custom"}>
                <div class="agent-menu-title">Custom ACP agent</div>
                <form
                  class="agent-custom-form"
                  onSubmit={(event) => void connectCustom(event)}
                >
                  <label>
                    Executable
                    <input
                      value={executable()}
                      onInput={(event) =>
                        setExecutable(event.currentTarget.value)
                      }
                      placeholder="/path/to/agent"
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </label>
                  <label>
                    Arguments (JSON array)
                    <input
                      value={argumentsJson()}
                      onInput={(event) =>
                        setArgumentsJson(event.currentTarget.value)
                      }
                      placeholder={'["--stdio"]'}
                      spellcheck={false}
                    />
                  </label>
                  <p>
                    Starts a local process in{" "}
                    {props.workspacePath || "the workspace folder"}. Agents run
                    with your operating system user's access. Span does not
                    sandbox their tools.
                  </p>
                  <Show when={!isDesktop}>
                    <p>
                      Connection is unavailable in browser preview. These fields
                      show the desktop connection configuration.
                    </p>
                  </Show>
                  <div class="agent-actions">
                    <button
                      class="agent-action primary"
                      type="submit"
                      disabled={!isDesktop || working() || !props.workspacePath}
                    >
                      {working() ? "Connecting…" : "Connect agent"}
                    </button>
                    <button
                      class="agent-action"
                      type="button"
                      onClick={() => setMenu("agent")}
                    >
                      Back to agents
                    </button>
                  </div>
                </form>
              </Show>
              <Show when={menu() === "session"}>
                <div class="agent-menu-title">Agent session</div>
                <div class="agent-menu-note">
                  {sessionId()
                    ? `Connected: ${agentName()}\nSession ${sessionId()}`
                    : "No active agent session"}
                </div>
                <Show when={connected()}>
                  <button
                    class="agent-menu-item"
                    disabled={working() || running()}
                    onClick={() => void newChat()}
                  >
                    <Icon name="Add" size={15} />
                    <span>
                      <strong>New chat</strong>
                      <small>Keeps the same agent connection</small>
                    </span>
                  </button>
                </Show>
                <button
                  class="agent-menu-item"
                  disabled={working()}
                  onClick={() => {
                    setMenu("agent");
                    if (!registryLoaded()) void loadAgents();
                  }}
                >
                  <Icon name="Add" size={15} />
                  <span>
                    {sessionId() ? "Connect another agent" : "Start a session"}
                  </span>
                </button>
                <Show when={connected()}>
                  <div class="agent-menu-divider" />
                  <div class="agent-menu-title">Recent chats</div>
                  <Show
                    when={canList()}
                    fallback={
                      <div class="agent-menu-note">
                        {agentName()} does not list earlier chats.
                      </div>
                    }
                  >
                    <Show when={sessionsError()}>
                      <div class="agent-menu-note">{sessionsError()}</div>
                    </Show>
                    <Show when={sessionsBusy() && !sessions().length}>
                      <div class="agent-menu-note">Loading chats…</div>
                    </Show>
                    <Show
                      when={
                        !sessionsBusy() &&
                        !sessionsError() &&
                        !sessions().length
                      }
                    >
                      <div class="agent-menu-note">
                        No earlier chats in this folder.
                      </div>
                    </Show>
                    <For each={sessions()}>
                      {(entry) => (
                        <button
                          class="agent-menu-item"
                          disabled={
                            working() ||
                            running() ||
                            !canLoad() ||
                            entry.sessionId === sessionId()
                          }
                          title={
                            canLoad()
                              ? entry.sessionId
                              : `${agentName()} cannot restore chats`
                          }
                          onClick={() => void resumeChat(entry)}
                        >
                          <span>
                            <strong>{entry.title || "Untitled chat"}</strong>
                            <small>
                              {entry.sessionId === sessionId()
                                ? "Current chat"
                                : relativeTime(entry.updatedAt) ||
                                  entry.sessionId.slice(0, 8)}
                            </small>
                          </span>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
                <Show when={sessionId()}>
                  <button
                    class="agent-menu-item"
                    disabled={working()}
                    onClick={() => void disconnect()}
                  >
                    <span>Disconnect session</span>
                  </button>
                </Show>
                <button
                  class="agent-menu-item"
                  onClick={() => {
                    setShowLogs(true);
                    setMenu(null);
                  }}
                >
                  <span>Inspect ACP log</span>
                </button>
              </Show>
              <Show when={menu() === "context"}>
                <div class="agent-menu-title">Editor context</div>
                <button
                  class="agent-menu-item"
                  disabled={!props.activePath}
                  onClick={addCurrentFile}
                >
                  <Show when={props.activePath}>
                    <FileIcon path={props.activePath!} />
                  </Show>
                  <span>
                    <strong>Add current file</strong>
                    <small>
                      {props.activePath || "Open a file in the editor first"}
                    </small>
                  </span>
                </button>
                <div class="agent-menu-note">
                  Selected code is included automatically. Added files use the
                  current editor buffer, including unsaved changes.
                </div>
              </Show>
              <Show when={menu() === "config"}>
                <For
                  each={configOptions().filter(
                    (option) => option.id === configMenuId(),
                  )}
                >
                  {(option) => (
                    <>
                      <div class="agent-menu-title">{option.name}</div>
                      <Show when={option.description}>
                        <div class="agent-menu-note">{option.description}</div>
                      </Show>
                      <For each={option.groups}>
                        {(group) => (
                          <>
                            <Show when={group.name}>
                              <div class="agent-menu-title">{group.name}</div>
                            </Show>
                            <For each={group.choices}>
                              {(choice) => (
                                <button
                                  class="agent-menu-item"
                                  role="menuitemradio"
                                  aria-checked={
                                    choice.value === option.currentValue
                                  }
                                  disabled={Boolean(pendingAction())}
                                  onClick={() =>
                                    void setConfig(option, choice.value)
                                  }
                                >
                                  <span>
                                    <strong>{choice.name}</strong>
                                    <Show when={choice.description}>
                                      <small>{choice.description}</small>
                                    </Show>
                                  </span>
                                  <Show
                                    when={choice.value === option.currentValue}
                                  >
                                    <span class="agent-check" aria-hidden="true">
                                      ✓
                                    </span>
                                  </Show>
                                </button>
                              )}
                            </For>
                          </>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
              <Show when={menu() === "commands"}>
                <div class="agent-menu-title">Assistant commands</div>
                <Show when={connected()}>
                  <button
                    class="agent-menu-item"
                    disabled={running()}
                    onClick={() => commandAction(() => void newChat())}
                  >
                    <span>
                      <strong>New chat</strong>
                      <small>Start a fresh conversation with this agent</small>
                    </span>
                  </button>
                  <button
                    class="agent-menu-item"
                    onClick={() =>
                      commandAction(() => {
                        setMenu("session");
                        if (canList()) void loadSessions();
                      })
                    }
                  >
                    <span>
                      <strong>Resume chat</strong>
                      <small>Pick up an earlier conversation</small>
                    </span>
                  </button>
                </Show>
                <button
                  class="agent-menu-item"
                  onClick={() =>
                    commandAction(() => {
                      setMenu("agent");
                      if (!registryLoaded()) void loadAgents();
                    })
                  }
                >
                  <span>
                    <strong>Connect agent</strong>
                    <small>Choose an installed agent or custom command</small>
                  </span>
                </button>
                <button
                  class="agent-menu-item"
                  onClick={() => commandAction(addCurrentFile)}
                  disabled={!props.activePath}
                >
                  <span>
                    <strong>Add current file</strong>
                    <small>Include its current buffer in the next prompt</small>
                  </span>
                </button>
                <button
                  class="agent-menu-item"
                  onClick={() => commandAction(() => setShowLogs(true))}
                >
                  <span>
                    <strong>Show ACP log</strong>
                    <small>Inspect actual protocol traffic</small>
                  </span>
                </button>
              </Show>
            </div>
          </Show>
          <Show when={selection() || contextPaths().length}>
            <div class="agent-contexts">
              <Show when={selection()}>
                {(selected) => (
                  <span class="agent-context-chip live" title={selected().path}>
                    <FileIcon path={selected().path} />
                    <span>{leaf(selected().path)} · selection</span>
                    <button
                      aria-label="Remove selected code from context"
                      onClick={() => setHiddenSelection(selectionKey())}
                    >
                      ×
                    </button>
                  </span>
                )}
              </Show>
              <For each={contextPaths()}>
                {(path) => (
                  <span class="agent-context-chip" title={path}>
                    <FileIcon path={path} />
                    <span>{leaf(path)}</span>
                    <button
                      aria-label={`Remove ${path} from context`}
                      onClick={() =>
                        setContextPaths((paths) =>
                          paths.filter((value) => value !== path),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={queue().length}>
            <div class="agent-queue" aria-label="Queued follow-ups">
              <For each={queue()}>
                {(entry) => (
                  <span class="agent-context-chip queued" title={entry.text}>
                    <span>Queued: {entry.text.slice(0, 60)}</span>
                    <button
                      aria-label="Remove queued message"
                      onClick={() =>
                        setQueue((previous) =>
                          previous.filter((value) => value.id !== entry.id),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                )}
              </For>
              <Show when={running()}>
                <button
                  class="agent-link"
                  disabled={stopRequested()}
                  onClick={() => void stop()}
                >
                  Stop and send now
                </button>
              </Show>
            </div>
          </Show>
          <label class="agent-sr-only" for="agent-prompt">
            Message to agent
          </label>
          <textarea
            id="agent-prompt"
            ref={input}
            class="agent-input"
            rows="2"
            value={prompt()}
            placeholder={
              running() ? "Queue a follow-up for after this turn…" : "Ask AI Assistant…"
            }
            spellcheck={false}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            onKeyDown={(event) => {
              recallPrompt(event);
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.isComposing
              ) {
                event.preventDefault();
                if (event.altKey) openMenu("context");
                else void send();
              }
            }}
          />
          <div
            class="agent-composer-toolbar"
            role="toolbar"
            aria-label="Agent prompt options"
          >
            <button
              class="agent-composer-button context"
              title="Add context"
              aria-label="Add editor context"
              aria-expanded={menu() === "context"}
              onClick={() => openMenu("context")}
            >
              <Icon name="Add" size={16} />
            </button>
            <button
              class="agent-composer-button"
              aria-haspopup="dialog"
              aria-expanded={menu() === "agent" || menu() === "custom"}
              onClick={() => openMenu("agent")}
            >
              <span class="agent-agent-logo">
                <BrandIcon name={agentName()} size={17} />
                <span
                  class="agent-dot"
                  classList={{
                    ready: connected(),
                    busy: running(),
                    connecting: working(),
                  }}
                />
              </span>
              <span class="agent-name">{agentName()}</span>
              <Icon name="arrow-down4" size={10} />
            </button>
            <button
              class="agent-composer-button session"
              aria-label="Session options"
              aria-expanded={menu() === "session"}
              onClick={() => openMenu("session")}
            >
              Session
              <Icon name="arrow-down4" size={10} />
            </button>
            <For each={configOptions().slice(0, 3)}>
              {(option) => (
                <button
                  class="agent-composer-button config"
                  title={option.description || option.name}
                  aria-label={`${option.name}: ${choiceName(option)}`}
                  aria-haspopup="menu"
                  aria-expanded={
                    menu() === "config" && configMenuId() === option.id
                  }
                  disabled={Boolean(pendingAction())}
                  onClick={() => toggleConfig(option)}
                >
                  <span class="agent-config-name">{choiceName(option)}</span>
                  <Icon name="arrow-down4" size={10} />
                </button>
              )}
            </For>
            <span class="agent-toolbar-spacer" />
            <button
              class="agent-send"
              aria-label={running() ? "Queue follow-up" : "Send prompt"}
              title={
                !connected()
                  ? "Connect an agent to send"
                  : running()
                    ? "Queue for after this turn · Enter"
                    : "Send · Enter"
              }
              disabled={!canSend()}
              onClick={() => void send()}
            >
              <Icon name="u-send" size={18} />
            </button>
            <Show when={running()}>
              <button
                class="agent-send stop"
                aria-label="Stop agent"
                disabled={stopRequested()}
                title={
                  stopRequested() ? "Waiting for cancellation" : "Stop · Esc"
                }
                onClick={() => void stop()}
              >
                <Icon name="Stop" size={16} />
              </button>
            </Show>
          </div>
        </div>
        <div class="agent-composer-hint">
          <span>
            {isDesktop
              ? connected()
                ? statusMessage()
                : "Connect an ACP agent to begin"
              : "Browser preview · agent unavailable"}
          </span>
          <span>
            {running() ? "↵ queue · Esc stop" : "↵ send · ⇧↵ newline · ↑ history"}
          </span>
        </div>
      </footer>
    </section>
  );
}
export default AgentPanel;
