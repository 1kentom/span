import { createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
  CapabilitiesDto, DiagnosticsPublished_Deserialize, LanguageServerId, LanguageServerInstallProgress_Deserialize,
  LanguageServerStateDto_Deserialize, LocationDto, LspErrorDto, ServerStatusDto_Serialize,
} from "../bindings";
import { createLspSession, describeLspError, runtimeMissingMessage, serverForBuffer, serverLabels, type LspPort } from "../lib/lsp-client";
import type { LspBinding } from "../lib/lsp-codemirror";

export type BufferLspState =
  | { kind: "unsupported" }
  | { kind: "unknown"; server: LanguageServerId }
  | { kind: "disabled"; server: LanguageServerId }
  | { kind: "idle"; server: LanguageServerId }
  | { kind: "starting"; server: LanguageServerId }
  | { kind: "installing"; server: LanguageServerId; phase?: string; received?: number | null; total?: number | null }
  | { kind: "ready"; server: LanguageServerId; capabilities?: CapabilitiesDto | null }
  | { kind: "needs-install"; server: LanguageServerId; version: string; sizeHint?: number | null }
  | { kind: "install-failed"; server: LanguageServerId; reason: string; retryable: boolean }
  | { kind: "start-failed"; server: LanguageServerId; reason: string }
  | { kind: "runtime-missing"; server: LanguageServerId; runtime: string; requiredVersion: number; found: string[] }
  | { kind: "crashed"; server: LanguageServerId };

export interface ServerEntry {
  server: LanguageServerId;
  root: string | null;
  state: LanguageServerStateDto_Deserialize;
  installed: boolean;
  enabled: boolean;
  version: string;
  epoch: number;
  capabilities?: CapabilitiesDto | null;
}

export interface InstallProgress { phase: string; received?: number | null; total?: number | null; message?: string | null }

/** Maps one server state, plus any live install progress, to what a buffer should show. */
export function deriveBufferState(server: LanguageServerId, entry: Pick<ServerEntry, "state" | "capabilities" | "enabled"> | undefined, progress?: InstallProgress): BufferLspState {
  if (!entry) return { kind: "unknown", server };
  if (!entry.enabled) return { kind: "disabled", server };
  const state = entry.state;
  switch (state.kind) {
    case "disabled": return { kind: "disabled", server };
    case "notStarted":
    case "stopped": return { kind: "idle", server };
    case "starting": return { kind: "starting", server };
    case "installing": return { kind: "installing", server, phase: progress?.phase, received: progress?.received, total: progress?.total };
    case "ready": return { kind: "ready", server, capabilities: entry.capabilities };
    case "needsInstall": return { kind: "needs-install", server, version: state.version, sizeHint: state.sizeHint };
    case "installFailed": return { kind: "install-failed", server, reason: state.reason, retryable: state.retryable };
    case "startFailed": return { kind: "start-failed", server, reason: state.reason };
    case "runtimeMissing": return { kind: "runtime-missing", server, runtime: state.runtime, requiredVersion: state.requiredVersion, found: state.found };
    case "crashed": return { kind: "crashed", server };
  }
}

/** Maps a failed command to the state it implies. Stale, cancelled and unrelated failures imply none. */
export function deriveFromError(error: LspErrorDto, fallbackServer?: LanguageServerId): BufferLspState | undefined {
  switch (error.kind) {
    case "unsupported": return { kind: "unsupported" };
    case "notReady": return fallbackServer ? (/install/i.test(error.message) ? { kind: "installing", server: fallbackServer } : { kind: "starting", server: fallbackServer }) : undefined;
    case "needsInstall": return { kind: "needs-install", server: error.server, version: error.version, sizeHint: error.sizeHint };
    case "installFailed": return { kind: "install-failed", server: error.server, reason: error.reason, retryable: error.retryable };
    case "startFailed": return { kind: "start-failed", server: error.server, reason: error.reason };
    case "runtimeMissing": return { kind: "runtime-missing", server: error.server, runtime: error.runtime, requiredVersion: error.requiredVersion, found: error.found };
    case "serverCrashed": return fallbackServer ? { kind: "crashed", server: fallbackServer } : undefined;
    case "cancelled":
    case "stale":
    case "other": return undefined;
  }
}

export const stateLabels: Record<BufferLspState["kind"], string> = {
  unsupported: "No language server", unknown: "Checking", disabled: "Off", idle: "Idle", starting: "Starting", installing: "Installing",
  ready: "Ready", "needs-install": "Not installed", "install-failed": "Install failed", "start-failed": "Failed to start",
  "runtime-missing": "Runtime missing", crashed: "Stopped unexpectedly",
};

/** One sentence for the popover and tooltip. */
export function describeBufferState(state: BufferLspState): string {
  switch (state.kind) {
    case "unsupported": return "No language server handles this file type.";
    case "unknown": return `Checking ${serverLabels[state.server]}.`;
    case "disabled": return `${serverLabels[state.server]} is turned off in settings.`;
    case "idle": return `${serverLabels[state.server]} starts when a file is opened.`;
    case "starting": return `${serverLabels[state.server]} is starting.`;
    case "installing": return `Installing ${serverLabels[state.server]}${state.total ? ` (${Math.round(((state.received ?? 0) / state.total) * 100)}%)` : ""}.`;
    case "ready": return `${serverLabels[state.server]} is running.`;
    case "needs-install": return `${serverLabels[state.server]} ${state.version} is not installed.`;
    case "install-failed": return `Installing ${serverLabels[state.server]} failed: ${state.reason}`;
    case "start-failed": return `${serverLabels[state.server]} did not start: ${state.reason}`;
    case "runtime-missing": return runtimeMissingMessage(state.server, state.runtime, state.requiredVersion, state.found);
    case "crashed": return `${serverLabels[state.server]} stopped unexpectedly.`;
  }
}

export function sizeHintLabel(bytes: number | null | undefined): string | undefined {
  if (!bytes || bytes <= 0) return undefined;
  return `about ${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export interface LanguageServers {
  entries: Record<string, ServerEntry[]>;
  /** True once the first status load finished. */
  loaded: Accessor<boolean>;
  /** Last background failure (events, commands, status fetch) that has not been cleared by a success. */
  error: Accessor<string>;
  /** The error when it concerns this server or no server in particular, else an empty string. */
  errorFor: (server: LanguageServerId) => string;
  /** Set while the latest `lsp_status` call failed. Cleared by the next success. */
  statusError: Accessor<string>;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  dispose: () => void;
  install: (server: LanguageServerId) => Promise<void>;
  restart: (server: LanguageServerId) => Promise<void>;
  retry: (server: LanguageServerId) => Promise<void>;
  entryFor: (server: LanguageServerId, absolutePath?: string) => ServerEntry | undefined;
  bufferState: (path: string, workspaceRoot?: string) => BufferLspState;
  progress: (server: LanguageServerId) => InstallProgress | undefined;
  binding: (path: string, context: BindingContext) => LspBinding | undefined;
  /** Remembers the state implied by a failed command until the next status change. */
  noteError: (path: string, error: LspErrorDto) => void;
  onDiagnostics: (listener: (event: DiagnosticsPublished_Deserialize) => void) => () => void;
  /** Listener fires for a restart or stop of the server. `root` names the project folder the listener's file belongs to. */
  onReset: (server: LanguageServerId, listener: () => void, root?: () => string | null | undefined) => () => void;
  /** Latest diagnostics published for a path, kept so a new view of the file can replay them. */
  latestDiagnostics: (path: string) => DiagnosticsPublished_Deserialize | undefined;
  /** Drops cached diagnostics for paths `keep` rejects, or all of them when called without an argument. */
  pruneDiagnostics: (keep?: (path: string) => boolean) => void;
}

export interface LanguageServersOptions {
  /** Called for every new background failure so the app can show a toast. */
  onError?: (message: string) => void;
}

const MAX_CACHED_DIAGNOSTICS = 200;
const failureKinds: ReadonlySet<BufferLspState["kind"]> = new Set(["install-failed", "start-failed", "runtime-missing", "crashed", "needs-install"]);

export interface BindingContext {
  workspaceRoot: () => string | undefined;
  getRevision: () => number;
  isSynchronized: () => boolean;
  isActive: () => boolean;
  getWorkspaceGeneration: () => number;
  openLocation: (location: LocationDto) => void;
  notify: (message: string) => void;
}

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Status of every language server, fed by `lsp_status` and the backend events. It is a plain
 * module so tests can drive it with a fixture port. Call `init` once and `dispose` to unsubscribe.
 */
export function createLanguageServers(port: LspPort, options: LanguageServersOptions = {}): LanguageServers {
  const [entries, setEntries] = createStore<Record<string, ServerEntry[]>>({});
  const [progress, setProgress] = createStore<Record<string, InstallProgress | undefined>>({});
  const [bufferErrors, setBufferErrors] = createStore<Record<string, BufferLspState | undefined>>({});
  const [loaded, setLoaded] = createSignal(false);
  const [error, setErrorText] = createSignal("");
  const [errorServer, setErrorServer] = createSignal<LanguageServerId | undefined>();
  const [statusError, setStatusError] = createSignal("");
  const diagnosticListeners = new Set<(event: DiagnosticsPublished_Deserialize) => void>();
  interface ResetListener { listener: () => void; root?: () => string | null | undefined }
  const resetListeners = new Map<LanguageServerId, Set<ResetListener>>();
  const diagnosticsCache = new Map<string, DiagnosticsPublished_Deserialize>();
  /** Reports a background failure: remembered for the popover and forwarded for the toast. */
  const fail = (message: string, server?: LanguageServerId) => {
    setErrorServer(server); setErrorText(message);
    if (message) { try { options.onError?.(message); } catch { /* a toast failure must not break the store */ } }
  };
  const clearError = () => { setErrorServer(undefined); setErrorText(""); };
  const stops: (() => void)[] = [];
  let initialized: Promise<void> | undefined;
  let disposed = false;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  /**
   * Resets the views served by one project folder of a server. A listener whose folder is unknown
   * is reset too, because it may belong to the folder. Other folders keep their diagnostics.
   */
  const fireReset = (server: LanguageServerId, root?: string | null) => {
    for (const item of [...(resetListeners.get(server) ?? [])]) {
      const own = item.root?.();
      if (root != null && own != null && own !== root) continue;
      try { item.listener(); } catch { /* a listener must not break the store */ }
    }
  };
  const dropHints = (server: LanguageServerId) => {
    for (const path of Object.keys(bufferErrors)) if (serverForBuffer(path) === server) setBufferErrors(path, undefined);
  };
  const dropCachedDiagnostics = (server: LanguageServerId) => {
    for (const path of [...diagnosticsCache.keys()]) if (serverForBuffer(path) === server) diagnosticsCache.delete(path);
  };

  function applyStatus(rows: ServerStatusDto_Serialize[]) {
    const next: Record<string, ServerEntry[]> = {};
    for (const row of rows) {
      (next[row.server] ??= []).push({ server: row.server, root: row.root, state: row.state, installed: row.installed, enabled: row.enabled, version: row.version, epoch: row.epoch, capabilities: row.capabilities });
    }
    const restarted: { server: LanguageServerId; root: string | null }[] = [];
    for (const [server, list] of Object.entries(next)) {
      for (const row of list) {
        const before = entries[server]?.find(item => item.root === row.root)?.epoch;
        if (before !== undefined && before !== row.epoch) restarted.push({ server: server as LanguageServerId, root: row.root });
      }
    }
    setEntries(reconcile(next, { merge: false }));
    for (const { server, root } of restarted) { dropHints(server); dropCachedDiagnostics(server); fireReset(server, root); }
  }

  function refresh(): Promise<void> {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const rows = await port.status();
          if (!disposed) { applyStatus(rows); if (statusError()) clearError(); setStatusError(""); setLoaded(true); }
        } while (refreshAgain && !disposed);
      } catch (cause) {
        if (!disposed) {
          const message = `Could not read language server status: ${errorText(cause)}`;
          setStatusError(message); fail(message); setLoaded(true);
        }
      } finally { refreshing = undefined; }
    })();
    return refreshing;
  }

  async function subscribe<T>(listen: (listener: (event: T) => void) => Promise<() => void>, listener: (event: T) => void) {
    try {
      const stop = await listen(listener);
      if (disposed) stop(); else stops.push(stop);
    } catch (cause) { fail(errorText(cause)); }
  }

  function init(): Promise<void> {
    if (initialized) return initialized;
    initialized = (async () => {
      await Promise.all([
        subscribe(port.onState, event => {
          const rows = entries[event.server];
          if (rows) {
            // An event for a folder the status list has not seen yet only describes a row that has no folder. The refresh below adds the new folder.
            const exact = rows.some(row => row.root === event.root);
            rows.forEach((row, index) => { if (exact ? row.root === event.root : row.root === null) setEntries(event.server, index, "state", event.state); });
          }
          if (event.state.kind !== "installing") setProgress(event.server, undefined);
          if (event.state.kind !== "ready") { dropHints(event.server); dropCachedDiagnostics(event.server); fireReset(event.server, event.root); }
          void refresh();
        }),
        subscribe(port.onInstallProgress, event => handleProgress(event)),
        subscribe(port.onError, event => fail(`${serverLabels[event.server]}: ${event.message}`, event.server)),
        subscribe(port.onDiagnostics, event => {
          cacheDiagnostics(event);
          for (const listener of [...diagnosticListeners]) { try { listener(event); } catch { /* ignore */ } }
        }),
      ]);
      await refresh();
    })();
    return initialized;
  }

  function cacheDiagnostics(event: DiagnosticsPublished_Deserialize) {
    diagnosticsCache.delete(event.path);
    if (!event.diagnostics?.length) return;
    diagnosticsCache.set(event.path, event);
    while (diagnosticsCache.size > MAX_CACHED_DIAGNOSTICS) diagnosticsCache.delete(diagnosticsCache.keys().next().value as string);
  }

  function handleProgress(event: LanguageServerInstallProgress_Deserialize) {
    if (event.phase === "finished" || event.phase === "failed" || event.phase === "alreadyInstalled") {
      setProgress(event.server, undefined);
      void refresh();
      return;
    }
    setProgress(event.server, { phase: event.phase, received: event.received, total: event.total, message: event.message });
  }

  function dispose() {
    disposed = true;
    for (const stop of stops.splice(0)) { try { stop(); } catch { /* already gone */ } }
    diagnosticListeners.clear();
    resetListeners.clear();
    diagnosticsCache.clear();
  }

  const errorText = (cause: unknown) => cause && typeof cause === "object" && typeof (cause as { kind?: unknown }).kind === "string" ? describeLspError(cause as LspErrorDto) : cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
  const command = async (server: LanguageServerId, label: string, run: () => Promise<unknown>) => {
    try { await run(); clearError(); }
    catch (cause) { fail(`${label} ${serverLabels[server]} failed: ${errorText(cause)}`, server); }
    await refresh();
  };

  function entryFor(server: LanguageServerId, absolutePath?: string): ServerEntry | undefined {
    const rows = entries[server];
    if (!rows?.length) return undefined;
    if (absolutePath) {
      const target = normalizePath(absolutePath);
      const owner = rows.filter(row => row.root && (target === normalizePath(row.root) || target.startsWith(`${normalizePath(row.root)}/`))).sort((a, b) => b.root!.length - a.root!.length)[0];
      if (owner) return owner;
    }
    return rows.find(row => row.root === null) ?? rows[0];
  }

  function bufferState(path: string, workspaceRoot?: string): BufferLspState {
    const server = serverForBuffer(path);
    if (!server) return { kind: "unsupported" };
    const hinted = bufferErrors[path];
    const absolute = workspaceRoot && !/^([A-Za-z]:)?[\\/]/.test(path) ? `${normalizePath(workspaceRoot)}/${path}` : path;
    const entry = entryFor(server, absolute);
    const derived = deriveBufferState(server, entry, progress[server]);
    if (!hinted) return derived;
    if (!entry) return hinted;
    // A hint from a failed request wins over a state that shows no problem, until a request succeeds or the server restarts.
    // What the server itself reports as a failure, or a switch turned off in settings, always wins over a hint.
    if (derived.kind === "disabled" || failureKinds.has(derived.kind)) return derived;
    // A "starting" hint must not hide a server that has since become ready.
    if (!failureKinds.has(hinted.kind) && derived.kind === "ready") return derived;
    return hinted;
  }

  function binding(path: string, context: BindingContext): LspBinding | undefined {
    const server = serverForBuffer(path);
    if (!server) return undefined;
    const row = () => entryFor(server, context.workspaceRoot() ? `${normalizePath(context.workspaceRoot()!)}/${path}` : undefined);
    return {
      server,
      createSession: () => createLspSession(port),
      getRevision: context.getRevision,
      isSynchronized: context.isSynchronized,
      isActive: context.isActive,
      getWorkspaceGeneration: context.getWorkspaceGeneration,
      getEpoch: () => row()?.epoch,
      getCapabilities: () => { const entry = row(); return entry && entry.enabled && entry.state.kind === "ready" ? entry.capabilities ?? undefined : undefined; },
      subscribeDiagnostics: listener => { diagnosticListeners.add(listener); return () => diagnosticListeners.delete(listener); },
      subscribeReset: listener => onReset(server, listener, () => row()?.root),
      openLocation: context.openLocation,
      notify: context.notify,
      reportError: error => noteError(path, error),
      reportOk: () => { if (bufferErrors[path]) setBufferErrors(path, undefined); },
      getLatestDiagnostics: () => diagnosticsCache.get(path),
    };
  }

  function noteError(path: string, failure: LspErrorDto) {
    const derived = deriveFromError(failure, serverForBuffer(path));
    if (derived && derived.kind !== "unsupported") setBufferErrors(path, derived);
  }

  function onReset(server: LanguageServerId, listener: () => void, root?: () => string | null | undefined) {
    const set = resetListeners.get(server) ?? new Set<ResetListener>();
    const item: ResetListener = { listener, root };
    set.add(item);
    resetListeners.set(server, set);
    return () => { set.delete(item); };
  }

  return {
    entries, loaded, error, init, statusError,
    errorFor: server => { const owner = errorServer(); return !owner || owner === server ? error() : ""; }, refresh, dispose,
    install: server => command(server, "Installing", () => port.install(server)),
    restart: server => command(server, "Restarting", () => port.restart(server)),
    retry: server => {
      const kind = entryFor(server)?.state.kind;
      const install = kind === "installFailed" || kind === "needsInstall";
      return command(server, install ? "Installing" : "Restarting", () => install ? port.install(server) : port.restart(server));
    },
    entryFor, bufferState, progress: server => progress[server], binding,
    noteError,
    onDiagnostics: listener => { diagnosticListeners.add(listener); return () => { diagnosticListeners.delete(listener); }; },
    onReset,
    latestDiagnostics: path => diagnosticsCache.get(path),
    pruneDiagnostics: keep => { for (const path of [...diagnosticsCache.keys()]) if (!keep || !keep(path)) diagnosticsCache.delete(path); },
  };
}

/** Owner-scoped helper for components: creates the store under the current reactive owner and disposes with it. */
export function useLanguageServers(port: LspPort, options?: LanguageServersOptions): LanguageServers {
  const store = createLanguageServers(port, options);
  onCleanup(() => store.dispose());
  void store.init();
  return store;
}
