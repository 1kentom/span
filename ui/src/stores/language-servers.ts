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
  error: Accessor<string>;
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
  onReset: (server: LanguageServerId, listener: () => void) => () => void;
}

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
export function createLanguageServers(port: LspPort): LanguageServers {
  const [entries, setEntries] = createStore<Record<string, ServerEntry[]>>({});
  const [progress, setProgress] = createStore<Record<string, InstallProgress | undefined>>({});
  const [bufferErrors, setBufferErrors] = createStore<Record<string, BufferLspState | undefined>>({});
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal("");
  const diagnosticListeners = new Set<(event: DiagnosticsPublished_Deserialize) => void>();
  const resetListeners = new Map<LanguageServerId, Set<() => void>>();
  const stops: (() => void)[] = [];
  let initialized: Promise<void> | undefined;
  let disposed = false;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  const fireReset = (server: LanguageServerId) => { for (const listener of [...(resetListeners.get(server) ?? [])]) { try { listener(); } catch { /* a listener must not break the store */ } } };

  function applyStatus(rows: ServerStatusDto_Serialize[]) {
    const next: Record<string, ServerEntry[]> = {};
    for (const row of rows) {
      (next[row.server] ??= []).push({ server: row.server, root: row.root, state: row.state, installed: row.installed, enabled: row.enabled, version: row.version, epoch: row.epoch, capabilities: row.capabilities });
    }
    const restarted = Object.keys(next).filter(server => {
      const before = entries[server]?.[0]?.epoch;
      return before !== undefined && before !== next[server][0].epoch;
    });
    setEntries(reconcile(next, { merge: false }));
    setBufferErrors(reconcile({}));
    for (const server of restarted) fireReset(server as LanguageServerId);
  }

  function refresh(): Promise<void> {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const rows = await port.status();
          if (!disposed) { applyStatus(rows); setError(""); setLoaded(true); }
        } while (refreshAgain && !disposed);
      } catch (cause) {
        if (!disposed) { setError(cause instanceof Error ? cause.message : String(cause)); setLoaded(true); }
      } finally { refreshing = undefined; }
    })();
    return refreshing;
  }

  async function subscribe<T>(listen: (listener: (event: T) => void) => Promise<() => void>, listener: (event: T) => void) {
    try {
      const stop = await listen(listener);
      if (disposed) stop(); else stops.push(stop);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function init(): Promise<void> {
    if (initialized) return initialized;
    initialized = (async () => {
      await Promise.all([
        subscribe(port.onState, event => {
          const rows = entries[event.server];
          if (rows) {
            // A root the status list does not know means a server wide state (install gates), which applies to every row.
            const exact = rows.some(row => row.root === event.root);
            rows.forEach((row, index) => { if (!exact || row.root === event.root) setEntries(event.server, index, "state", event.state); });
          }
          if (event.state.kind !== "installing") setProgress(event.server, undefined);
          if (event.state.kind !== "ready") fireReset(event.server);
          void refresh();
        }),
        subscribe(port.onInstallProgress, event => handleProgress(event)),
        subscribe(port.onError, event => setError(`${serverLabels[event.server]}: ${event.message}`)),
        subscribe(port.onDiagnostics, event => { for (const listener of [...diagnosticListeners]) { try { listener(event); } catch { /* ignore */ } } }),
      ]);
      await refresh();
    })();
    return initialized;
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
  }

  const command = async (run: () => Promise<unknown>) => {
    try { await run(); setError(""); }
    catch (cause) {
      const text = cause && typeof cause === "object" && typeof (cause as { kind?: unknown }).kind === "string" ? describeLspError(cause as LspErrorDto) : cause instanceof Error ? cause.message : String(cause);
      setError(text);
    }
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
    if (!entry && hinted) return hinted;
    return deriveBufferState(server, entry, progress[server]);
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
      subscribeReset: listener => onReset(server, listener),
      openLocation: context.openLocation,
      notify: context.notify,
      reportError: error => noteError(path, error),
    };
  }

  function noteError(path: string, failure: LspErrorDto) {
    const derived = deriveFromError(failure, serverForBuffer(path));
    if (derived && derived.kind !== "unsupported") setBufferErrors(path, derived);
  }

  function onReset(server: LanguageServerId, listener: () => void) {
    const set = resetListeners.get(server) ?? new Set();
    set.add(listener);
    resetListeners.set(server, set);
    return () => { set.delete(listener); };
  }

  return {
    entries, loaded, error, init, refresh, dispose,
    install: server => command(() => port.install(server)),
    restart: server => command(() => port.restart(server)),
    retry: server => {
      const kind = entryFor(server)?.state.kind;
      return command(() => kind === "installFailed" || kind === "needsInstall" ? port.install(server) : port.restart(server));
    },
    entryFor, bufferState, progress: server => progress[server], binding,
    noteError,
    onDiagnostics: listener => { diagnosticListeners.add(listener); return () => { diagnosticListeners.delete(listener); }; },
    onReset,
  };
}

/** Owner-scoped helper for components: creates the store under the current reactive owner and disposes with it. */
export function useLanguageServers(port: LspPort): LanguageServers {
  const store = createLanguageServers(port);
  onCleanup(() => store.dispose());
  void store.init();
  return store;
}
