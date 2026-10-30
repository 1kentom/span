import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createAutoSaveController, type AutoSaveFailure } from "./autosave";
import { createStore } from "solid-js/store";
import { ChangeSet, Text } from "@codemirror/state";
import { isAssetPath, isBinaryAssetPath } from "../components/AssetPreview";
import { planTabEvictions } from "./tabLimit";
import type { EditorEdit, EditorDocumentChange } from "../components/Editor";
import { api, isDesktop } from "../lib/client";
import { explorerPreferences, legacyExplorerPreferences, resolveLegacyExplorerPreferences } from "../lib/explorer-prefs";
import { fileName, normalizePath } from "../lib/navigation";
import { isViewerTab, viewerTabName } from "../lib/viewer-tabs";
import { isKnownBinaryPath, isNotTextError } from "../lib/binary-file";
import type { FileProbe, ExternalFileState, ExternalFileResolution, BufferSnapshot, FileEntry, FileIndexStatus, SearchMatch, Settings_Serialize as Settings, Workspace, SessionState_Serialize as SessionState, SessionPanels_Serialize as SessionPanels, MarkdownView, SettingsScope, StartupRequest_Serialize as StartupRequest } from "../bindings";

export const SETTINGS_TAB = "span:settings";
const GIT_TAB_PREFIX = "span:git:";
export const isGitTab = (path: string) => path.startsWith(GIT_TAB_PREFIX);
export function gitTabKey(path: string) { try { return isGitTab(path) ? decodeURIComponent(path.slice(GIT_TAB_PREFIX.length, path.lastIndexOf(":"))) : undefined; } catch { return undefined; } }
export function gitTabId(key: string, title: string) { return `${GIT_TAB_PREFIX}${encodeURIComponent(key)}:${encodeURIComponent(title)}`; }
function gitTabTitle(path: string) { try { return decodeURIComponent(path.slice(path.lastIndexOf(":") + 1)); } catch { return "Git comparison"; } }
export function settingsBufferScope(path: string): SettingsScope | undefined { return path === "settings://user" ? "user" : path === "settings://workspace" ? "workspace" : undefined; }
export const isSettingsBuffer = (path: string) => settingsBufferScope(path) !== undefined;
export const settingsBufferPath = (scope: SettingsScope) => `settings://${scope}`;
export const tabName = (path: string) => path === SETTINGS_TAB ? "Settings" : isGitTab(path) ? gitTabTitle(path) : isViewerTab(path) ? viewerTabName(path) : isSettingsBuffer(path) ? `${settingsBufferScope(path) === "user" ? "User" : "Workspace"} settings.jsonc` : path.split("/").pop() || path;
export async function settleIntent<T>(intent: T, isCurrent: (intent: T) => boolean, work: () => Promise<boolean>, complete: () => void | Promise<void>): Promise<boolean> {
  if (!isCurrent(intent) || !await work() || !isCurrent(intent)) return false;
  await complete();
  return true;
}
export type EditorGroup = { id: number; tabs: string[]; active?: string };
export function createWorkbench() {
  const [workspace, setWorkspace] = createSignal<Workspace>();
  const [workspaceGeneration, setWorkspaceGeneration] = createSignal(0);
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([""]));
  const [buffers, setBuffers] = createStore<Record<string, BufferSnapshot>>({});
  /** Workspace files that are not UTF-8 text. They open in the file viewer, never in a buffer. */
  const [binaryFiles, setBinaryFiles] = createStore<Record<string, FileProbe>>({});
  const [documents, setDocuments] = createSignal<Record<string, { document: Text; change?: EditorDocumentChange }>>({});
  const [groups, setGroups] = createSignal<EditorGroup[]>([{ id: 1, tabs: [] }]);
  const [activeGroup, setActiveGroupState] = createSignal(1);
  const [indexStatus, setIndexStatus] = createSignal<FileIndexStatus | null>(null);
  const [indexError, setIndexError] = createSignal("");
  const [recentPaths, setRecentPaths] = createSignal<string[]>([]);
  // Goto can use already visible/open files before the background index finds them.
  const files = createMemo(() => {
    const known = new Map<string, FileEntry>();
    for (const entries of Object.values(directories)) for (const entry of entries || []) if (!entry.isDir && !entry.backgroundExcluded) known.set(entry.path, entry);
    for (const path of recentPaths()) known.set(path, { path, name: fileName(path), isDir: false });
    return [...known.values()];
  });
  const [settings, setSettings] = createSignal<Settings>({ theme: "Dark", fontSize: 13, tabSize: 2, wordWrap: false, uiFontSize: 13, uiFontFamily: "Inter", editorFontFamily: "JetBrains Mono", collapsePanelsOnDrag: true, markdownPreviewDefault: true, formatOnSave: false, autoSave: "afterDelay", autoSaveDelay: 1000, tabLimitEnabled: true, tabLimit: 10, tabLimitPerGroup: false, zoomLevel: null, keybindings: {}, formatters: {}, languageServers: { autoInstall: false, enabled: {}, javaHome: null, nodePath: null, runProjectCode: false, trustedWorkspaces: [], watchIncludeDirectories: [], silencedWatchWarnings: [] } });
  const [settingsScope, setSettingsScope] = createSignal<SettingsScope>("workspace");
  const [scopeSettings, setScopeSettings] = createSignal<Settings>(settings());
  const [configuredSettingsKeys, setConfiguredSettingsKeys] = createSignal<string[]>([]);
  const [fileOperationBusy, setFileOperationBusy] = createSignal(false);
  const [editCounters, setEditCounters] = createSignal<Record<string, number>>({});
  const [autoSaveFailures, setAutoSaveFailures] = createSignal<readonly AutoSaveFailure[]>([]);
  const [settingsJsonc, setSettingsJsonc] = createSignal("");
  const [panels, setPanels] = createSignal<SessionPanels>({ projectWidth: Math.min(1000, Math.max(230, Math.round((typeof window === "undefined" ? 1440 : window.innerWidth) * .25) - 12)), assistantWidth: Math.min(1000, Math.max(260, Math.round((typeof window === "undefined" ? 1440 : window.innerWidth) * .25) - 12)), terminalHeight: Math.min(1000, Math.round((typeof window === "undefined" ? 900 : window.innerHeight) * .31)), projectCollapsed: false, assistantCollapsed: false, terminalCollapsed: false });
  const [markdownViews, setMarkdownViews] = createSignal<Record<string, MarkdownView>>({});
  const [sessionReady, setSessionReady] = createSignal(false);
  const closedTabs: { path: string; group: number }[] = [];
  const restoreProtectedTabs = new Set<string>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<SearchMatch[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [pendingClose, setPendingClose] = createSignal<{ path: string; group: number; closingGroup?: boolean }>();
  const [closeBusy, setCloseBusy] = createSignal(false);
  const [externalAbandoning, setExternalAbandoning] = createSignal(false);
  let closeOperation = 0;
  let nextGroupId = 2;
  /** Two editor groups are stacked instead of side by side. */
  const [splitVertical, setSplitVertical] = createSignal(false);
  const [pendingWorkspace, setPendingWorkspace] = createSignal(false);
  const [pendingRecovery, setPendingRecovery] = createSignal<{ path: string; document: Text }>();
  const [externalChanges, setExternalChanges] = createSignal<Record<string, ExternalFileState>>({});
  const [externalReview, setExternalReview] = createSignal<ExternalFileState>();
  let externalReviewDocument: Text | undefined;
  const reviewExternalFile = (path?: string) => { externalReviewDocument = path ? documents()[path]?.document : undefined; setExternalReview(path ? externalChanges()[path] : undefined); };
  const [externalOperation, setExternalOperation] = createSignal<string>();
  const externalRetainedDrafts = new Set<string>();
  let externalRevision: number | null = null;
  let externalChecking: Promise<void> | undefined;
  const forgetExternal = (path: string) => { externalRetainedDrafts.delete(path); setExternalChanges(current => { const next = { ...current }; delete next[path]; return next; }); if (externalReview()?.path === path) reviewExternalFile(); };
  const [failed, setFailed] = createSignal<Set<string>>(new Set());
  const accepted = new Map<string, BufferSnapshot>();
  const openingBuffers = new Map<string, { version: number; promise: Promise<BufferSnapshot> }>();
  const writes = new Map<string, Promise<void>>();
  const pendingEdits = new Map<string, EditorEdit[]>();
  const histories = new Map<string, { undo: { forward: ChangeSet; backward: ChangeSet; time: number; origin?: object }[]; redo: { forward: ChangeSet; backward: ChangeSet; time: number; origin?: object }[] }>();
  const activeFormatTickets = new Map<string, number>();
  let nextFormatTicket = 1;
  const tabRecency = new Map<string, number>();
  let tabClock = 0;
  const latestOpenByGroup = new Map<number, number>();
  let openIntent = 0;
  let workspaceVersion = 0;
  let formatWorkspaceEpoch = 0;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let indexRequest = 0;
  let discoveryEpoch = 0;
  const [discoveryRevision, setDiscoveryRevision] = createSignal(0);
  const directoryLoads = new Map<string, Promise<void>>();
  const [loadingDirectories, setLoadingDirectories] = createSignal<ReadonlySet<string>>(new Set());
  onCleanup(() => { disposed = true; clearTimeout(indexTimer); });
  async function refreshIndexStatus(version = workspaceVersion) {
    const root = workspace()?.root;
    if (!root || disposed || version !== workspaceVersion) return;
    clearTimeout(indexTimer);
    const request = ++indexRequest;
    try {
      const status = await api.fileIndexStatus();
      if (disposed || version !== workspaceVersion || request !== indexRequest) return;
      if (status && normalizePath(status.workspaceRoot) !== normalizePath(root)) return;
      setIndexStatus(status); setIndexError("");
      void checkExternalChanges();
    } catch (error) {
      if (disposed || version !== workspaceVersion || request !== indexRequest) return;
      setIndexError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed && version === workspaceVersion && request === indexRequest) indexTimer = setTimeout(() => void refreshIndexStatus(version), indexStatus()?.status === "scanning" ? 500 : 2000);
    }
  }
  async function checkExternalChanges(force = false): Promise<void> {
    if (!isDesktop || typeof api.checkExternalFiles !== "function" || disposed || busy() || externalOperation()) return;
    if (externalChecking) return externalChecking;
    const version = workspaceVersion; const root = workspace()?.root; if (!root) return;
    const before = new Map(Object.keys(buffers).filter(path => filesystemTab(path) && hasOpenEditor(path)).map(path => [path, { document: documents()[path]?.document, revision: buffers[path].revision }]));
    const checks = [...before].map(([path, value]) => ({ path, expectedRevision: value.revision, allowReload: !dirty(path) && !writes.has(path) }));
    externalChecking = (async () => {
      let retry = false; let changedDirectories = false; let revision = externalRevision;
      for (let start = 0; start < Math.max(1, checks.length); start += 256) {
        const update = await api.checkExternalFiles(checks.slice(start, start + 256), root, force ? null : externalRevision);
        if (disposed || version !== workspaceVersion || update.workspaceRoot !== root) return;
        revision = update.revision; changedDirectories ||= update.directoriesChanged;
        for (const state of update.states) {
          const previous = before.get(state.path); if (!previous || !hasOpenEditor(state.path)) continue;
          if (state.kind === "stale") { retry = true; continue; }
          if (state.kind === "reloaded" && state.snapshot) {
            if (documents()[state.path]?.document !== previous.document || buffers[state.path]?.revision !== previous.revision || dirty(state.path)) {
              externalRetainedDrafts.add(state.path);
              setExternalChanges(current => ({ ...current, [state.path]: { ...state, kind: "conflict", snapshot: null } }));
              await reconcileLocalDraft(state.path, version); retry = true;
            } else { applyFormatterSnapshot(state.path, state.snapshot); forgetExternal(state.path); }
          } else if (state.kind === "conflict" || state.kind === "deleted" || state.kind === "unavailable") {
            setExternalChanges(current => current[state.path]?.disk?.token === state.disk?.token && current[state.path]?.kind === state.kind && current[state.path]?.error === state.error ? current : ({ ...current, [state.path]: state }));
          } else if (state.kind === "unchanged" && !externalRetainedDrafts.has(state.path)) forgetExternal(state.path);
        }
      }
      if (disposed || version !== workspaceVersion) return;
      if (!retry) externalRevision = revision;
      if (changedDirectories) await Promise.all(Object.keys(directories).filter(path => !!directories[path]).map(async path => { const pending = directoryLoads.get(path); if (pending) await pending; if (!disposed && version === workspaceVersion) await loadDirectory(path); }));
    })().catch(error => { if (!disposed && version === workspaceVersion) report(error); }).finally(() => { if (version === workspaceVersion) externalChecking = undefined; });
    return externalChecking;
  }
  async function resolveExternalChange(path: string, resolution: ExternalFileResolution) {
    const conflict = externalReview()?.path === path ? externalReview() : externalChanges()[path]; const root = workspace()?.root; const version = workspaceVersion;
    if (!conflict?.disk || !root || externalOperation()) throw new Error("Refresh the external change before choosing a resolution.");
    const document = externalReview()?.path === path ? externalReviewDocument : documents()[path]?.document;
    setExternalOperation(path);
    try {
      await flush(path);
      if (failed().has(path) || pendingEdits.get(path)?.length) throw new Error("The editor draft is not synchronized. Resolve the edit error before overwriting disk.");
      if (version !== workspaceVersion || documents()[path]?.document !== document || !hasOpenEditor(path)) throw new Error("The document changed during review. Compare it again before continuing.");
      const snapshot = await api.resolveExternalFile(path, buffers[path].revision, conflict.disk.token, resolution, root);
      if (version !== workspaceVersion) return;
      if (documents()[path]?.document !== document || pendingEdits.get(path)?.length) await reconcileLocalDraft(path, version);
      else applyFormatterSnapshot(path, snapshot);
      forgetExternal(path);
    } catch (error) { if (version === workspaceVersion) report(error); throw error; }
    finally { if (version === workspaceVersion) { setExternalOperation(undefined); void checkExternalChanges(true); } }
  }
  async function queryFiles(query: string): Promise<FileEntry[]> {
    const version = workspaceVersion; const epoch = discoveryEpoch; const root = workspace()?.root;
    if (!root) return [];
    const result = await api.queryFile(query, 100);
    if (disposed || version !== workspaceVersion || epoch !== discoveryEpoch || normalizePath(result.workspaceRoot) !== normalizePath(root) || (indexStatus() && result.generation < indexStatus()!.generation)) return [];
    return result.results.map(match => ({ path: match.path, name: fileName(match.path), isDir: false }));
  }
  let settingsRequest = 0;
  let searchVersion = 0;
  let activeSearch: { cancel: () => Promise<void> } | undefined;
  const report = (e: unknown) => setError(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
  const tracksTab = (path: string) => path !== SETTINGS_TAB && !isSettingsBuffer(path) && !isViewerTab(path);
  const filesystemTab = (path: string) => tracksTab(path) && !isGitTab(path);
  function rememberTab(path?: string) { if (path && tracksTab(path)) tabRecency.set(path, ++tabClock); }
  function setActiveGroup(group: number) {
    const changed = activeGroup() !== group;
    setActiveGroupState(group);
    if (changed) rememberTab(groups().find(item => item.id === group)?.active);
  }
  function invalidateOpenIntent(group: number) { latestOpenByGroup.set(group, ++openIntent); }
  const activeTab = () => groups().find(g => g.id === activeGroup())?.active;
  const activePath = () => { const tab = activeTab(); return tab && tab !== SETTINGS_TAB && !isGitTab(tab) && !isViewerTab(tab) ? tab : undefined; };
  const hasOpenEditor = (path: string) => groups().some(group => group.tabs.includes(path));
  /** Tell the backend language servers a file is no longer shown anywhere, so they can close it. */
  function releaseBuffer(path: string) {
    if (!isDesktop || !filesystemTab(path) || hasOpenEditor(path)) return;
    void Promise.resolve(api.releaseBuffer(path)).catch(() => undefined);
  }
  function cancelFormat(path: string) {
    const requestId = activeFormatTickets.get(path);
    if (requestId === undefined) return;
    activeFormatTickets.delete(path);
    if (isDesktop) void api.cancelFormatBuffer(path, requestId).catch(() => undefined);
  }
  function cancelAllFormats() {
    for (const path of [...activeFormatTickets.keys()]) cancelFormat(path);
  }
  const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);
  const markdownView = (path: string): MarkdownView => markdownViews()[path] || (isMarkdown(path) ? settings().markdownPreviewDefault ? "preview" : "source" : isAssetPath(path) ? "preview" : "source");
  const setMarkdownView = (path: string, view: MarkdownView) => setMarkdownViews(current => ({ ...current, [path]: view }));
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionWriting: Promise<void> = Promise.resolve();
  function sessionSnapshot(): SessionState | undefined {
    const current = workspace(); if (!current) return;
    return { workspaceRoot: current.root, groups: groups().map(group => ({ paths: group.tabs.filter(filesystemTab), activePath: group.active && filesystemTab(group.active) ? group.active : group.tabs.find(filesystemTab) || null })), activeGroup: Math.max(0, groups().findIndex(group => group.id === activeGroup())), panels: panels(), markdownViews: markdownViews(), splitVertical: splitVertical() && groups().length > 1 };
  }
  async function persistSession() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = undefined;
    const state = sessionSnapshot(); if (!state || !isDesktop || !sessionReady() || busy()) return;
    sessionWriting = sessionWriting.catch(() => undefined).then(() => api.saveSession(state));
    try { await sessionWriting; } catch (e) { report(e); }
  }
  createEffect(() => { const state = sessionSnapshot(); if (sessionTimer) clearTimeout(sessionTimer); if (!state || !sessionReady() || !isDesktop || busy()) return; sessionTimer = setTimeout(() => void persistSession(), 350); });
  onCleanup(() => { if (sessionTimer) clearTimeout(sessionTimer); });
  const dirty = (path: string) => { documents()[path]; const buffer = buffers[path]; const revision = buffer?.revision; const savedRevision = buffer?.savedRevision; return !!buffer && (!!externalChanges()[path] || (pendingEdits.get(path)?.length || 0) > 0 || revision !== savedRevision); };
  const hasDirty = () => Object.keys(buffers).some(dirty);
  function enforceTabLimit(protectedPaths: ReadonlySet<string> = new Set()) {
    const preferences = settings();
    if (!preferences.tabLimitEnabled) return;
    const paths = [...new Set(groups().flatMap(group => group.tabs).filter(tracksTab))];
    const mostRecentFirst = paths.sort((a, b) => (tabRecency.get(b) || 0) - (tabRecency.get(a) || 0));
    const candidates = groups().map(group => ({ ...group, tabs: group.tabs.filter(tracksTab) }));
    const removals = planTabEvictions(candidates, preferences.tabLimit, preferences.tabLimitPerGroup, mostRecentFirst, dirty, protectedPaths);
    if (!removals.length) return;
    const removed = new Map<number, Set<string>>();
    for (const item of removals) {
      const paths = removed.get(item.group) || new Set<string>(); paths.add(item.path); removed.set(item.group, paths);
    }
    const remaining = new Set(groups().flatMap(group => group.tabs.filter(path => !removed.get(group.id)?.has(path))));
    for (const item of removals) if (!remaining.has(item.path)) tabRecency.delete(item.path);
    setGroups(current => current.map(group => {
      const paths = removed.get(group.id);
      if (!paths) return group;
      const tabs = group.tabs.filter(path => !paths.has(path));
      return { ...group, tabs, active: group.active && tabs.includes(group.active) ? group.active : tabs[0] };
    }));
    for (const path of new Set(removals.map(item => item.path))) releaseBuffer(path);
  }

  function applyFormatterSnapshot(path: string, snapshot: BufferSnapshot): boolean {
    const previousDocument = documents()[path]?.document;
    if (!previousDocument) return false;
    const nextDocument = Text.of(snapshot.text.split("\n"));
    accepted.set(path, snapshot);
    setBuffers(path, snapshot);
    if (!previousDocument.eq(nextDocument)) {
      const changes = [{ from: 0, to: previousDocument.length, insert: nextDocument.toString() }];
      const changeSet = ChangeSet.of(changes, previousDocument.length);
      const history = histories.get(path) || { undo: [], redo: [] };
      history.undo.push({ forward: changeSet, backward: changeSet.invert(previousDocument), time: Date.now() });
      if (history.undo.length > 1000) history.undo.shift();
      history.redo = [];
      histories.set(path, history);
      setDocuments(current => ({ ...current, [path]: { document: nextDocument, change: { before: previousDocument, changes: changeSet } } }));
      setEditCounters(current => ({ ...current, [path]: (current[path] || 0) + 1 }));
    }
    return true;
  }

  async function reconcileLocalDraft(path: string, generation: number): Promise<void> {
    if (generation !== workspaceVersion || !hasOpenEditor(path)) return;
    let pendingWrite = writes.get(path);
    if (pendingWrite) {
      await pendingWrite;
      while (writes.get(path) === pendingWrite) await Promise.resolve();
    }
    if (pendingEdits.get(path)?.length && !failed().has(path)) await flush(path);
    if (generation !== workspaceVersion || !hasOpenEditor(path)) return;
    const snapshot = await readBuffer(path);
    if (generation !== workspaceVersion || !hasOpenEditor(path)) return;
    const draft = documents()[path]?.document;
    if (!draft) return;
    const baseDocument = Text.of(snapshot.text.split("\n"));
    accepted.set(path, snapshot);
    pendingEdits.delete(path);
    setFailed(current => { const next = new Set(current); next.delete(path); return next; });
    setBuffers(path, snapshot);
    if (baseDocument.eq(draft)) return;
    // Rebase the still-visible local draft over the formatter's accepted Rope.
    // Formatter input is bounded in core, so this recovery edit cannot become a
    // 100 MiB renderer-to-backend source round trip.
    const changes = [{ from: 0, to: baseDocument.length, insert: draft.toString() }];
    edit(path, { baseRevision: snapshot.revision, changes, previousDocument: baseDocument, document: draft, changeSet: ChangeSet.of(changes, baseDocument.length) }, false);
    await flush(path);
  }

  async function loadDirectory(path: string) {
    const pending = directoryLoads.get(path); if (pending) return pending;
    const version = workspaceVersion; const epoch = discoveryEpoch;
    setLoadingDirectories(current => new Set([...current, path]));
    const operation = (async () => {
      try { const entries = await api.listDirectory(path); if (!disposed && version === workspaceVersion && epoch === discoveryEpoch) setDirectories(path, entries); }
      catch (e) { if (!disposed && version === workspaceVersion && epoch === discoveryEpoch) report(e); }
      finally { if (version === workspaceVersion && epoch === discoveryEpoch) { directoryLoads.delete(path); setLoadingDirectories(current => { const next = new Set(current); next.delete(path); return next; }); } }
    })();
    directoryLoads.set(path, operation);
    return operation;
  }
  /** Re-reads every expanded directory and the background index status after files were written to disk. */
  function refreshTree() {
    void refreshFiles().catch(report);
  }
  async function toggleDirectory(path: string) {
    if (expanded().has(path)) setExpanded(current => { const next = new Set(current); next.delete(path); return next; });
    else {
      // Expand immediately so loading is visible and a second click can collapse.
      setExpanded(current => new Set([...current, path]));
      await loadDirectory(path);
    }
  }
  const readBuffer = (path: string) => { const scope = settingsBufferScope(path); return scope ? api.openSettingsBuffer(scope) : api.openBuffer(path); };
  const discardBuffer = (path: string) => { const scope = settingsBufferScope(path); return scope ? api.discardSettingsBuffer(scope) : api.discardBuffer(path); };
  /** Records a file that cannot open as text so its tab shows the file viewer. The probe only adds name and size. */
  async function markBinary(path: string, version: number) {
    const fallback: FileProbe = { path, name: fileName(path), size: 0, kind: "binary" };
    const probe = await Promise.resolve().then(() => api.probeFile(path)).then(found => found ?? fallback, () => fallback);
    if (version !== workspaceVersion) return false;
    setBinaryFiles(path, { ...probe, path, kind: "binary" });
    return true;
  }
  async function ensureBuffer(path: string, version: number) {
    if (buffers[path] || binaryFiles[path] || isBinaryAssetPath(path)) return version === workspaceVersion;
    if (!isSettingsBuffer(path) && isKnownBinaryPath(path)) return markBinary(path, version);
    let pending = openingBuffers.get(path);
    if (!pending || pending.version !== version) {
      pending = { version, promise: readBuffer(path) };
      openingBuffers.set(path, pending);
    }
    try {
      const buffer = await pending.promise;
      if (version !== workspaceVersion) return false;
      if (!buffers[path]) {
        accepted.set(path, buffer);
        setBuffers(path, buffer);
        setDocuments(current => ({ ...current, [path]: { document: Text.of(buffer.text.split("\n")) } }));
      }
      return true;
    } catch (e) {
      // Binary or non UTF-8 content: Rust refuses it as not text, and the tab shows the viewer instead of an error.
      if (!isSettingsBuffer(path) && isNotTextError(e)) return markBinary(path, version);
      throw e;
    } finally {
      if (openingBuffers.get(path) === pending) openingBuffers.delete(path);
    }
  }
  function openGitTab(key: string, title: string, group = activeGroup()) {
    if (busy() || !workspace() || !groups().some(item => item.id === group)) return;
    const path = gitTabId(key, title);
    invalidateOpenIntent(group);
    batch(() => { setActiveGroup(group); setGroups(current => current.map(item => item.id === group ? { ...item, tabs: item.tabs.includes(path) ? item.tabs : [...item.tabs, path], active: path } : item)); });
    rememberTab(path); enforceTabLimit();
    return path;
  }
  async function openFile(path: string, group = activeGroup()) {
    if (isGitTab(path)) { if (groups().some(item => item.tabs.includes(path))) { invalidateOpenIntent(group); batch(() => { setActiveGroup(group); setGroups(current => current.map(item => item.id === group ? { ...item, tabs: item.tabs.includes(path) ? item.tabs : [...item.tabs, path], active: path } : item)); }); rememberTab(path); enforceTabLimit(); } return; }
    if (isViewerTab(path)) { openViewerTab(path, group); return; }
    const version = workspaceVersion;
    if (!groups().some(item => item.id === group)) return;
    const intent = ++openIntent;
    latestOpenByGroup.set(group, intent);
    setActiveGroup(group);
    try {
      if (!await ensureBuffer(path, version)) return;
      if (version !== workspaceVersion || !groups().some(item => item.id === group)) return;
      if (!isSettingsBuffer(path)) setRecentPaths(current => [path, ...current.filter(item => item !== path)].slice(0, 50));
      const latestForGroup = latestOpenByGroup.get(group) === intent;
      rememberTab(path);
      batch(() => { setGroups(current => current.map(g => g.id === group ? { ...g, tabs: g.tabs.includes(path) ? g.tabs : [...g.tabs, path], active: latestForGroup ? path : g.active } : g)); });
      enforceTabLimit(restoreProtectedTabs);
    } catch (e) { if (latestOpenByGroup.get(group) === intent) report(e); }
  }
  async function openWorkspace(path?: string, restore?: SessionState) {
    if (busy()) return;
    setBusy(true);
    try {
      if (activeSearch) await activeSearch.cancel().catch(() => undefined);
      searchVersion++;
      await Promise.all([...writes.values()]);
      const value = await api.openWorkspace(path);
      if (!value) return;
      formatWorkspaceEpoch++;
      cancelAllFormats();
      workspaceVersion++;
      closeOperation++; setPendingClose(undefined); setCloseBusy(false); setExternalAbandoning(false);
      externalRetainedDrafts.clear(); externalRevision = null; externalChecking = undefined; setExternalChanges({}); setExternalReview(undefined); setExternalOperation(undefined);
      latestOpenByGroup.clear();
      openingBuffers.clear();
      restoreProtectedTabs.clear();
      tabRecency.clear(); tabClock = 0;
      batch(() => { setWorkspaceGeneration(workspaceVersion); setWorkspace(value); setGroups([{ id: 1, tabs: [] }]); setSplitVertical(false); setActiveGroup(1); setExpanded(new Set([""])); setError(""); setSearchResults([]); setIndexStatus(null); setIndexError(""); });
      for (const key of Object.keys(buffers)) setBuffers(key, undefined!);
      for (const key of Object.keys(binaryFiles)) setBinaryFiles(key, undefined!);
      for (const key of Object.keys(directories)) setDirectories(key, undefined!);
      clearTimeout(indexTimer); directoryLoads.clear(); setLoadingDirectories(new Set<string>());
      void refreshIndexStatus(workspaceVersion);
      nextGroupId = 2; accepted.clear(); pendingEdits.clear(); histories.clear(); closedTabs.length = 0; setRecentPaths([]); setDocuments({}); setEditCounters({}); setMarkdownViews(restore?.markdownViews || {});
      // Render the first visible level independently of settings/session restoration.
      const rootListing = loadDirectory("");
      const preferences = Promise.all([api.getSettings(), api.getSettingsJsonc()]).then(([prefs, rawSettings]) => {
        batch(() => { setSettings(prefs); setScopeSettings(prefs); setSettingsJsonc(rawSettings); });
      });
      await Promise.all([rootListing, preferences]);
      await refreshSettingsScope(settingsScope());
      if (restore) {
        setPanels(restore.panels);
        setGroups(restore.groups.slice(0, 2).map((_group, index) => ({ id: index + 1, tabs: [] })));
        if (!groups().length) setGroups([{ id: 1, tabs: [] }]);
        setSplitVertical(!!restore.splitVertical && groups().length > 1);
        for (const group of restore.groups.slice(0, 2)) if (group.activePath) restoreProtectedTabs.add(group.activePath);
        for (const [index, group] of restore.groups.slice(0, 2).entries()) {
          for (const file of group.paths) await openFile(file, index + 1);
          setGroups(current => current.map(item => item.id === index + 1 ? { ...item, active: item.tabs.includes(group.activePath || "") ? group.activePath! : item.tabs[0] } : item));
        }
        setActiveGroup(groups()[Math.min(restore.activeGroup, groups().length - 1)]?.id || 1);
        restoreProtectedTabs.clear();
        for (const group of groups()) rememberTab(group.active);
        enforceTabLimit();
        nextGroupId = Math.max(...groups().map(group => group.id)) + 1;
      }
      if (!isDesktop) {
        const allFiles = await queryFiles("");
        const sample = allFiles.find(f => f.path.endsWith("rpc-node.ts")) || allFiles.find(f => f.path.endsWith("App.tsx")) || allFiles[0];
        if (sample) {
          const parents = sample.path.split("/").slice(0, -1);
          let parent = "";
          for (const part of parents) { parent = parent ? `${parent}/${part}` : part; await loadDirectory(parent); setExpanded(current => new Set([...current, parent])); }
          await openFile(sample.path);
          for (const ending of ["package.json", "main.rs", "test.js"]) { const f = allFiles.find(f => f.path.endsWith(ending)); if (f) await openFile(f.path); }
          setGroups(current => current.map(g => ({ ...g, active: sample.path })));
        }
      }
    } catch (e) { report(e); } finally { setBusy(false); }
  }
  function requestWorkspace() { if (hasDirty()) setPendingWorkspace(true); else void openWorkspace(); }
  async function initialize(onStartup?: (request: StartupRequest) => Promise<void>) {
    if (!isDesktop) await openWorkspace();
    else {
      // A request that names a folder opens it. Requests that only name files never pick their folder as the
      // project, so the saved session is restored first and the files open inside it when they belong to it.
      try { const requests = await api.takeStartupRequests(); if (requests.length && onStartup && requests.some(request => !request.impliedRoot)) { for (const request of requests) await onStartup(request); } else { const saved = await api.getSession(); if (saved) await openWorkspace(saved.workspaceRoot, saved); else setSettings(await api.getSettings()); if (onStartup) for (const request of requests) await onStartup(request); } }
      catch (e) { report(e); }
    }
    if (!workspace()) try { await refreshSettingsScope("user"); } catch (error) { report(error); }
    setSessionReady(true);
  }
  function edit(path: string, event: EditorEdit, recordHistory = true) {
    cancelFormat(path);
    if (recordHistory) {
      const history = histories.get(path) || { undo: [], redo: [] };
      const backward = event.changeSet.invert(event.previousDocument);
      const time = Date.now();
      const last = history.undo[history.undo.length - 1];
      if (last && event.historyOrigin && last.origin === event.historyOrigin && time - last.time < 500 && last.forward.newLength === event.changeSet.length) {
        last.forward = last.forward.compose(event.changeSet);
        last.backward = backward.compose(last.backward);
        last.time = time;
      } else history.undo.push({ forward: event.changeSet, backward, time, origin: event.historyOrigin });
      if (history.undo.length > 1000) history.undo.shift();
      history.redo = []; histories.set(path, history);
    }
    setEditCounters(current => ({ ...current, [path]: (current[path] || 0) + 1 }));
    const queue = pendingEdits.get(path) || [];
    queue.push(event); pendingEdits.set(path, queue);
    setDocuments(current => ({ ...current, [path]: { document: event.document, change: { before: event.previousDocument, changes: event.changeSet } } }));
    if (!writes.has(path)) void flush(path);
  }
  function applyHistory(path: string, redo = false) {
    const history = histories.get(path);
    const entry = (redo ? history?.redo : history?.undo)?.pop();
    const previousDocument = documents()[path]?.document;
    if (!entry || !history || !previousDocument) return;
    const changeSet = redo ? entry.forward : entry.backward;
    if (changeSet.length !== previousDocument.length) { report("The document changed outside this edit history. Reopen the file before undoing."); return; }
    const changes: EditorEdit["changes"] = [];
    changeSet.iterChanges((from, to, _fromNext, _toNext, inserted) => changes.push({ from, to, insert: inserted.toString() }));
    const document = changeSet.apply(previousDocument);
    entry.time = 0;
    (redo ? history.undo : history.redo).push(entry);
    edit(path, { baseRevision: buffers[path].revision, changes, previousDocument, document, changeSet }, false);
  }
  async function flush(path: string): Promise<void> {
    const previous = writes.get(path);
    if (previous) return previous;
    const operation = (async () => {
      try {
        const queue = pendingEdits.get(path);
        while (queue?.length) {
          const base = accepted.get(path);
          if (!base) return;
          const scope = settingsBufferScope(path);
          const next = scope ? await api.editSettingsBuffer(scope, base.revision, queue[0].changes) : await api.editBuffer(path, base.revision, queue[0].changes);
          accepted.set(path, { ...base, ...next, savedRevision: Math.max(base.savedRevision, next.savedRevision) });
          queue.shift();
          batch(() => { setBuffers(path, "revision", next.revision); setBuffers(path, "savedRevision", Math.max(buffers[path].savedRevision, next.savedRevision)); });
          setFailed(current => { const result = new Set(current); result.delete(path); return result; });
        }
      } catch (e) { setFailed(current => new Set([...current, path])); report(e); }
    })();
    writes.set(path, operation);
    await operation;
    writes.delete(path);
  }
  const synchronized = (path: string) => { documents()[path]; buffers[path]?.revision; return !(pendingEdits.get(path)?.length); };
  async function save(path = activePath(), automatic = false): Promise<boolean> {
    if (!path) return false;
    if (externalChanges()[path]) { if (!automatic) reviewExternalFile(path); return false; }
    const version = workspaceVersion;
    try {
      await flush(path);
      const base = accepted.get(path);
      if (!base) return false;
      if (failed().has(path)) { report(new Error(`${path} could not be saved because an earlier edit failed to sync. Close the file and discard changes to reload it from disk.`)); return false; }
      const documentAtSave = documents()[path]?.document;
      const editCounterAtSave = editCounters()[path] || 0;
      const scope = settingsBufferScope(path);
      const result = scope ? await api.saveSettingsBuffer(scope, base.revision) : await api.saveBuffer(path, base.revision);
      if (version !== workspaceVersion) return false;
      const localChanged = documentAtSave !== documents()[path]?.document || editCounterAtSave !== (editCounters()[path] || 0) || !!pendingEdits.get(path)?.length;
      if (result.revision > base.revision) {
        if (localChanged) await reconcileLocalDraft(path, version);
        else applyFormatterSnapshot(path, result);
      } else {
        const current = accepted.get(path);
        const next = current && current.revision > result.revision ? { ...current, savedRevision: Math.max(current.savedRevision, result.savedRevision) } : result;
        accepted.set(path, next);
        setBuffers(path, "savedRevision", Math.max(buffers[path].savedRevision, result.savedRevision));
      }
      if (!dirty(path)) enforceTabLimit();
      if (isSettingsBuffer(path) || path === ".span/settings.jsonc") await refreshSettingsScope(settingsScope());
      return true;
    } catch (e) {
      report(e);
      if (version === workspaceVersion && String(e).includes("File changed on disk")) { await checkExternalChanges(true); if (!automatic && externalChanges()[path]) reviewExternalFile(path); }
      if (version === workspaceVersion) try { const snapshot = await readBuffer(path); if (snapshot.revision > (accepted.get(path)?.revision ?? 0)) { await acceptAgentBuffer(path, snapshot, true); report(e); } } catch { /* Preserve the local draft if recovery cannot read the accepted document. */ }
      return false;
    }
  }
  function openSettings() {
    const existing = groups().find(group => group.tabs.includes(SETTINGS_TAB));
    const group = existing?.id || activeGroup();
    invalidateOpenIntent(group);
    setGroups(current => current.map(item => item.id === group ? { ...item, tabs: item.tabs.includes(SETTINGS_TAB) ? item.tabs : [...item.tabs, SETTINGS_TAB], active: SETTINGS_TAB } : item));
    setActiveGroup(group);
  }
  /** Shows an attachment viewer tab. An already open one is focused in its group rather than duplicated. */
  function openViewerTab(path: string, preferred = activeGroup()) {
    const existing = groups().find(group => group.id === preferred && group.tabs.includes(path)) || groups().find(group => group.tabs.includes(path));
    const group = existing?.id ?? (groups().some(item => item.id === preferred) ? preferred : activeGroup());
    invalidateOpenIntent(group);
    setGroups(current => current.map(item => item.id === group ? { ...item, tabs: item.tabs.includes(path) ? item.tabs : [...item.tabs, path], active: path } : item));
    setActiveGroup(group);
  }
  async function reopenClosedTab() { const closed = closedTabs.pop(); if (closed) await openFile(closed.path, groups().some(group => group.id === closed.group) ? closed.group : activeGroup()); }
  function removeGroup(group: number) {
    const current = groups(); if (current.length <= 1) return;
    const index = current.findIndex(item => item.id === group);
    const next = current.filter(item => item.id !== group);
    batch(() => { setGroups(next); if (activeGroup() === group) setActiveGroup(next[Math.max(0, Math.min(index, next.length - 1))].id); });
    for (const path of current[index]?.tabs || []) if (!hasOpenEditor(path)) { cancelFormat(path); releaseBuffer(path); }
  }
  function removeTab(path: string, group: number, recordClosed = true) {
    if (recordClosed && filesystemTab(path)) { closedTabs.push({ path, group }); if (closedTabs.length > 20) closedTabs.shift(); }
    if (groups().find(item => item.id === group)?.active === path) invalidateOpenIntent(group);
    setGroups(current => current.map(item => {
      if (item.id !== group) return item;
      const tabs = item.tabs.filter(tab => tab !== path);
      return { ...item, tabs, active: item.active === path ? tabs[Math.min(item.tabs.indexOf(path), tabs.length - 1)] : item.active };
    }));
    if (!groups().find(item => item.id === group)?.tabs.length) removeGroup(group);
    if (!hasOpenEditor(path)) { cancelFormat(path); releaseBuffer(path); if (binaryFiles[path]) setBinaryFiles(path, undefined!); }
  }
  function closeGroup(group: number) {
    const current = groups().find(item => item.id === group); if (!current || groups().length <= 1) return;
    invalidateOpenIntent(group);
    const uniqueDirty = current.tabs.find(path => dirty(path) && !groups().some(item => item.id !== group && item.tabs.includes(path)));
    if (uniqueDirty) setPendingClose({ path: uniqueDirty, group, closingGroup: true });
    else removeGroup(group);
  }
  function closeTab(path: string, group: number) {
    if (groups().find(item => item.id === group)?.active === path) invalidateOpenIntent(group);
    const elsewhere = groups().some(item => item.id !== group && item.tabs.includes(path));
    if (dirty(path) && !elsewhere) setPendingClose({ path, group });
    else removeTab(path, group);
  }
  async function reconcileCanceledDiscard(path: string, version: number) {
    while (version === workspaceVersion) {
      await writes.get(path);
      const snapshot = await readBuffer(path);
      if (version !== workspaceVersion) return;
      if (writes.has(path) || snapshot.revision < (accepted.get(path)?.revision ?? 0)) continue;
      const draft = documents()[path]?.document;
      const baseline = Text.of(snapshot.text.split("\n"));
      pendingEdits.delete(path);
      accepted.set(path, snapshot);
      setFailed(current => { const next = new Set(current); next.delete(path); return next; });
      batch(() => {
        setBuffers(path, snapshot);
        if (draft && !draft.eq(baseline)) {
          // Recovery is one explicit replacement against the new authoritative revision.
          const changes = [{ from: 0, to: baseline.length, insert: draft.toString() }];
          edit(path, { baseRevision: snapshot.revision, previousDocument: baseline, document: draft, changes, changeSet: ChangeSet.of(changes, baseline.length) }, false);
        }
      });
      await flush(path);
      return;
    }
  }
  async function confirmClose(action: "save" | "discard" | "cancel") {
    const pending = pendingClose(); if (!pending) return;
    if (action === "cancel") { if (externalAbandoning()) return; closeOperation++; setCloseBusy(false); setPendingClose(undefined); return; }
    if (closeBusy()) return;
    const operation = ++closeOperation; const version = workspaceVersion; setCloseBusy(true);
    try {
      if (action === "save" && !await save(pending.path)) return;
      if (action === "discard") {
        await writes.get(pending.path);
        if (pendingClose() !== pending || operation !== closeOperation || version !== workspaceVersion) return;
        const originalDocument = documents()[pending.path]?.document;
        cancelFormat(pending.path);
        const unavailable = externalChanges()[pending.path]?.kind === "unavailable" && !externalChanges()[pending.path]?.disk;
        if (unavailable && typeof api.abandonExternalFile === "function") {
          const revision = buffers[pending.path].revision;
          setExternalAbandoning(true);
          await api.abandonExternalFile(pending.path, revision, workspace()!.root);
          if (version !== workspaceVersion || pendingClose() !== pending || operation !== closeOperation || documents()[pending.path]?.document !== originalDocument) return;
          accepted.delete(pending.path); pendingEdits.delete(pending.path); histories.delete(pending.path); forgetExternal(pending.path);
          setBuffers(pending.path, undefined!);
          setDocuments(current => { const next = { ...current }; delete next[pending.path]; return next; });
          setFailed(current => { const next = new Set(current); next.delete(pending.path); return next; });
        } else {
        const base = await discardBuffer(pending.path);
        if (version !== workspaceVersion) return;
        if (pendingClose() !== pending || operation !== closeOperation || documents()[pending.path]?.document !== originalDocument) { await reconcileCanceledDiscard(pending.path, version); return; }
        accepted.set(pending.path, base); pendingEdits.delete(pending.path); histories.delete(pending.path); forgetExternal(pending.path);
        setBuffers(pending.path, base);
        setDocuments(current => ({ ...current, [pending.path]: { document: Text.of(base.text.split("\n")) } }));
        }
      }
      if (pendingClose() !== pending || operation !== closeOperation || version !== workspaceVersion) return;
      setPendingClose(undefined);
      if (pending.closingGroup) closeGroup(pending.group);
      else removeTab(pending.path, pending.group);
    } catch (error) { if (version === workspaceVersion) report(error); }
    finally { if (operation === closeOperation) { setCloseBusy(false); setExternalAbandoning(false); } }
  }
  /** Direction names follow VS Code: "right" and "left" give side by side groups, "down" and "up" stacked ones. */
  type SplitDirection = "right" | "left" | "down" | "up";
  /** `sourcePath` null creates an empty group, undefined copies the source group's active file. */
  function splitEditor(sourceGroup = activeGroup(), sourcePath?: string | null, direction: SplitDirection = "right") {
    if (groups().length >= 2) return;
    const source = groups().find(group => group.id === sourceGroup); if (!source) return;
    const path = sourcePath === null ? undefined : sourcePath ?? (source.active !== SETTINGS_TAB ? source.active : undefined); const id = nextGroupId++;
    const created = { id, tabs: path ? [path] : [], active: path };
    batch(() => {
      setSplitVertical(direction === "down" || direction === "up");
      setGroups(current => direction === "left" || direction === "up" ? [created, ...current] : [...current, created]);
      setActiveGroup(id);
    });
  }
  async function openToSide(path: string, sourceGroup = activeGroup(), direction: SplitDirection = "right") {
    if (!groups().some(group => group.id === sourceGroup)) return;
    const other = groups().find(group => group.id !== sourceGroup);
    if (other) { await openFile(path, other.id); return; }
    const version = workspaceVersion;
    const opening = openFile(path, sourceGroup);
    const intent = latestOpenByGroup.get(sourceGroup);
    await opening;
    if (version !== workspaceVersion || latestOpenByGroup.get(sourceGroup) !== intent || groups().find(group => group.id === sourceGroup)?.active !== path) return;
    splitEditor(sourceGroup, path, direction);
  }
  /** Drop zones: the centre opens in the group, an edge opens in a new group on that side (or in the other group when two exist). */
  const zoneDirection = (zone: "left" | "right" | "top" | "bottom"): SplitDirection => zone === "top" ? "up" : zone === "bottom" ? "down" : zone;
  async function openInZone(path: string, group: number, zone: "center" | "left" | "right" | "top" | "bottom") {
    if (zone === "center") { await openFile(path, group); return; }
    const other = groups().find(item => item.id !== group);
    if (other) { await openFile(path, other.id); return; }
    if (!groups().some(item => item.id === group)) return;
    // The file opens only in the new group, unlike Open to the Side which also keeps it in the source group.
    splitEditor(group, null, zoneDirection(zone));
    await openFile(path, activeGroup());
  }
  function moveTabToZone(path: string, fromGroup: number, toGroup: number, zone: "center" | "left" | "right" | "top" | "bottom", copy = false) {
    if (zone === "center") { moveTab(path, fromGroup, toGroup, copy); return; }
    const other = groups().find(group => group.id !== toGroup);
    if (other) { moveTab(path, fromGroup, other.id, copy); return; }
    if (path === SETTINGS_TAB) copy = false;
    const source = groups().find(group => group.id === fromGroup); if (!source) return;
    // A lone tab cannot leave its only group empty-handed: splitting with it would leave an empty group behind.
    if (!copy && source.tabs.length < 2 && fromGroup === toGroup) return;
    splitEditor(toGroup, path, zoneDirection(zone));
    if (!copy) removeTab(path, fromGroup, false);
    rememberTab(path); enforceTabLimit();
  }
  function moveTab(path: string, fromGroup: number, toGroup: number, copy = false) {
    if (path === SETTINGS_TAB) copy = false;
    if (fromGroup === toGroup || !groups().some(group => group.id === toGroup)) return;
    invalidateOpenIntent(toGroup);
    setGroups(current => current.map(group => group.id === toGroup ? { ...group, tabs: group.tabs.includes(path) ? group.tabs : [...group.tabs, path], active: path } : group));
    if (!copy) removeTab(path, fromGroup, false);
    setActiveGroup(toGroup);
    rememberTab(path);
    enforceTabLimit();
  }
  async function search(query: string) {
    const version = ++searchVersion;
    if (activeSearch) void activeSearch.cancel().catch(() => undefined);
    setSearchResults([]);
    if (!query.trim()) { setSearching(false); return; }
    setSearching(true);
    const matches: SearchMatch[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => { timer = undefined; if (version === searchVersion) setSearchResults([...matches]); };
    try {
      const stream = api.searchStream(query, match => { if (version !== searchVersion) return; matches.push(match); if (!timer) timer = setTimeout(publish, 25); });
      activeSearch = stream;
      await stream.done;
      if (timer) clearTimeout(timer);
      publish();
    } catch (e) { if (version === searchVersion) report(e); }
    finally { if (version === searchVersion) { setSearching(false); activeSearch = undefined; } }
  }
  async function refreshSettingsScope(scope: SettingsScope = settingsScope()) {
    const request = ++settingsRequest; const version = workspaceVersion;
    const root = workspace()?.root; const legacy = legacyExplorerPreferences();
    if (isDesktop && root && Object.values(legacy).some(value => value !== null)) {
      try {
        const migration = await api.migrateExplorerPreferences(root, legacy);
        if (request !== settingsRequest || version !== workspaceVersion) return;
        resolveLegacyExplorerPreferences(migration.resolvedLegacyKeys);
      } catch { /* Keep legacy values until both settings scopes can be safely read and migrated. */ }
    }
    if (request !== settingsRequest || version !== workspaceVersion) return;
    const [selected, effective, raw, keys] = await Promise.all([api.getSettingsForScope(scope), api.getSettings(), api.getSettingsJsoncForScope(scope), api.getSettingsKeysForScope(scope)]);
    if (request !== settingsRequest || version !== workspaceVersion) return;
    const before = explorerPreferences(settings()); const after = explorerPreferences(effective);
    const visibilityChanged = before.showHiddenFiles !== after.showHiddenFiles || before.showIgnoredFiles !== after.showIgnoredFiles;
    if (visibilityChanged) {
      discoveryEpoch++; setDiscoveryRevision(discoveryEpoch); indexRequest++; searchVersion++;
      void activeSearch?.cancel().catch(() => undefined); activeSearch = undefined;
      setSearching(false); setSearchResults([]);
      directoryLoads.clear(); setLoadingDirectories(new Set<string>());
      for (const path of Object.keys(directories)) setDirectories(path, undefined!);
      setIndexStatus(null);
    }
    batch(() => { setSettingsScope(scope); setScopeSettings(selected); setSettings(effective); setSettingsJsonc(raw); setConfiguredSettingsKeys(keys); });
    enforceTabLimit();
    if (visibilityChanged && root) await refreshFiles();
  }
  async function reloadSettingsJsonc(): Promise<string> { await refreshSettingsScope(); return settingsJsonc(); }
  async function openSettingsJsonc(scope = settingsScope()) { await openFile(settingsBufferPath(scope)); }
  async function syncCleanSettingsBuffer(scope: SettingsScope) {
    const path = settingsBufferPath(scope); if (!buffers[path] || dirty(path)) return;
    const snapshot = await api.discardSettingsBuffer(scope); accepted.set(path, snapshot); setBuffers(path, snapshot); histories.delete(path);
    setDocuments(current => ({ ...current, [path]: { document: Text.of(snapshot.text.split("\n")) } }));
  }
  function guardSettingsScope(scope: SettingsScope) { if (dirty(settingsBufferPath(scope))) throw new Error("Save or discard the open settings file before changing this scope."); }
  async function saveSettingsJsonc(text: string): Promise<Settings> { const scope = settingsScope(); guardSettingsScope(scope); await api.updateSettingsJsoncForScope(scope, text); await refreshSettingsScope(scope); await syncCleanSettingsBuffer(scope); return scopeSettings(); }
  async function updateSettings(patch: Partial<Settings>) {
    const scope = settingsScope(); guardSettingsScope(scope);
    for (const [key, value] of Object.entries(patch)) if (JSON.stringify(scopeSettings()[key as keyof Settings]) !== JSON.stringify(value)) await api.updateSetting(scope, key, JSON.stringify(value));
    await refreshSettingsScope(scope); await syncCleanSettingsBuffer(scope);
  }
  /** Writes one (possibly dotted) key in one scope, leaving every other key of that scope alone. A null value removes the key. */
  async function updateSettingKey(key: string, value: unknown, scope: SettingsScope = settingsScope()) {
    guardSettingsScope(scope);
    await api.updateSetting(scope, key, value === null || value === undefined ? null : JSON.stringify(value));
    await refreshSettingsScope(settingsScope()); await syncCleanSettingsBuffer(scope);
  }
  async function updateEffectiveSetting(key: keyof Settings, value: Settings[keyof Settings]) { const scope: SettingsScope = workspace() ? "workspace" : "user"; guardSettingsScope(scope); await api.updateSetting(scope, key, JSON.stringify(value)); await refreshSettingsScope(); await syncCleanSettingsBuffer(scope); }
  async function resetSetting(key: keyof Settings) { const scope = settingsScope(); guardSettingsScope(scope); await api.updateSetting(scope, key, null); await refreshSettingsScope(scope); await syncCleanSettingsBuffer(scope); }
  async function refreshFiles() {
    const version = workspaceVersion;
    await Promise.all([...expanded()].map(directory => loadDirectory(directory)));
    if (version === workspaceVersion) void refreshIndexStatus(version);
  }
  const inSubtree = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  async function fileOperation<T>(operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (fileOperationBusy()) throw new Error("Finish the current file operation first.");
    const version = workspaceVersion; setFileOperationBusy(true);
    try { await Promise.all([...writes.values()]); if (version !== workspaceVersion) throw new Error("The project changed before the file operation started."); return await operation(() => { if (version !== workspaceVersion) throw new Error("The project changed during the file operation."); }); }
    finally { setFileOperationBusy(false); }
  }
  async function newFile(path: string) { return fileOperation(async assertCurrent => { const snapshot = await api.newFile(path); assertCurrent(); accepted.set(snapshot.path, snapshot); setBuffers(snapshot.path, snapshot); setDocuments(current => ({ ...current, [snapshot.path]: { document: Text.of(snapshot.text.split("\n")) } })); await refreshFiles(); await openFile(snapshot.path); return snapshot; }); }
  async function newDirectory(path: string) { return fileOperation(async assertCurrent => { const entry = await api.newDirectory(path); assertCurrent(); await refreshFiles(); await loadDirectory(entry.path); setExpanded(current => new Set([...current, entry.path])); return entry; }); }
  async function renamePath(from: string, to: string) {
    // The backend refuses to move a path with unsaved edits, so save them first and stop if one cannot be saved.
    for (const path of Object.keys(buffers)) if (buffers[path] && inSubtree(path, from) && dirty(path) && !await save(path)) throw new Error(`Could not save ${path}, so it was not moved.`);
    return fileOperation(async assertCurrent => {
      const entry = await api.renamePath(from, to); assertCurrent();
      const mapped = (path: string) => inSubtree(path, from) ? `${entry.path}${path.slice(from.length)}` : path;
      const moved = Object.keys(buffers).filter(path => buffers[path] && inSubtree(path, from));
      for (const previous of moved) {
        const next = mapped(previous); const snapshot = await api.openBuffer(next); assertCurrent(); const document = documents()[previous]?.document || Text.of(snapshot.text.split("\n")); const history = histories.get(previous);
        accepted.delete(previous); accepted.set(next, snapshot); histories.delete(previous); if (history) histories.set(next, history);
        setBuffers(previous, undefined!); setBuffers(next, snapshot);
        setDocuments(current => { const value = { ...current }; delete value[previous]; value[next] = { document }; return value; });
      }
      for (const previous of Object.keys(binaryFiles).filter(path => binaryFiles[path] && inSubtree(path, from))) {
        const next = mapped(previous); const probe = binaryFiles[previous];
        setBinaryFiles(previous, undefined!); setBinaryFiles(next, { ...probe, path: next, name: fileName(next) });
      }
      const movedTabs = new Set(groups().flatMap(group => group.tabs).filter(path => inSubtree(path, from)));
      for (const previous of movedTabs) {
        const next = mapped(previous); const priorRecency = tabRecency.get(previous); tabRecency.delete(previous);
        if (priorRecency !== undefined) tabRecency.set(next, Math.max(priorRecency, tabRecency.get(next) || 0));
      }
      batch(() => { setGroups(current => current.map(group => ({ ...group, tabs: group.tabs.map(mapped), active: group.active ? mapped(group.active) : undefined }))); setRecentPaths(current => current.map(mapped)); setExpanded(current => new Set([...current].map(mapped))); setMarkdownViews(current => Object.fromEntries(Object.entries(current).map(([path, view]) => [mapped(path), view]))); setEditCounters(current => Object.fromEntries(Object.entries(current).map(([path, revision]) => [mapped(path), revision]))); });
      for (const directory of Object.keys(directories)) if (inSubtree(directory, from)) setDirectories(directory, undefined!);
      await refreshFiles(); return entry;
    });
  }
  async function duplicatePath(from: string, to: string, open = true) { return fileOperation(async assertCurrent => { const entry = await api.duplicatePath(from, to); assertCurrent(); await refreshFiles(); if (open && !entry.isDir) await openFile(entry.path); return entry; }); }
  async function trashPath(path: string) {
    return fileOperation(async assertCurrent => {
      await api.trashPath(path); assertCurrent();
      for (const key of Object.keys(binaryFiles)) if (inSubtree(key, path)) setBinaryFiles(key, undefined!);
      for (const key of Object.keys(buffers)) if (inSubtree(key, path)) { cancelFormat(key); setBuffers(key, undefined!); accepted.delete(key); pendingEdits.delete(key); histories.delete(key); }
      setDocuments(current => Object.fromEntries(Object.entries(current).filter(([key]) => !inSubtree(key, path))));
      setGroups(current => current.map(group => { const tabs = group.tabs.filter(key => !inSubtree(key, path)); return { ...group, tabs, active: group.active && tabs.includes(group.active) ? group.active : tabs[0] }; }));
      for (const group of [...groups()]) if (!group.tabs.length) removeGroup(group.id);
      setRecentPaths(current => current.filter(key => !inSubtree(key, path))); setExpanded(current => new Set([...current].filter(key => !inSubtree(key, path))));
      for (const directory of Object.keys(directories)) if (inSubtree(directory, path)) setDirectories(directory, undefined!);
      await refreshFiles();
    });
  }
  async function acceptAgentBuffer(path: string, snapshot?: BufferSnapshot, preserveHistory = false) {
    const version = workspaceVersion;
    await writes.get(path);
    try {
      const result = await readBuffer(path);
      if (version !== workspaceVersion) return;
      if (writes.has(path)) { await writes.get(path); return acceptAgentBuffer(path, snapshot, preserveHistory); }
      const latest = result.revision >= (snapshot?.revision ?? 0) ? result : snapshot!;
      if (latest.revision < (accepted.get(path)?.revision ?? 0)) return;
      if (pendingEdits.get(path)?.length || failed().has(path)) {
        const draft = documents()[path]?.document;
        if (draft) setPendingRecovery({ path, document: draft });
        pendingEdits.delete(path);
        setFailed(current => { const next = new Set(current); next.delete(path); return next; });
      }
      setEditCounters(current => ({ ...current, [path]: (current[path] || 0) + 1 }));
      const previousDocument = documents()[path]?.document;
      const document = Text.of(latest.text.split("\n"));
      const changeSet = previousDocument ? ChangeSet.of({ from: 0, to: previousDocument.length, insert: document }, previousDocument.length) : undefined;
      if (preserveHistory && previousDocument && changeSet) {
        const history = histories.get(path) || { undo: [], redo: [] };
        history.undo.push({ forward: changeSet, backward: changeSet.invert(previousDocument), time: 0 });
        history.redo = []; histories.set(path, history);
      } else histories.delete(path);
      accepted.set(path, latest);
      setBuffers(path, latest);
      setDocuments(current => ({ ...current, [path]: { document, change: previousDocument && changeSet ? { before: previousDocument, changes: changeSet } : undefined } }));
      await openFile(path);
    } catch (e) { report(e); }
  }
  function resolveRecovery(restore: boolean) {
    const recovery = pendingRecovery();
    if (!recovery) return;
    if (restore) {
      const previousDocument = documents()[recovery.path]?.document;
      if (previousDocument) {
        const changes = [{ from: 0, to: previousDocument.length, insert: recovery.document.toString() }];
        edit(recovery.path, { baseRevision: buffers[recovery.path].revision, changes, document: recovery.document, previousDocument, changeSet: ChangeSet.of(changes, previousDocument.length) });
      }
    }
    setPendingRecovery(undefined);
  }
  async function format(path = activePath()) {
    if (!path || isSettingsBuffer(path)) return;
    const generation = workspaceVersion;
    const formatEpoch = formatWorkspaceEpoch;
    let ticket: number | undefined;
    let documentAtStart: Text | undefined;
    let editCounterAtStart = 0;
    try {
      await flush(path);
      if (generation !== workspaceVersion || !synchronized(path) || failed().has(path)) return;
      const base = accepted.get(path);
      documentAtStart = documents()[path]?.document;
      if (!base || !documentAtStart) return;
      editCounterAtStart = editCounters()[path] || 0;
      ticket = nextFormatTicket++;
      activeFormatTickets.set(path, ticket);
      const result = await api.formatBuffer(path, base.revision, ticket);
      if (generation !== workspaceVersion || formatEpoch !== formatWorkspaceEpoch) return;
      const currentTicket = activeFormatTickets.get(path);
      const localChanged = documentAtStart !== documents()[path]?.document
        || editCounterAtStart !== (editCounters()[path] || 0)
        || !!pendingEdits.get(path)?.length;
      if (currentTicket !== ticket) {
        if (currentTicket === undefined && localChanged && hasOpenEditor(path)) {
          try { await reconcileLocalDraft(path, generation); } catch (error) { report(error); }
        } else if (currentTicket === undefined && !localChanged) {
          const current = accepted.get(path);
          if (result.revision > base.revision && (!current || current.revision <= result.revision)) {
            // The last editor may close after Rust applies a successful format
            // but before its IPC response arrives. Refresh the hidden buffer
            // without reopening the tab so a later open starts at this revision.
            applyFormatterSnapshot(path, result);
          }
        }
        return;
      }
      if (!hasOpenEditor(path)) {
        activeFormatTickets.delete(path);
        if (!localChanged && result.revision > base.revision) applyFormatterSnapshot(path, result);
        return;
      }
      if (localChanged) {
        if (activeFormatTickets.get(path) === ticket) activeFormatTickets.delete(path);
        try { await reconcileLocalDraft(path, generation); } catch (error) { report(error); }
        return;
      }
      if (result.revision > base.revision) applyFormatterSnapshot(path, result);
    } catch (e) {
      if (generation !== workspaceVersion || !hasOpenEditor(path)) return;
      if (ticket !== undefined && activeFormatTickets.get(path) !== ticket && activeFormatTickets.has(path)) return;
      if (documentAtStart && (documentAtStart !== documents()[path]?.document || editCounterAtStart !== (editCounters()[path] || 0))) {
        if (activeFormatTickets.get(path) === ticket) activeFormatTickets.delete(path);
        try { await reconcileLocalDraft(path, generation); } catch (error) { report(error); }
      } else if (activeFormatTickets.get(path) === ticket) report(e);
    } finally {
      if (ticket !== undefined && activeFormatTickets.get(path) === ticket) activeFormatTickets.delete(path);
    }
  }
  async function refreshBuffer(path: string) {
    if (dirty(path)) { setError("This file has unsaved changes. Save or close it before loading agent edits."); return; }
    try { const result = await readBuffer(path); accepted.set(path, result); setBuffers(path, result); setDocuments(current => ({ ...current, [path]: { document: Text.of(result.text.split("\n")) } })); } catch (e) { report(e); }
  }
  const autosave = createAutoSaveController({
    read: () => ({ generation: workspaceGeneration(), mode: settings().autoSave, delay: settings().autoSaveDelay, paused: busy() || fileOperationBusy() || !!pendingClose() || pendingWorkspace(), buffers: [...new Set(groups().flatMap(group => group.tabs))].filter(path => !!buffers[path]).map(path => ({ path, revision: editCounters()[path] || 0, dirty: dirty(path), eligible: !isSettingsBuffer(path) && !externalChanges()[path] })) }),
    save: (path, generation) => generation === workspaceGeneration() ? save(path, true) : Promise.resolve(false),
    onFailures: setAutoSaveFailures,
  });
  createEffect(() => autosave.sync());
  onCleanup(() => { autosave.dispose(); cancelAllFormats(); });
  return { checkExternalChanges, externalChanges, externalReview, reviewExternalFile, externalReviewText: () => externalReviewDocument?.toString() ?? "", externalOperation, externalAbandoning, resolveExternalChange, openGitTab, openViewerTab, binaryFile: (path: string) => binaryFiles[path] as FileProbe | undefined, discoveryRevision, indexStatus, indexError, queryFiles, loadingDirectories, newFile, newDirectory, trashPath, renamePath, duplicatePath, refreshFiles, fileOperationBusy, settingsScope, scopeSettings, configuredSettingsKeys, refreshSettingsScope, resetSetting, updateEffectiveSetting, openSettingsJsonc, autoSaveFailures, autoSaveEditorBlur: autosave.editorBlur, autoSaveWindowBlur: autosave.windowBlur, workspace, workspaceGeneration, panels, setPanels, markdownView, setMarkdownView, isMarkdown, settingsJsonc, saveSettingsJsonc, reloadSettingsJsonc, persistSession, openSettings, reopenClosedTab, activeTab, directories, expanded, buffers, documents, synchronized, groups, activeGroup, setActiveGroup, files, recentPaths, settings, setSettings, pendingRecovery, resolveRecovery, acceptAgentBuffer, error, setError, busy, searching, searchResults, pendingClose, pendingWorkspace, setPendingWorkspace, failed, activePath, dirty, hasDirty, loadDirectory, refreshTree, toggleDirectory, openFile, openToSide, openWorkspace, requestWorkspace, initialize, edit, applyHistory, format, save, closeTab, closeGroup, closeBusy, moveTab, moveTabToZone, openInZone, splitVertical, setSplitVertical, confirmClose, splitEditor, search, updateSettings, updateSettingKey, refreshBuffer };
}
export type Workbench = ReturnType<typeof createWorkbench>;
