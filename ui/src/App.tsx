import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { parse as parseJsonc } from "jsonc-parser";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor, type EditorCommands, type EditorCursor } from "./components/Editor";
import AgentPanel from "./components/AgentPanel";
import { AgentModeSwitch } from "./components/AgentModeSwitch";
import { AgentsPage } from "./components/agents-page/AgentsPage";
import { createAgentController, type AgentPanelProps } from "./lib/agent-controller";
import { AGENT_MODE_SHORTCUT, isAgentModeChord, readAgentMode, writeAgentMode, type AgentMode } from "./lib/agents-page";
import { RAIL_SHORTCUT, createAgentsPanels, isRailChord, panelTarget, type PanelCommand } from "./lib/agents-page-panels";
import { createGitWorkbench, workspaceGitPath } from "./stores/git";
import { createGitDecorations } from "./stores/git-decorations";
import { createGitLineInfo } from "./stores/git-line-info";
import { GitSourceControl } from "./components/git/GitSourceControl";
import { createGitView } from "./stores/git-view";
import { GitDiffView } from "./components/git/GitDiffView";
import { GitLineStatus } from "./components/git/GitLineStatus";
import { GitBlameView } from "./components/git/GitBlameView";
import { GitMergeEditor } from "./components/git/GitMergeEditor";
import { GitHubPanel } from "./components/git/GitHubPanel";
import { createGitHubWorkbench } from "./stores/github";
import type { GitConflictResource_Serialize as GitConflictResource } from "./bindings";
import { Explorer } from "./components/Explorer";
import { NewPopup } from "./components/NewPopup";
import { createExplorerState } from "./lib/explorer-state";
import Icon, { FileIcon, MenuIcon } from "./components/Icon";
import { ExternalFileConflict } from "./components/ExternalFileConflict";
import { Modal, modalAllowsGlobalShortcut } from "./components/Modal";
import { WorkspaceTrustDialog } from "./components/WorkspaceTrustDialog";
import { useWorkspaceTrust } from "./lib/workspace-trust";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardSettings } from "./components/KeyboardSettings";
import { SourcePreviewToggle } from "./components/SourcePreviewToggle";
import { MarkdownPreview, type MarkdownRunRequest } from "./components/MarkdownPreview";
import { RunConfigurationSelect } from "./components/RunConfigurationSelect";
import { RunConfigurationManager } from "./components/RunConfigurationManager";
import { RunOutput } from "./components/RunOutput";
import { RunApprovalModal, RunToolsPreference } from "./components/RunApprovalModal";
import { createRunWorkbench, CURRENT_FILE_OPTION } from "./stores/runs";
import { javaSourceRuntimeAvailable } from "./lib/java-runtime";
import { runOptions as buildRunOptions } from "./lib/run-options";
import { createRunApprovals } from "./stores/run-approvals";
import { ToastStack, NotificationBell } from "./components/Notifications";
import { ProblemsBadge } from "./components/ProblemsBadge";
import { ingestDiagnostics, problemCounts, problemsFor, pruneProblems } from "./stores/problems";
import { notify, notifyError } from "./stores/notifications";
import { isSilenced, SILENCED_WATCH_WARNINGS_KEY, watchWarningNotification, type WatchWarning } from "./lib/watch-recovery";
import { TerminalDock, type TerminalDockController } from "./components/TerminalDock";
import { createTerminalTransport } from "./lib/terminal-transport";
import { ResizeHandle } from "./components/ResizeHandle";
import { AnimatedLogo } from "./components/AnimatedLogo";
import { AssetPreview, isAssetPath, isBinaryAssetPath, isSvgPath } from "./components/AssetPreview";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ToolsSettings } from "./components/ToolsSettings";
import { AgentHealthSettings, AgentStartModeSettings, AgentStartSettings } from "./components/AgentStartSettings";
import { UpdatesSettings } from "./components/UpdatesSettings";
import { agentUpdateError, agentUpdates, agentUpdatesBusy, appUpdate, appUpdateBusy, checkAllUpdates } from "./lib/updates";
import { absolutePath, relativePath, fileName, parentPath, contextMenuPosition, isContextMenuKey } from "./lib/navigation";
import { commonFolder, planStartup } from "./lib/startup-plan";
import { SettingsPage } from "./components/SettingsPage";
import { UsagePage } from "./components/usage/UsagePage";
import { UsageImportSettings } from "./components/usage/UsageImportSettings";
import { afterNextPaint, collectStartupTimings, markStartup, readBootTheme, rememberBootTheme, revealOnce, STARTUP_MARKS, type BootTheme } from "./lib/startup";
import { createSyntaxColorsEffect } from "./editor/syntax-colors-effect";
import { SyntaxColorsSettings } from "./components/SyntaxColorsSettings";
import { createWorkbench, settleIntent, SETTINGS_TAB, isGitTab, gitTabKey, isSettingsBuffer, tabName, type EditorGroup } from "./stores/workbench";
import { AttachmentTab, createAttachmentTabs, type AttachmentTabView } from "./components/attachments";
import { UploadsWorkspace } from "./components/uploads";
import { uploadRecorder, uploadsApi } from "./lib/uploads-app";
import { pdfPageCountWithFallback } from "./lib/office/pdf-loader";
import * as client from "./lib/client";
import { bytesToBase64 } from "./lib/attachments";
import { StorageSettings, type StorageApi } from "./components/StorageSettings";
import { isViewerTab } from "./lib/viewer-tabs";
import { NOT_TEXT_MESSAGE, isKnownBinaryPath, isNotTextError } from "./lib/binary-file";
import { WorkspaceFileView } from "./components/viewer/WorkspaceFileView";
import { revealLabel } from "./components/uploads/upload-model";
import { explorerSystemItems } from "./lib/explorer-menu";
import { explorerDropFolder } from "./lib/explorer-transfer";
import { ImportConflictDialog, PasteNameDialog } from "./components/ExplorerTransferDialogs";
import { canDispatchAction, currentPlatform, dispatchKeyboard, resolveKeybindings, shortcutLabel, shortcutFromEvent, type ActionHandlers, type ActionId } from "./lib/commands";
import { navigationActions, runNavigationAction, setNavigationNotifier, type NavigationActionId } from "./lib/navigation-actions";
import { menuBindingsForFocus, terminalAllowsAppShortcut } from "./lib/terminal-shortcuts";
import { sidebarLayout, terminalHeightLimit, type Sidebar } from "./lib/panel-layout";
import { createZoomController, cssZoomFactor, layoutSize } from "./lib/zoom";
import { createInternalDrag, type InternalDragState } from "./lib/internal-drag";
import { agentPanelElement, droppedPathInfo, internalDropTarget, listenNativeDrops, outsideNotice, planEditorDrop, pointInside, type DroppedPath } from "./lib/native-drop";
import { zoneAt, zoneLabel, zoneStyle, type EditorDropTarget } from "./lib/drop-zones";
import { explorerPreferences } from "./lib/explorer-prefs";
import { api, hubPort, isDesktop, lspPort, previewNotice } from "./lib/client";
import { LanguageServerStatus } from "./components/LanguageServerStatus";
import { LanguageServerSettings } from "./components/LanguageServerSettings";
import { useLanguageServers } from "./stores/language-servers";
import { createLanguageIntelligence } from "./stores/language-intelligence";
import { fileLanguage } from "./lib/language-icons";
import { LanguageIntelligencePanel } from "./components/LanguageIntelligencePanel";
import { LanguageIntelligenceButton } from "./components/LanguageIntelligenceButton";
import { TrustBanner } from "./components/TrustBanner";
import { createZenMode, ZenChrome, ZenModeSettings } from "./components/ZenMode";
import { serverForBuffer, serverLabels } from "./lib/lsp-client";
import { serverOrder } from "./lib/language-intelligence-copy";
import { ChangeSet } from "@codemirror/state";
import { navigationPort } from "./lib/client";
import { classifyLocation } from "./lib/lsp-navigation";
import { LibraryViewer, NavigationLayer, NavigationPanels, NavigationTabs } from "./components/navigation/NavigationLayer";
import { configureNavigation, createSymbolSource, navigationState, openLocation as openNavigationLocation, openSymbol, symbolCrumbs } from "./stores/navigation";
import type { CapabilitiesDto } from "./bindings";
import { createPreviewBinding, noticeFor, withHoverExtras } from "./lib/lsp-hover-binding";
import { previewHoverCapabilities, previewHoverServer } from "./lib/hover-preview";
import type { BindingContext } from "./stores/language-servers";
import type { EditProposal, SyntaxSnapshot, ToolInfo, StartupRequest_Serialize as StartupRequest, StartupFile_Serialize as StartupFile, RecentProject_Serialize as RecentProject } from "./bindings";
import { openFeedFind } from "./lib/feed-find";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/workbench.css";
import "./styles/problems.css";
import "./styles/notifications.css";
import "./styles/panel-handle.css";
import "./styles/internal-drag.css";
import "./styles/file-icons.css";

/** Settings > Storage reads and clears the open workspace's uploads store. */
const storageApi: StorageApi = { usage: client.uploadsUsage, folder: client.uploadsFolder, reveal: client.uploadsRevealFolder, clear: client.uploadsClear };
/** PDF page count for attachment tiles: pdfjs first, then the Rust reader on desktop. */
const countPdfPages = (bytes: Uint8Array) => pdfPageCountWithFallback(bytes, isDesktop ? (data) => client.pdfPageCountNative(bytesToBase64(data)) : undefined);

export default function App() {
  const w = createWorkbench();
  const explorer = createExplorerState(w);
  const languageServers = useLanguageServers(lspPort, { onError: message => w.setError(message), hub: hubPort, onWatchWarning: warning => showWatchWarning(warning) });
  /** A server kept falling behind on file changes after its automatic restarts: offer one click to restart it, or to stop this warning for it. */
  function showWatchWarning(warning: WatchWarning) {
    const silenced = () => w.settings().languageServers?.silencedWatchWarnings;
    if (isSilenced(warning.server, silenced())) return;
    notify(watchWarningNotification(warning, {
      restart: server => languageServers.restart(server),
      silenced,
      saveSilenced: servers => w.updateSettingKey(SILENCED_WATCH_WARNINGS_KEY, servers, "user"),
      onError: error => notifyError(error),
    }));
  }
  const explorerPrefs = () => explorerPreferences(w.settings());
  const setExplorerPreference = (key: string, value: boolean) => void w.updateSettingKey(`explorer.${key}`, value, w.workspace() ? "workspace" : "user").catch(error => w.setError(String(error)));
  const hub = createLanguageIntelligence({ servers: languageServers, activePath: () => { const path = w.activePath(); return path && !isSettingsBuffer(path) ? path : undefined; }, workspaceRoot: () => w.workspace()?.root, autoInstall: () => w.settings().languageServers?.autoInstall ?? true, preview: !isDesktop, setUserSetting: (key, value) => w.updateSettingKey(key, value, "user"), pickPath: hubPort.pickPath, openSettings: () => openSettings() });
  const [hubOpen, setHubOpen] = createSignal(false);
  const [usageOpen, setUsageOpen] = createSignal(false);
  const [hubPlacement, setHubPlacement] = createSignal<"top" | "bottom">("top");
  const activeLanguage = () => { const path = w.activePath(); return path && !isSettingsBuffer(path) ? fileLanguage(w.buffers[path]?.language, hub.view().card?.server) : undefined; };
  let hubTrigger: HTMLElement | undefined;
  const closeHub = (restoreFocus = true) => { setHubOpen(false); if (restoreFocus) hubTrigger?.focus(); };
  const toggleHub = (trigger: HTMLElement) => { if (hubOpen()) closeHub(); else { hubTrigger = trigger; setHubPlacement(trigger.closest(".statusbar") ? "bottom" : "top"); setHubOpen(true); const prompt = hub.view().banner; if (prompt) hub.dismissBanner(prompt.root); } };
  const hubAction: Parameters<typeof LanguageIntelligencePanel>[0]["onAction"] = (action, server) => { if (action === "settings") setHubOpen(false); void hub.perform(action, server).catch(error => w.setError(error instanceof Error ? error.message : String(error))); };
  const hubToggleServer = (server: Parameters<typeof hub.setEnabled>[0], enabled: boolean) => { void hub.setEnabled(server, enabled).catch(error => w.setError(error instanceof Error ? error.message : String(error))); };
  createEffect(on(w.workspaceGeneration, () => { languageServers.pruneDiagnostics(); pruneProblems(); void languageServers.refresh(); }, { defer: true }));
  // The problems badge follows the same publishes as the editor, and forgets a server's files when it stops or restarts.
  { const offDiagnostics = languageServers.onDiagnostics(ingestDiagnostics); const offResets = serverOrder.map(server => languageServers.onReset(server, () => pruneProblems(path => serverForBuffer(path) !== server))); onCleanup(() => { offDiagnostics(); offResets.forEach(off => off()); }); }
  // Diagnostics are replayed only for buffers that are still open.
  createEffect(() => { const open = new Set(Object.keys(w.buffers).filter(path => w.buffers[path])); languageServers.pruneDiagnostics(path => open.has(path)); pruneProblems(path => open.has(path)); });
  const zoom = createZoomController();
  const applyZoom = (operation: () => Promise<void>) => { void operation().catch(error => w.setError(`Window zoom: ${String(error)}`)); };
  const [preferredSidebar, setPreferredSidebar] = createSignal<Sidebar>();
  const [resizingSidebar, setResizingSidebar] = createSignal<Sidebar>();
  const [leftView, setLeftView] = createSignal<"Files" | "Search" | "Git" | "Uploads">("Files");
  /** Editor or Agents layout (ADR 0011 b), remembered per workspace folder. Agents mode replaces the editor area. */
  const [agentMode, setAgentModeState] = createSignal<AgentMode>("editor");
  const agentsMode = () => agentMode() === "agents";
  const setAgentMode = (mode: AgentMode) => { setAgentModeState(mode); writeAgentMode(w.workspace()?.root, mode); };
  createEffect(on(() => w.workspace()?.root, root => setAgentModeState(readAgentMode(root))));
  const [agentsNewRequest, setAgentsNewRequest] = createSignal(0);
  /** The Agents page rail and side panel, per folder: the toolbar toggles and shortcuts act on them in Agents mode. */
  const agentsPanels = createAgentsPanels(() => w.workspace()?.root);
  /**
   * Set when a click on the Agents page opened a file and so switched to Editor mode: the AI sidebar stays hidden until
   * the user shows it, without changing the remembered panel layout. Agents mode itself never shows the sidebar.
   */
  const [assistantHeld, setAssistantHeld] = createSignal(false);
  /** Zen mode: the stored layout stays as it is and the workbench draws `zen.panels()`; panel requests become overlay peeks. */
  const zen = createZenMode({ panels: w.panels, setPanels: w.setPanels, leftView, setLeftView, bottomTab: navigationState.bottomTab, setBottomTab: navigationState.setBottomTab, assistantHeld, setAssistantHeld, agentsMode, assistantOpen: (): boolean => showRight(), activePath: w.activePath, fullscreen: () => fullscreen(), setFullscreen: isDesktop ? on => getCurrentWindow().setFullscreen(on) : undefined, onError: message => w.setError(message) });
  const showLeft = () => zen.active() ? zen.peek().project : sides().project.visible || (!w.panels().projectCollapsed && leftView() === "Uploads");
  const showRight = () => sides().assistant.visible && !agentsMode();
  const showBottom = () => !zen.panels().terminalCollapsed;
  const setShowLeft = (shown: boolean) => { if (zen.requestPanel("project", shown)) return; if (shown) setPreferredSidebar("project"); w.setPanels(p => ({ ...p, projectCollapsed: !shown })); };
  const setShowRight = (shown: boolean) => { if (shown && agentsMode()) return; setAssistantHeld(false); if (shown) setPreferredSidebar("assistant"); w.setPanels(p => ({ ...p, assistantCollapsed: !shown })); };
  const setShowBottom = (shown: boolean) => { if (!zen.requestPanel("terminal", shown)) w.setPanels(p => ({ ...p, terminalCollapsed: !shown })); };
  const [initialized, setInitialized] = createSignal(false);
  // One tab state for the bottom panel: Terminal and Run, plus the References and Hierarchy tabs that navigation opens.
  const bottomTab = navigationState.bottomTab;
  const setBottomTab = navigationState.setBottomTab;
  const navigationBottomTab = () => bottomTab() === "references" || bottomTab() === "hierarchy";
  const [runRequested, setRunRequested] = createSignal(false);
  const [runManagerOpen, setRunManagerOpen] = createSignal(false);
  const [runDraftDirty, setRunDraftDirty] = createSignal(false);
  let saveRunDraft: (() => Promise<boolean>) | undefined;
  let terminalDock: TerminalDockController | undefined;
  const revealTerminal = () => { setBottomTab("terminal"); setShowBottom(true); };
  /** Explorer "Open in Terminal": a new shell in a workspace folder ("" is the root). */
  const openTerminalAt = (folder: string) => {
    const root = w.workspace()?.root;
    if (!root || !terminalDock) { w.setError("Open a folder to start a terminal."); return; }
    try { terminalDock.openAt(absolutePath(folder, root)); } catch (error) { w.setError(String(error instanceof Error ? error.message : error)); }
  };
  function OutputViewTabs() { return <Show when={runs.runs().length > 0 || runRequested() || navigationState.references.status !== "idle" || navigationState.hierarchy.status !== "idle"}><div class="run-view-tabs" role="tablist" aria-label="Output views" onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key) && (runs.runs().length > 0 || runRequested())) { event.preventDefault(); setBottomTab(bottomTab() === "terminal" ? "run" : "terminal"); } }}><button role="tab" aria-selected={bottomTab() === "terminal"} tabIndex={bottomTab() === "terminal" ? 0 : -1} onClick={() => setBottomTab("terminal")}>Terminal</button><Show when={runs.runs().length > 0 || runRequested()}><button role="tab" aria-selected={bottomTab() === "run"} tabIndex={bottomTab() === "run" ? 0 : -1} onClick={() => setBottomTab("run")}>Run</button></Show><NavigationTabs showPanel={() => setShowBottom(true)} /></div></Show>; }
  createEffect(on(bottomTab, tab => { if (tab === "run") queueMicrotask(() => document.querySelector<HTMLButtonElement>('.run-output .run-view-tabs [aria-selected="true"]')?.focus()); }, { defer: true }));
  const runFile = () => { const path = w.activePath(); return path && !isSettingsBuffer(path) ? path : undefined; };
  const runs = createRunWorkbench({ generation: w.workspaceGeneration, root: () => w.workspace()?.root, blocked: w.busy, available: isDesktop, onReveal: () => { setRunRequested(true); setBottomTab("run"); setShowBottom(true); }, activeFile: runFile });
  const launchRun = () => { setRunRequested(true); setBottomTab("run"); setShowBottom(true); const path = runFile(); if (runs.selectedId() === CURRENT_FILE_OPTION && path?.endsWith(".java")) requestJavaRun(path); else void runs.launch(); };
  const runApprovals = createRunApprovals({ generation: w.workspaceGeneration, blocked: w.busy, available: isDesktop });
  const terminalVisible = createMemo(() => showBottom() && bottomTab() === "terminal" && !w.busy());
  const markdownRunner = createMemo(() => isDesktop && initialized() && !w.busy() ? async (request: MarkdownRunRequest) => { if (!terminalDock || request.workspaceRoot !== w.workspace()?.root) throw new Error("A ready terminal in this workspace is required"); await terminalDock.send(request.code, request.action === "run" && !request.detected, request.language); } : undefined);
  createEffect(on(w.workspaceGeneration, () => { setRunRequested(false); setRunManagerOpen(false); setRunDraftDirty(false); saveRunDraft = undefined; }, { defer: true }));
  let layoutElement!: HTMLDivElement;
  const [viewport, setViewport] = createSignal(layoutSize());
  const windowWidth = () => viewport().width;
  const sides = createMemo(() => sidebarLayout({ width: windowWidth(), projectRequested: !zen.active() && !w.panels().projectCollapsed && leftView() !== "Uploads", assistantRequested: !w.panels().assistantCollapsed && !assistantHeld() && !agentsMode(), projectWidth: w.panels().projectWidth, assistantWidth: w.panels().assistantWidth, preferred: preferredSidebar(), resizing: resizingSidebar() }));
  const leftWidth = () => zen.active() ? Math.max(230, Math.min(w.panels().projectWidth, windowWidth() * .42)) : sides().project.width;
  const rightWidth = () => sides().assistant.width;
  const bottomLimit = () => terminalHeightLimit(viewport().height);
  const bottomHeight = () => Math.min(w.panels().terminalHeight, bottomLimit());
  const setLeftWidth = (width: number) => batch(() => { setResizingSidebar("project"); w.setPanels(p => ({ ...p, projectWidth: Math.round(width) })); });
  const setRightWidth = (width: number) => batch(() => { setResizingSidebar("assistant"); w.setPanels(p => ({ ...p, assistantWidth: Math.round(width) })); });
  const setBottomHeight = (height: number) => w.setPanels(p => ({ ...p, terminalHeight: Math.round(height) }));
  const [centerWidth, setCenterWidth] = createSignal(Math.round(window.innerWidth * .48));
  const [splitFraction, setSplitFraction] = createSignal(.5);
  let centerElement!: HTMLDivElement;

  const gitView = createGitView();
  const [gitMergePath, setGitMergePath] = createSignal<string>();
  const [gitMergeResource, setGitMergeResource] = createSignal<GitConflictResource>();
  const [gitMergeLoading, setGitMergeLoading] = createSignal(false);
  const [gitMergeError, setGitMergeError] = createSignal("");
  const [gitMergeDirty, setGitMergeDirty] = createSignal(false);
  const [pendingGitMergeClose, setPendingGitMergeClose] = createSignal(false);
  const [gitBlamePath, setGitBlamePath] = createSignal<string>();
  let saveGitMergeDraft: (() => Promise<boolean>) | undefined;
  let gitMergeRequest = 0;
  const git = createGitWorkbench({ root: () => w.workspace()?.root, generation: w.workspaceGeneration, active: () => showLeft() && leftView() === "Git" || isGitTab(w.activeTab() || ""), blocked: w.busy, available: isDesktop, onOpenView: (key, title) => { w.openGitTab(key, title); }, onOpenWorktreeWindow: async path => { const ctx = git.context(); if (!ctx?.repository) throw new Error("The repository changed."); await api.gitOpenWorktreeWindow(ctx, path); }, onOpenWorkspace: path => applyStartup({ workspaceRoot: path, files: [], impliedRoot: false }), beforeWorkingTreeChange: action => {
    if (!w.hasDirty() && !(gitMergeDirty() && action !== "save conflict resolution")) return true;
    w.setError("Save or close unsaved files before changing the Git working tree.");
    return false;
  }, onWorkingTreeChange: async () => {
    const generation = w.workspaceGeneration();
    await w.checkExternalChanges(true);
    if (generation !== w.workspaceGeneration()) return;
    const paths = [...new Set(w.groups().flatMap(group => group.tabs))].filter(path => !!w.buffers[path] && !isSettingsBuffer(path) && !w.dirty(path));
    await Promise.all(paths.map(path => w.refreshBuffer(path)));
    if (generation !== w.workspaceGeneration()) return;
    await w.checkExternalChanges(true); w.refreshTree();
  }, onOpenFile: path => { const workingPath = workspaceGitPath(git.context(), path); if (workingPath !== undefined) void w.openFile(workingPath); else w.setError("This file is outside the opened folder. Open the repository root to edit it."); } });
  const gitDecorations = createGitDecorations({ git, generation: w.workspaceGeneration,
    paths: () => w.groups().flatMap(group => group.tabs).filter(path => !isSettingsBuffer(path) && path !== SETTINGS_TAB && !isGitTab(path) && !isViewerTab(path)),
    dirtyPaths: () => Object.keys(w.buffers).filter(path => !isSettingsBuffer(path) && w.dirty(path)),
    available: isDesktop, blocked: () => w.busy() || !!git.operation(),
  });
  const gitLineInfo = createGitLineInfo({ git, generation: w.workspaceGeneration, available: isDesktop,
    path: () => { const path = w.activePath(); return path && !isSettingsBuffer(path) ? path : undefined; },
    blocked: () => w.busy() || !!git.operation(),
  });
  const github = createGitHubWorkbench({ git, generation: w.workspaceGeneration, active: () => showLeft() && leftView() === "Git" && gitView.subView() === "github" });
  async function refreshGitConflict(path = gitMergePath()) {
    if (!path) return;
    const request = ++gitMergeRequest; const generation = w.workspaceGeneration(); const repository = git.context()?.repository?.id;
    setGitMergeLoading(true); setGitMergeError("");
    try { const resource = await git.readConflict(path); if (request === gitMergeRequest && generation === w.workspaceGeneration() && repository === git.context()?.repository?.id && path === gitMergePath()) setGitMergeResource(resource); }
    catch (cause) { if (request === gitMergeRequest && generation === w.workspaceGeneration()) setGitMergeError(String(cause)); }
    finally { if (request === gitMergeRequest && generation === w.workspaceGeneration()) setGitMergeLoading(false); }
  }
  function openGitConflict(path: string) {
    if (gitMergeDirty() && gitMergePath() !== path) { w.setError("Save or close the current merge draft before opening another conflict."); return; }
    setGitMergePath(path); setGitMergeResource(undefined); void refreshGitConflict(path);
  }
  const closeGitConflict = () => { if (gitMergeDirty()) setPendingGitMergeClose(true); else { gitMergeRequest++; setGitMergePath(undefined); setGitMergeResource(undefined); } };
  function showGitBlame(path: string) { if (!gitLineInfo.enabled()) gitLineInfo.toggle(); setGitBlamePath(path); }
  async function openBlameCommit(commitId: string, path: string) {
    const ctx = git.context(); if (!ctx?.enabled || !ctx.repository) return;
    const generation = w.workspaceGeneration(); const prefix = ctx.repository.workspacePrefix.replace(/\/$/, ""); const repositoryPath = prefix ? `${prefix}/${path}` : path;
    try {
      const details = await api.gitCommitDetails(ctx, commitId);
      if (generation !== w.workspaceGeneration() || ctx.repository.id !== git.context()?.repository?.id) return;
      git.openDiff(repositoryPath, "commit", details.commit); setGitBlamePath(undefined);
    } catch (cause) { w.setError(String(cause)); }
  }
  const gitReviewIdentity = createMemo(() => `${git.context()?.repository?.id}:${w.workspaceGeneration()}`);
  createEffect(on(gitReviewIdentity, () => { gitMergeRequest++; setGitMergePath(undefined); setGitMergeResource(undefined); setGitMergeLoading(false); setGitMergeDirty(false); setGitMergeError(""); setPendingGitMergeClose(false); setGitBlamePath(undefined); }));
  createEffect(() => { const keys = w.groups().flatMap(group => group.tabs).filter(isGitTab).map(gitTabKey).filter((key): key is string => !!key); git.retainViews(keys); });
  /** The Uploads workspace takes the project panel and editor area; its Explorer tab returns. */
  const uploadsOpen = () => showLeft() && leftView() === "Uploads";
  const [fullscreen, setFullscreen] = createSignal(false);
  const [nativeTrafficLights, setNativeTrafficLights] = createSignal(false);
  const [recentProjects, setRecentProjects] = createSignal<RecentProject[]>([]);
  const [pendingExternal, setPendingExternal] = createSignal<{ request: StartupRequest; resolve: (open: boolean) => void }>();
  const [outsideFiles, setOutsideFiles] = createSignal<{ files: StartupFile[]; folder: string; resolve: (open: boolean) => void }>();
  const [tools, setTools] = createSignal<ToolInfo[]>([]);
  const [toolsBusy, setToolsBusy] = createSignal(false);
  const [toolsLoaded, setToolsLoaded] = createSignal(false);
  const [toolsError, setToolsError] = createSignal("");
  const javaRuntimeAvailable = createMemo(() => javaSourceRuntimeAvailable(tools()));
  const runOptions = createMemo(() => buildRunOptions(runs.catalog(), runs.currentFile(), !!runFile(), isDesktop).map(option => option.kind === "current-file" && runFile()?.endsWith(".java") && !javaRuntimeAvailable() ? { ...option, disabled: true, detail: "A detected JDK 11 or newer is required for Java file mode." } : option));
  const [pendingJavaRun, setPendingJavaRun] = createSignal<{ path: string; generation: number }>();
  createEffect(on(w.activePath, path => {
    if (isDesktop && path?.endsWith(".java") && !toolsLoaded()) void detectTools();
  }));
  createEffect(on(w.workspaceGeneration, () => setPendingJavaRun(undefined), { defer: true }));
  async function runJavaFile(path: string, generation: number) {
    if (generation !== w.workspaceGeneration() || w.busy()) return;
    const revision = w.buffers[path]?.revision;
    setRunRequested(true); setBottomTab("run"); setShowBottom(true);
    try { await runs.launchJava(path, () => generation === w.workspaceGeneration() && w.buffers[path]?.revision === revision && !w.dirty(path) && w.synchronized(path)); }
    catch (cause) { w.setError(String(cause)); setRunManagerOpen(true); }
  }
  function requestJavaRun(path: string) {
    if (w.busy()) return;
    if (!javaRuntimeAvailable()) { runs.setError("A detected JDK 11 or newer is required. Refresh Tools after installing Java."); return; }
    const generation = w.workspaceGeneration();
    if (w.dirty(path)) setPendingJavaRun({ path, generation });
    else void runJavaFile(path, generation);
  }
  async function saveJavaRun() {
    const pending = pendingJavaRun();
    if (!pending || pending.generation !== w.workspaceGeneration()) return;
    if (!await w.save(pending.path)) throw new Error("The Java source could not be saved. Resolve the save error before running.");
    if (pendingJavaRun() !== pending || pending.generation !== w.workspaceGeneration()) return;
    if (w.dirty(pending.path) || !w.synchronized(pending.path)) throw new Error("The source changed during saving. Review it and choose Save and Run again.");
    setPendingJavaRun(undefined);
    await runJavaFile(pending.path, pending.generation);
  }
  type FileAction = { kind: "newFile" | "newFolder" | "rename" | "duplicate" | "trash"; source: string; directory: boolean; initial: string };
  const [fileAction, setFileAction] = createSignal<FileAction>();
  const [fileClipboard, setFileClipboard] = createSignal<{ path: string; directory: boolean; workspace: string; cut: boolean }>();
  type DraggedFile = { path: string; group?: number; generation: number };
  const [internalDrag, setInternalDrag] = createSignal<InternalDragState<DraggedFile, EditorDropTarget | "agent">>();
  const [explorerDropTarget, setExplorerDropTarget] = createSignal<EditorDropTarget>();
  /** True while an Explorer row is dragged over the agent panel. */
  const [explorerOverAgent, setExplorerOverAgent] = createSignal(false);
  const dropTarget = () => { const target = internalDrag()?.target; return explorerDropTarget() ?? (target === "agent" ? undefined : target); };
  /** The agent panel's attach function for Span's own drags, set once the panel mounts. */
  let attachToAgent: ((paths: { path: string; isDir: boolean }[]) => void) | undefined;
  /** The agent panel under a viewport point, when it is shown. */
  const agentAt = (x: number, y: number) => pointInside(agentPanelElement(), { x, y });
  /** Tabs that name a workspace file: settings, Git and viewer tabs are not attachable. */
  const attachableTab = (path: string) => !isSettingsBuffer(path) && !isGitTab(path) && !isViewerTab(path);
  let groupsElement!: HTMLDivElement;
  const [groupsHeight, setGroupsHeight] = createSignal(Math.round(window.innerHeight * .6));
  const stacked = () => w.splitVertical() && w.groups().length > 1;
  const groupsExtent = () => stacked() ? groupsHeight() : centerWidth();
  const [context, setContext] = createSignal<{ x: number; y: number; items: ContextMenuItem[]; label: string }>();
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [quickOpenQuery, setQuickOpenQuery] = createSignal("");
  const [breadcrumbFocus, setBreadcrumbFocus] = createSignal(0);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [recordingShortcut, setRecordingShortcut] = createSignal(false);
  const [terminalFocused, setTerminalFocused] = createSignal(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  const [pendingSettingsClose, setPendingSettingsClose] = createSignal<() => void>();
  let saveSettingsDraft: (() => Promise<boolean>) | undefined;
  let revertSettingsDraft: (() => void) | undefined;
  const [pendingAppClose, setPendingAppClose] = createSignal(false);
  const [proposals, setProposals] = createSignal<EditProposal[]>([]);
  const [proposalBusy, setProposalBusy] = createSignal(false);
  let reviewProposal: ((id: string, hunkIds: string[]) => Promise<void>) | undefined;
  const proposalsChanged = (next: EditProposal[]) => { const prior = new Set(proposals().map(p => p.id)); setProposals(next); const added = next.find(p => !prior.has(p.id)); if (added) void w.openFile(added.path); };
  let allowAppClose = false;
  let closeIntent = 0;
  const cancelClose = () => { closeIntent++; setPendingAppClose(false); };
  let disposed = false;
  let unlistenClose: (() => void) | undefined;
  let unlistenNative: (() => void) | undefined;
  let unlistenResize: (() => void) | undefined;
  let unlistenStartup: (() => void) | undefined;
  let unlistenFormatWarning: (() => void) | undefined;
  let unlistenFocus: (() => void) | undefined;
  let unlistenOpenError: (() => void) | undefined;
  let unlistenNativeDrop: (() => void) | undefined;
  let endPanelDrag: (() => void) | undefined;
  const editorCommands = new Map<string, EditorCommands>();
  const [nativeReady, setNativeReady] = createSignal(false);
  const [nativeActions, setNativeActions] = createSignal<ReadonlySet<ActionId>>(new Set(isDesktop ? ["closeTab"] : []));
  const [cursor, setCursor] = createSignal<EditorCursor>({ line: 1, column: 1, from: 0, to: 0, selectedText: "" });
  const [reveal, setReveal] = createSignal<{ path: string; line: number; column?: number }>();
  // Until the saved session and settings are applied, keep the theme the last run painted with.
  const bootTheme = readBootTheme();
  const [settingsApplied, setSettingsApplied] = createSignal(false);
  const theme = (): BootTheme => (!settingsApplied() && bootTheme) || w.settings().theme.toLowerCase() as BootTheme;
  const platform = currentPlatform();
  const bindings = createMemo(() => resolveKeybindings(w.settings().keybindings, platform));
  const rawKeybindings = createMemo(() => {
    const parsed: unknown = parseJsonc(w.settingsJsonc(), undefined, { allowTrailingComma: true });
    const candidate = parsed && typeof parsed === "object" ? (parsed as { keybindings?: unknown }).keybindings : undefined;
    if (!candidate || typeof candidate !== "object") return {} as Record<string, string[]>;
    return Object.fromEntries(Object.entries(candidate).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(value => typeof value === "string")));
  });
  const bindingSources = createMemo(() => Object.fromEntries(Object.keys(w.scopeSettings().keybindings).map(key => [key, w.settingsScope() === "workspace" && Object.hasOwn(rawKeybindings(), key) ? "Workspace" : "User"])));
  async function updateKeybindings(next: Record<string, string[]>) {
    const previous = w.scopeSettings().keybindings; const scoped = { ...rawKeybindings() };
    for (const command of new Set([...Object.keys(previous), ...Object.keys(next)])) { if (JSON.stringify(previous[command]) === JSON.stringify(next[command])) continue; if (next[command] === undefined) delete scoped[command]; else scoped[command] = next[command]; }
    await w.updateSettings({ keybindings: scoped });
  }
  const shortcut = (id: ActionId) => shortcutLabel(id, bindings(), platform);
  const hasUnsaved = () => w.hasDirty() || settingsDirty() || runDraftDirty() || gitMergeDirty();
  const [agentDraft, setAgentDraft] = createSignal<{ id: number; text: string }>();
  let agentDraftId = 0;
  /** Opens the assistant and puts `text` in its composer. The user reads it and sends it. */
  const askAgent = (text: string) => { if (!agentsMode()) setShowRight(true); setAgentDraft({ id: ++agentDraftId, text }); };
  const selectionContext = () => { const path = w.activePath(); const current = cursor(); return path && !isSettingsBuffer(path) && current.selectedText ? { path, text: current.selectedText, startLine: current.line, endLine: current.line + current.selectedText.split("\n").length - 1 } : undefined; };
  /** Safety net: a URI or a path outside the workspace is library source and must never reach the workspace file commands. */
  const asLibrary = (path: string, line?: number, column?: number, side = false) => {
    if (classifyLocation({ path, external: false }, w.workspace()?.root).kind !== "library") return false;
    const at = { line: Math.max(0, (line ?? 1) - 1), character: Math.max(0, (column ?? 1) - 1) };
    void openNavigationLocation({ path, external: true, displayPath: path, range: { start: at, end: at } }, { side });
    return true;
  };
  const navigate = (path: string, line?: number, column?: number) => { if (asLibrary(path, line, column)) return; const relative = relativePath(path, w.workspace()?.root); void w.openFile(relative).then(() => setReveal(line ? { path: relative, line, column } : undefined)); };
  const navigateToSide = (path: string, line?: number, column?: number) => { if (asLibrary(path, line, column, true)) return; const relative = relativePath(path, w.workspace()?.root); void w.openToSide(relative).then(() => setReveal(line ? { path: relative, line, column } : undefined)); };
  /** The language server store's binding for desktop, the labelled fixture in browser preview, plus the workbench pieces the hover popup uses. */
  const lspBindingFor = (path: string, context: BindingContext) => {
    const base = isDesktop ? languageServers.binding(path, context) : createPreviewBinding(path, context, lspPort);
    if (!base) return undefined;
    return withHoverExtras(base, path, {
      notice: () => { const root = w.workspace()?.root; const server = serverForBuffer(path); const entry = root && server ? languageServers.entryFor(server, `${root.replace(/[\\/]+$/, "")}/${path}`) : undefined; return entry ? noticeFor(entry.state.kind, entry) : undefined; },
      shortcut: id => shortcut(id),
      openExternal: url => api.openExternal(url),
      navigateFile: target => navigate(target.path, target.line, target.column),
      openLocationToSide: location => void openNavigationLocation(location, { side: true }),
      readSource: (location, lines) => navigationPort.readSource(location, lines),
      hoverHint: (_pos, hadResult) => hadResult ? undefined : hub.hoverHint(path),
    });
  };
  let pickingFile = false;
  function focusFiles() {
    batch(() => { setLeftView("Files"); setShowLeft(true); });
    queueMicrotask(async () => {
      if (disposed) return;
      if (w.workspace() && !w.expanded().has("")) await w.toggleDirectory("");
      if (disposed) return;
      const tree = document.querySelector<HTMLElement>('.explorer-panel [role="tree"]');
      const target = tree?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') || tree?.querySelector<HTMLElement>('[role="treeitem"]');
      if (target) target.focus();
      else if (w.workspace()) {
        const newFile = document.querySelector<HTMLButtonElement>('.explorer-header [aria-label="New file"]');
        if (newFile && !newFile.disabled) newFile.focus();
        else if (tree) { tree.tabIndex = -1; tree.focus(); }
      } else document.querySelector<HTMLElement>('.explorer-panel .panel-empty button')?.focus();
    });
  }
  function toggleFiles() {
    if (showLeft() && leftView() === "Files") setShowLeft(false);
    else focusFiles();
  }
  /** Show the Files view, then run an Explorer action once the tree is mounted. */
  async function withFiles(action: () => Promise<void>) {
    batch(() => { setLeftView("Files"); setShowLeft(true); });
    await new Promise<void>(resolve => queueMicrotask(resolve));
    if (disposed || !w.workspace()) return;
    await action();
  }
  function openTemplatePopup() {
    void withFiles(async () => {
      const folder = explorer.creationParent();
      const anchor = document.querySelector<HTMLElement>(`.explorer-panel [role="treeitem"][data-path="${CSS.escape(explorer.focus() ?? "")}"]`) ?? document.querySelector<HTMLElement>(".explorer-panel .explorer-header");
      const box = anchor?.getBoundingClientRect();
      explorer.setTemplateRequest({ folder, x: box ? box.left + 24 : 40, y: box ? box.bottom + 2 : 80 });
    });
  }
  async function openFilePicker() {
    if (pickingFile) return;
    pickingFile = true;
    try {
      const selected = await api.pickFile();
      if (!selected || disposed) return;
      const root = w.workspace()?.root;
      const relative = relativePath(selected, root);
      if (root && !w.busy() && relative && !/^(?:\/|[A-Za-z]:\/)/.test(relative)) await w.openFile(relative);
      // Outside the project (or none open): the plan asks before opening its folder, never switching silently.
      else await applyStartup({ workspaceRoot: null, files: [{ path: selected, line: null, column: null }], impliedRoot: true }, true);
    } catch (error) { if (!disposed) w.setError(`Could not open file: ${String(error)}`); }
    finally { pickingFile = false; }
  }
  const requestWorkspace = () => { if (settingsDirty()) setPendingSettingsClose(() => () => w.requestWorkspace()); else w.requestWorkspace(); };
  const openSettings = () => { w.openSettings(); queueMicrotask(() => document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')?.focus()); };
  async function detectTools() { if (!isDesktop || toolsBusy()) return; setToolsBusy(true); setToolsError(""); try { setTools(await api.listTools()); setToolsLoaded(true); } catch (error) { setToolsError(String(error)); } finally { setToolsBusy(false); } }
  async function revealPath(path: string) { setShowLeft(true); setLeftView("Files"); const parts = relativePath(path, w.workspace()?.root).split("/").slice(0, -1); let current = ""; if (!w.expanded().has("")) await w.toggleDirectory(""); for (const part of parts) { current = current ? `${current}/${part}` : part; if (!w.expanded().has(current)) await w.toggleDirectory(current); } }
  const copyText = async (value: string) => { try { if (isDesktop || typeof navigator.clipboard !== "undefined") await api.writeClipboard(value); else { const previous = document.activeElement as HTMLElement | null; const input = document.createElement("textarea"); input.value = value; input.style.cssText = "position:fixed;opacity:0;pointer-events:none"; document.body.append(input); input.select(); const copied = document.execCommand("copy"); input.remove(); previous?.focus(); if (!copied) throw new Error("Clipboard access is unavailable"); } } catch (error) { w.setError(`Could not copy: ${String(error)}`); } };
  async function refreshRecentProjects() { try { setRecentProjects(await api.recentProjects()); } catch (error) { w.setError(String(error)); } }
  async function performStartup(request: StartupRequest) { const root = request.workspaceRoot; if (root && (!w.workspace() || relativePath(root, w.workspace()?.root) !== "")) await w.openWorkspace(root); for (const file of request.files) { const path = relativePath(file.path, w.workspace()?.root); await w.openFile(path); if (file.line) setReveal({ path, line: file.line, column: file.column || undefined }); } await refreshRecentProjects(); }
  /**
   * Opens a queued request (CLI, second launch, Open File). A request that names only files never switches the
   * project: files inside it open, files outside it are reported. Only an explicit pick (`confirmOutside`) may offer
   * to open their folder, and only after the user says so.
   */
  async function applyStartup(request: StartupRequest, confirmOutside = false) {
    const plan = planStartup(request, w.workspace()?.root);
    if (plan.outside.length) {
      if (plan.open.length) await performStartup({ workspaceRoot: null, files: plan.open, impliedRoot: false });
      const folder = commonFolder(plan.outside);
      if (!confirmOutside) { w.setError(outsideNotice(plan.outside.map(file => ({ path: file.path, name: fileName(file.path), isDir: false, size: 0 })), w.workspace()?.root) ?? ""); return; }
      if (folder && await new Promise<boolean>(resolve => setOutsideFiles({ files: plan.outside, folder, resolve }))) await applyStartup({ workspaceRoot: folder, files: plan.outside, impliedRoot: false });
      return;
    }
    const resolved = { workspaceRoot: plan.switchTo ?? null, files: plan.open, impliedRoot: false };
    if (plan.switchTo && hasUnsaved()) { const open = await new Promise<boolean>(resolve => setPendingExternal({ request: { workspaceRoot: plan.switchTo!, files: plan.open, impliedRoot: false }, resolve })); if (!open) return; }
    await performStartup(resolved);
  }
  function openRecentProject(root: string) { void applyStartup({ workspaceRoot: root, files: [], impliedRoot: false }); }
  function showProjectHistory(event: MouseEvent) { event.preventDefault(); const bounds = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : { left: event.clientX, bottom: event.clientY }; void refreshRecentProjects().then(() => setContext({ x: bounds.left, y: bounds.bottom, label: "Projects", items: [{ id: "open", label: "Open folder…", onSelect: requestWorkspace }, ...recentProjects().map(project => ({ id: project.root, label: `${project.name}${project.missing ? " (missing)" : ""}`, disabled: project.missing, onSelect: () => openRecentProject(project.root) })), { id: "clear", label: "Clear recent projects", separator: true, disabled: !recentProjects().length, onSelect: () => { void api.clearRecentProjects().then(refreshRecentProjects); } }] })); }
  const copyPath = (path: string, absolute = false) => { void copyText(absolute ? absolutePath(path, w.workspace()?.root) : relativePath(path, w.workspace()?.root)); };
  function requestFileAction(kind: FileAction["kind"], source: string, directory = false) {
    const folder = directory ? source : parentPath(source);
    const suggested = kind === "newFile" ? `${folder ? `${folder}/` : ""}new-file.ts` : kind === "newFolder" ? `${folder ? `${folder}/` : ""}new-folder` : kind === "duplicate" ? source.replace(/(\.[^/.]+)?$/, " copy$1") : source;
    setFileAction({ kind, source, directory, initial: suggested });
  }
  /** Editor group and drop zone under a viewport point, shared by tab drags and Explorer drags. */
  function editorTargetAt(x: number, y: number): EditorDropTarget | undefined {
    const element = document.elementFromPoint(x, y);
    let pane = element?.closest<HTMLElement>("[data-editor-group]");
    if (!pane && element?.closest(".settings-view-layer")) pane = [...document.querySelectorAll<HTMLElement>("[data-editor-group]")].find(candidate => { const box = candidate.getBoundingClientRect(); return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom; });
    const group = Number(pane?.dataset.editorGroup);
    if (!pane || !w.groups().some(item => item.id === group)) return undefined;
    return { group, zone: zoneAt(pane.getBoundingClientRect(), x, y) };
  }
  function dropFilesOnEditor(paths: string[], target: EditorDropTarget) {
    for (const path of paths) void w.openInZone(path, target.group, paths.length > 1 && target.zone !== "center" ? "center" : target.zone);
  }
  /**
   * Files and folders dropped from the OS outside the agent panel. A file opens only that file, in the group under
   * the pointer, and only when it is inside the open project: a dropped file never switches the project, never opens
   * its parent folder and never prompts. A lone folder goes through the open request queue, which applies the same
   * unsaved changes guard as Open Folder before switching.
   */
  async function openNativeDrop(paths: string[], x: number, y: number) {
    if (disposed || !paths.length) return;
    const items: DroppedPath[] = [];
    for (const path of paths) { try { items.push(await droppedPathInfo(path)); } catch (error) { w.setError(`Could not open ${fileName(path)}: ${String(error)}`); } }
    const root = w.workspace()?.root;
    const plan = planEditorDrop(items, root);
    if (plan.open.length) {
      const target = editorTargetAt(x, y);
      if (target) dropFilesOnEditor(plan.open, target);
      else for (const path of plan.open) await w.openFile(path);
    }
    const notice = outsideNotice(plan.outside, root) ?? plan.refused;
    if (notice) w.setError(notice);
    if (plan.folder) await api.enqueueDroppedPaths([plan.folder]).catch(error => w.setError(`Could not open the folder: ${String(error)}`));
  }
  const fileDrag = createInternalDrag<DraggedFile, EditorDropTarget | "agent">({
    valid: item => !disposed && !w.busy() && item.generation === w.workspaceGeneration() && (item.group === undefined ? w.files().some(file => file.path === item.path && !file.isDir) : !!w.groups().find(group => group.id === item.group)?.tabs.includes(item.path)),
    targetAt: (x, y) => internalDropTarget(x, y, agentAt, editorTargetAt),
    preview: setInternalDrag,
    drop: (item, target, copy) => {
      if (target === "agent") { if (attachableTab(item.path)) attachToAgent?.([{ path: item.path, isDir: false }]); return; }
      if (!w.groups().some(group => group.id === target.group)) return; if (item.group !== undefined) w.moveTabToZone(item.path, item.group, target.group, target.zone, copy); else void w.openInZone(item.path, target.group, target.zone);
    },
  });
  function startFileDrag(event: PointerEvent, path: string, group?: number) { fileDrag.start(event, { path, group, generation: w.workspaceGeneration() }); }
  createEffect(() => { w.workspaceGeneration(); w.busy(); w.groups().map(group => group.id).join(","); fileDrag.cancel(); });
  onCleanup(fileDrag.dispose);
  /** Language server attached to this file: its label and, once it is ready, what it advertises. */
  const serverInfoFor = (path: string): { label: string; capabilities?: CapabilitiesDto } | undefined => {
    if (!isDesktop) return previewHoverServer(path) ? { label: "preview fixture", capabilities: previewHoverCapabilities } : undefined;
    const server = serverForBuffer(path); const root = w.workspace()?.root;
    if (!server) return undefined;
    const entry = root ? languageServers.entryFor(server, `${root.replace(/[\\/]+$/, "")}/${path}`) : undefined;
    return { label: serverLabels[server], capabilities: entry && entry.enabled && entry.state.kind === "ready" ? entry.capabilities ?? undefined : undefined };
  };
  /** Go to, Peek, References, Rename and Hierarchy, shown first in the editor menu when a language server is attached. */
  function codeIntelligenceItems(path: string): ContextMenuItem[] {
    if (isSettingsBuffer(path) || isGitTab(path) || isViewerTab(path)) return [];
    const info = serverInfoFor(path);
    if (!info) return [];
    const caps = info.capabilities;
    const reason = caps ? `Not supported by ${info.label}` : `${info.label} is not ready`;
    const entry = (id: NavigationActionId, label: string, supported: boolean | undefined, icon?: string, menuId: string = id): ContextMenuItem => ({ id: menuId, label, icon, shortcut: shortcut(id) || undefined, disabled: !supported, disabledReason: reason, onSelect: () => { runNavigationAction(id); } });
    return [
      entry("goToDefinition", "Go to Definition", caps?.definition, "goto-definition"),
      entry("goToTypeDefinition", "Go to Type Definition", caps?.typeDefinition, "goto-type-definition"),
      entry("goToImplementation", "Go to Implementations", caps?.implementation, "goto-implementations"),
      entry("peekReferences", "Go to References", caps?.references, "Link2", "goToReferences"),
      { id: "peek", label: "Peek", icon: "Eye", disabled: !caps, disabledReason: reason, children: [
        entry("peekDefinition", "Peek Definition", caps?.definition),
        entry("peekTypeDefinition", "Peek Type Definition", caps?.typeDefinition),
        entry("peekImplementation", "Peek Implementations", caps?.implementation),
        entry("peekReferences", "Peek References", caps?.references),
      ] },
      entry("findReferences", "Find All References", caps?.references, "menu-search"),
      entry("renameSymbol", "Rename Symbol", caps?.rename, "menu-rename"),
      entry("showCallHierarchy", "Show Call Hierarchy", caps?.callHierarchy, "Hierarchy"),
      entry("showTypeHierarchy", "Show Type Hierarchy", caps?.typeHierarchy, "Hierarchy"),
    ];
  }
  /** Explorer row menu in the design's order: open, new, view, collapse, clipboard, copy path, modify. */
  function explorerMenu(path: string, directory: boolean, at: { x: number; y: number }): ContextMenuItem[] {
    const mac = platform === "mac"; const key = (letter: string) => mac ? `\u2318${letter}` : `Ctrl+${letter}`;
    const picked = explorer.targets(); const many = picked.length > 1;
    const folder = directory ? path : parentPath(path);
    const items: ContextMenuItem[] = [];
    if (directory) items.push({ id: "toggle", label: w.expanded().has(path) ? "Collapse folder" : "Expand folder", icon: "menu-folder", onSelect: () => { void w.toggleDirectory(path); } });
    else items.push({ id: "open", label: many ? `Open ${picked.length} Files` : "Open", icon: "menu-file", onSelect: () => { for (const item of picked.filter(entry => !explorer.isDirectory(entry))) navigate(item); } }, { id: "split", label: "Open to the Side", icon: "split-editor", shortcut: mac ? "\u2318\u21b5" : "Ctrl+Enter", disabled: many, onSelect: () => { void w.openToSide(path); } });
    items.push({ id: "new-file", label: "New File…", icon: "menu-newFile", separator: true, disabled: many, shortcut: shortcut("newFile"), onSelect: () => { void explorer.startCreate("file", folder); } }, { id: "new", label: "New", icon: "menu-newFile", disabled: many, shortcut: shortcut("newFromTemplate"), onSelect: () => { explorer.setTemplateRequest({ folder, x: at.x, y: at.y }); } }, { id: "new-folder", label: "New Folder…", icon: "menu-newFolder", disabled: many, shortcut: shortcut("newFolder"), onSelect: () => { void explorer.startCreate("folder", folder); } });
    if (!directory) items.push({ id: "reveal", label: "Reveal in Files View", icon: "menu-folder", separator: true, onSelect: () => { void explorer.reveal(path); } }, { id: "file-history", label: "Show file history", icon: "Hierarchy", disabled: many || !isDesktop, disabledReason: many ? "Select a single file" : "Requires the desktop app", onSelect: () => showFileHistory(path) });
    if (directory) items.push({ id: "compact-folders", label: explorerPrefs().compactFolders ? "Show folders separately" : "Compact single-child folders", icon: "menu-folder", separator: true, onSelect: () => setExplorerPreference("compactFolders", !explorerPrefs().compactFolders) }, { id: "collapse-all", label: "Collapse All", icon: "menu-folder", shortcut: key("-"), onSelect: () => explorer.collapseAll() }, { id: "auto-reveal", label: explorerPrefs().autoReveal ? "Stop revealing the active file" : "Reveal the active file automatically", icon: "menu-folder", onSelect: () => setExplorerPreference("autoReveal", !explorerPrefs().autoReveal) });
    if (directory) items.push(
      { id: "show-hidden-files", label: explorerPrefs().showHiddenFiles ? "Hide hidden files" : "Show hidden files", icon: "menu-folder", onSelect: () => setExplorerPreference("showHiddenFiles", !explorerPrefs().showHiddenFiles) },
      { id: "show-ignored-files", label: explorerPrefs().showIgnoredFiles ? "Hide ignored files" : "Show ignored files", icon: "menu-folder", onSelect: () => setExplorerPreference("showIgnoredFiles", !explorerPrefs().showIgnoredFiles) },
    );
    const clipboard = explorer.clipboard();
    items.push({ id: "cut-file", label: "Cut", icon: "menu-cut", separator: true, shortcut: key("X"), onSelect: () => explorer.setClip(true) }, { id: "copy-file", label: "Copy", icon: "menu-copy", shortcut: key("C"), onSelect: () => explorer.setClip(false) }, { id: "paste-file", label: "Paste", icon: "menu-paste", shortcut: key("V"), disabled: !clipboard && !isDesktop, onSelect: () => { void explorer.paste(folder); } }, { id: "duplicate", label: "Duplicate", icon: "menu-duplicate", shortcut: key("D"), disabled: many, onSelect: () => { void explorer.duplicate(path); } });
    items.push({ id: "paths", label: "Copy path", icon: "menu-path", separator: true, children: [{ id: "copy-name", label: "Copy filename", icon: "menu-copy", onSelect: () => { void copyText(fileName(path || w.workspace()?.root || "")); } }, { id: "copy-relative", label: "Copy relative path", icon: "menu-path", onSelect: () => copyPath(path) }, { id: "copy-absolute", label: "Copy absolute path", icon: "menu-path", onSelect: () => copyPath(path, true) }] });
    items.push(...explorerSystemItems({ path, directory, many, desktop: isDesktop, revealFolders: true, revealLabel: revealLabel(platform), terminalReady: !!terminalDock && !!w.workspace(), onReveal: target => { void api.revealFile(target).catch(error => w.setError(String(error))); }, onTerminal: openTerminalAt }));
    items.push({ id: "rename", label: "Rename…", icon: "menu-rename", separator: true, disabled: many, shortcut: "F2", onSelect: () => { void explorer.startRename(path); } }, { id: "trash", label: "Move to Trash…", icon: "menu-trash", shortcut: mac ? "\u2318\u232b" : "Delete", onSelect: () => { void explorer.trash(); } });
    return items;
  }
  function showContext(event: MouseEvent | KeyboardEvent, path: string, kind: "file" | "directory" | "tab" | "editor", group = w.activeGroup()) {
    if (isGitTab(path)) { event.preventDefault(); event.stopPropagation(); setContext({ ...contextMenuPosition(event), label: "Git comparison actions", items: [{ id: "close-git", label: "Close comparison", icon: "menu-cancel", onSelect: () => requestCloseTab(path, group) }] }); return; }

    event.preventDefault(); event.stopPropagation(); const position = contextMenuPosition(event); const items: ContextMenuItem[] = kind === "editor" ? codeIntelligenceItems(path) : [];
    if (kind === "file" || kind === "directory") {
      if (!explorer.selection().includes(path)) explorer.selectOnly(path);
      setContext({ ...position, items: explorerMenu(path, kind === "directory", position), label: "File actions" }); return;
    }
    const regular = path !== SETTINGS_TAB && !isSettingsBuffer(path) && !isViewerTab(path); const directory = false; // Explorer rows returned above.
    if (!directory) {
      items.push({ id: "split", label: "Split editor", icon: "split-editor", separator: items.length > 0, children: [{ id: "split-right", label: "Open in split to the right", icon: "split-editor", onSelect: () => { void w.openToSide(path, group); } }, { id: "split-down", label: "Open in split below", icon: "split-editor", onSelect: () => { void w.openToSide(path, group, "down"); } }] });
      if (kind === "tab") items.push({ id: "close", label: "Close tab", icon: "menu-cancel", shortcut: shortcut("closeTab"), onSelect: () => requestCloseTab(path, group) }, { id: "close-group", label: "Close editor group", icon: "menu-cancel", disabled: w.groups().length < 2, onSelect: () => requestCloseGroup(group) });
      items.push({ id: "save", label: "Save file", icon: "menu-save", disabled: !w.buffers[path], shortcut: shortcut("save"), onSelect: () => { void w.save(path); } });
    }
    if (kind === "editor") {
      const controller = editorCommands.get(`${group}:${path}`);
      const clipboardAction = (action: "copy" | "cut" | "paste" | "selectAll") => { if (controller) void Promise.resolve(controller[action]()).catch(error => w.setError(String(error))); };
      items.push({ id: "cut", label: "Cut", icon: "menu-cut", separator: true, disabled: !controller, onSelect: () => clipboardAction("cut") }, { id: "copy", label: "Copy", icon: "menu-copy", disabled: !controller, onSelect: () => clipboardAction("copy") }, { id: "paste", label: "Paste", icon: "menu-paste", disabled: !controller, onSelect: () => clipboardAction("paste") }, { id: "selectAll", label: "Select all", disabled: !controller, onSelect: () => clipboardAction("selectAll") });
      items.push({ id: "find", separator: true, label: "Find in file", icon: "SearchNormal1", shortcut: shortcut("findInFile"), onSelect: () => runEditor("find") }, { id: "goto", label: "Go to line", shortcut: shortcut("goToLine"), onSelect: () => runEditor("goToLine") }, { id: "format", label: "Format document", disabled: isSettingsBuffer(path) || !w.buffers[path], shortcut: shortcut("formatDocument"), onSelect: () => { if (serverInfoFor(path)?.capabilities?.formatting && controller) controller.formatWithLanguageServer(); else void w.format(path); } });
    }
    if (regular) {
      const clipboard = fileClipboard(); const folder = directory ? path : parentPath(path);
      if (kind !== "editor") items.push({ id: "new", label: "New", icon: "menu-newFile", separator: true, children: [{ id: "new-file", label: "New file…", icon: "menu-newFile", disabled: !isDesktop, disabledReason: "Requires the desktop app", onSelect: () => requestFileAction("newFile", path, directory) }, { id: "new-folder", label: "New folder…", icon: "menu-newFolder", disabled: !isDesktop, disabledReason: "Requires the desktop app", onSelect: () => requestFileAction("newFolder", path, directory) }] }, { id: "rename", label: "Rename…", icon: "ActionRename", disabled: !isDesktop || !path, onSelect: () => requestFileAction("rename", path, directory) }, { id: "duplicate", label: "Duplicate…", icon: "menu-duplicate", disabled: !isDesktop || !path, onSelect: () => requestFileAction("duplicate", path, directory) }, { id: "cut-file", label: "Cut file", icon: "menu-cut", separator: true, disabled: !isDesktop || !path, onSelect: () => setFileClipboard({ path, directory, workspace: w.workspace()?.root || "", cut: true }) }, { id: "copy-file", label: "Copy file", icon: "menu-copy", disabled: !isDesktop || !path, onSelect: () => setFileClipboard({ path, directory, workspace: w.workspace()?.root || "", cut: false }) }, { id: "paste-file", label: "Paste file…", icon: "menu-paste", disabled: !isDesktop || !clipboard || clipboard.workspace !== w.workspace()?.root, onSelect: () => { if (clipboard) setFileAction({ kind: clipboard.cut ? "rename" : "duplicate", source: clipboard.path, directory: clipboard.directory, initial: `${folder ? `${folder}/` : ""}${fileName(clipboard.path)}` }); } });
      items.push({ id: "paths", label: "Copy path", icon: "menu-path", separator: true, children: [{ id: "copy-name", label: "Copy filename", icon: "menu-copy", onSelect: () => { void copyText(fileName(path || w.workspace()?.root || "")); } }, { id: "copy-relative", label: "Copy relative path", icon: "menu-path", onSelect: () => copyPath(path) }, { id: "copy-absolute", label: "Copy absolute path", icon: "menu-path", onSelect: () => copyPath(path, true) }] });
      if (!directory) items.push({ id: "reveal", label: "Reveal in project", icon: "menu-folder", onSelect: () => void revealPath(path) }, { id: "file-history", label: "Show file history", icon: "Hierarchy", disabled: !isDesktop, disabledReason: "Requires the desktop app", onSelect: () => showFileHistory(path) });
      if (kind !== "editor") items.push({ id: "trash", label: "Move to Trash…", icon: "menu-trash", separator: true, disabled: !isDesktop || !path, onSelect: () => requestFileAction("trash", path, directory) });
    }
    setContext({ ...position, items, label: kind === "editor" ? "Editor actions" : "File actions" });
  }
  const treeContext = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent && !isContextMenuKey(event)) return; const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]'); const path = row?.getAttribute("title"); if (path !== null && path !== undefined) showContext(event, path, row?.hasAttribute("aria-expanded") ? "directory" : "file"); };
  const openSearch = () => { batch(() => { setShowLeft(true); setLeftView("Search"); }); queueMicrotask(() => document.getElementById("workspace-search")?.focus()); };
  const requestCloseGroup = (group: number) => { if (settingsDirty() && w.groups().find(item => item.id === group)?.tabs.includes(SETTINGS_TAB)) setPendingSettingsClose(() => () => w.closeGroup(group)); else w.closeGroup(group); };
  const requestCloseTab = (path: string, group: number) => { if (path === SETTINGS_TAB && settingsDirty()) setPendingSettingsClose(() => () => w.closeTab(path, group)); else w.closeTab(path, group); };
  const saveActive = () => { if (w.activeTab() === SETTINGS_TAB) { if (settingsDirty()) void saveSettingsDraft?.(); } else void w.save(); };
  function runEditor(command: keyof EditorCommands) {
    if (w.activeTab() === SETTINGS_TAB) { if (command === "find") document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')?.focus(); return; }
    const path = w.activePath(); if (!path) return;
    if (w.isMarkdown(path) && w.markdownView(path) === "preview") w.setMarkdownView(path, "source");
    queueMicrotask(() => editorCommands.get(`${w.activeGroup()}:${path}`)?.[command]());
  }
  function sourceControlTitle() {
    const key = shortcut("showSourceControl");
    return key ? `Show Source Control (${key})` : "Show Source Control";
  }
  /** File context menus and editor actions open Git History scoped to that file. */
  function showFileHistory(path: string) { gitView.showFileHistory(relativePath(path, w.workspace()?.root)); showSourceControl(); }
  function showSourceControl() {
    setAgentMode("editor");
    setShowLeft(true);
    setLeftView("Git");
    queueMicrotask(() => {
      const target = document.querySelector<HTMLElement>('.git-source-control [aria-label="Enable Git"]:not(:disabled), .git-source-control [aria-label="Git commit message"]:not(:disabled)')
        || document.querySelector<HTMLElement>('.git-source-control [aria-label="Refresh Git"]:not(:disabled)')
        || document.querySelector<HTMLElement>(".git-source-control");
      target?.focus();
    });
  }
  /** One place for every panel toggle (toolbar, keyboard, palette, native menu): Agents mode acts on the page panels. */
  function togglePanel(command: PanelCommand) {
    const target = panelTarget(agentMode(), command);
    if (target === "project") setShowLeft(!showLeft());
    else if (target === "assistant") setShowRight(!showRight());
    else if (target === "terminal") setShowBottom(!showBottom());
    else if (target === "rail") agentsPanels.toggleRail();
    else if (target === "side") agentsPanels.toggleSide();
  }
  const handlers: ActionHandlers = {
    quickOpen: () => { setQuickOpenQuery(""); setQuickOpen(true); }, toggleFiles, focusFiles, openFile: () => { void openFilePicker(); }, commandPalette: () => setPaletteOpen(true), findInFile: () => { if (!openFeedFind(document.activeElement)) runEditor("find"); }, searchWorkspace: openSearch, showSourceControl, nextGitChange: () => runEditor("nextGitChange"), previousGitChange: () => runEditor("previousGitChange"), toggleGitBlame: () => gitLineInfo.toggle(),
    settings: openSettings, showUsage: () => setUsageOpen(true), closeTab: () => { if (document.activeElement?.closest(".terminal-dock") && terminalDock) { void terminalDock.closeCurrent().catch(error => w.setError(String(error))); return; } const path = w.activeTab(); if (path) requestCloseTab(path, w.activeGroup()); else requestCloseGroup(w.activeGroup()); }, save: saveActive, openFolder: requestWorkspace,
    splitEditor: () => w.splitEditor(), newFile: () => { if (agentsMode()) setAgentsNewRequest(value => value + 1); else void withFiles(() => explorer.startCreate("file")); }, newFolder: () => { void withFiles(() => explorer.startCreate("folder")); }, newFromTemplate: openTemplatePopup, splitEditorDown: () => w.splitEditor(w.activeGroup(), undefined, "down"), toggleProject: () => togglePanel("toggleProject"), toggleAssistant: () => togglePanel("toggleAssistant"), toggleTerminal: () => togglePanel("toggleTerminal"),
    markdownPreview: () => { const path = w.activePath(); if (path && w.isMarkdown(path)) w.setMarkdownView(path, w.markdownView(path) === "preview" ? "source" : "preview"); },
    formatDocument: () => { void w.format(); }, formatWithLanguageServer: () => runEditor("formatWithLanguageServer"), goToLine: () => runEditor("goToLine"),
    zoomIn: () => applyZoom(zoom.zoomIn), zoomOut: () => applyZoom(zoom.zoomOut), resetZoom: () => applyZoom(zoom.reset),
    toggleWordWrap: () => { void w.updateEffectiveSetting("wordWrap", !w.settings().wordWrap).catch(error => w.setError(String(error))); },
    ...navigationActions,
    focusBreadcrumbs: () => setBreadcrumbFocus(value => value + 1),
    toggleZenMode: zen.toggle,
  };
  // Preview only: every capability on for sample TypeScript files, so the navigation UI can be exercised without a backend.
  const previewCapabilities: CapabilitiesDto = { completion: false, hover: false, definition: true, formatting: false, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, declaration: true, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: true, signatureHelp: false };
  const stopNavigation = configureNavigation({
    port: navigationPort, activePath: () => w.activePath(), workspaceRoot: () => w.workspace()?.root, workspaceGeneration: w.workspaceGeneration,
    revision: path => w.buffers[path]?.revision ?? 0, revisions: () => Object.fromEntries(Object.keys(w.buffers).filter(path => w.buffers[path]).map(path => [path, w.buffers[path].revision])),
    synchronized: path => w.synchronized(path),
    epoch: path => { const server = serverForBuffer(path); const root = w.workspace()?.root; return isDesktop && server && root ? languageServers.entryFor(server, `${root.replace(/[\\/]+$/, "")}/${path}`)?.epoch : undefined; },
    server: path => {
      const server = serverForBuffer(path);
      if (!server) return undefined;
      if (!isDesktop) return /\.(?:ts|tsx|js|jsx)$/.test(path) ? { label: "preview fixture", capabilities: previewCapabilities } : undefined;
      const root = w.workspace()?.root; const entry = root ? languageServers.entryFor(server, `${root.replace(/[\\/]+$/, "")}/${path}`) : undefined;
      return { label: serverLabels[server], capabilities: entry && entry.enabled && entry.state.kind === "ready" ? entry.capabilities ?? undefined : undefined, state: entry ? (entry.enabled ? entry.state.kind : "disabled") : "not started" };
    },
    isReadOnly: path => isSettingsBuffer(path), isOpen: path => !!w.buffers[path], documentText: path => w.documents()[path]?.document,
    open: (path, line, column) => navigate(path, line, column),
    openToSide: (path, line, column) => navigateToSide(path, line, column),
    openFile: async path => { await w.openFile(path); return !!w.buffers[path]; },
    applyEdits: (path, edits) => {
      const document = w.documents()[path]?.document; const buffer = w.buffers[path];
      if (!document || !buffer) return false;
      const changes = edits.map(edit => ({ from: edit.from, to: edit.to, insert: edit.insert })); const changeSet = ChangeSet.of(changes, document.length);
      w.edit(path, { baseRevision: buffer.revision, changes, document: changeSet.apply(document), previousDocument: document, changeSet });
      return true;
    },
    notify: message => w.setError(message), revealBottomPanel: () => setShowBottom(true),
    openQuickOpen: initial => { setQuickOpenQuery(initial); setQuickOpen(true); },
  });
  onCleanup(stopNavigation);
  setNavigationNotifier(message => w.setError(message));
  onCleanup(() => setNavigationNotifier(undefined));
  const isZoomKey = (event: KeyboardEvent) => { const key = shortcutFromEvent(event); return !!key && (["zoomIn", "zoomOut", "resetZoom"] as const).some(action => bindings()[action].includes(key)); };
  const keyboard = (event: KeyboardEvent) => { if (w.busy() && !isZoomKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; } if (!modalAllowsGlobalShortcut(event) && !isZoomKey(event)) return; if ((event.target as Element | null)?.closest(".xterm") && !isZoomKey(event) && !terminalAllowsAppShortcut(event, platform, bindings())) return; if (isAgentModeChord(event, platform)) { event.preventDefault(); event.stopPropagation(); setAgentMode(agentsMode() ? "editor" : "agents"); return; } if (agentsMode() && isRailChord(event, platform)) { event.preventDefault(); event.stopPropagation(); togglePanel("toggleRail"); return; } dispatchKeyboard(event, { bindings: bindings(), handlers, platform, nativeActions: nativeActions() }); };
  function saveSettingsClose() {
    const next = pendingSettingsClose(); if (!next) return Promise.resolve(false);
    return settleIntent(next, current => pendingSettingsClose() === current, async () => await saveSettingsDraft?.() || false, () => { setPendingSettingsClose(undefined); next(); });
  }
  function saveExternalClose() {
    const request = pendingExternal(); if (!request) return Promise.resolve(false);
    return settleIntent(request, current => pendingExternal() === current, async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || pendingExternal() !== request) return false; } if (settingsDirty() && (!await saveSettingsDraft?.() || pendingExternal() !== request)) return false; if (runDraftDirty() && (!await saveRunDraft?.() || pendingExternal() !== request)) return false; if (gitMergeDirty() && (!await saveGitMergeDraft?.() || pendingExternal() !== request)) return false; return !hasUnsaved(); }, () => { request.resolve(true); setPendingExternal(undefined); });
  }
  function saveWindowClose() {
    const intent = closeIntent;
    return settleIntent(intent, current => current === closeIntent && pendingAppClose(), async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || intent !== closeIntent) return false; } if (settingsDirty() && (!await saveSettingsDraft?.() || intent !== closeIntent)) return false; if (runDraftDirty() && (!await saveRunDraft?.() || intent !== closeIntent)) return false; if (gitMergeDirty() && (!await saveGitMergeDraft?.() || intent !== closeIntent)) return false; return !hasUnsaved(); }, () => closeWindow(false, intent));
  }
  const beforeUnload = (event: BeforeUnloadEvent) => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
  async function closeWindow(discard = false, intent = closeIntent) {
    await settleIntent(intent, token => !disposed && token === closeIntent, async () => { await w.persistSession(); if (!discard && hasUnsaved()) { setPendingAppClose(true); return false; } return true; }, async () => { if (!discard && hasUnsaved()) { setPendingAppClose(true); return; } allowAppClose = true; await getCurrentWindow().close(); });
  }
  onMount(() => {
    markStartup(STARTUP_MARKS.shellRendered);
    // The native window starts hidden: show it once the restored session has rendered, or after the cap.
    const revealWindow = revealOnce(() => api.showMainWindow(theme()), 2000);
    applyZoom(zoom.restore);
    const terminalFocus = () => setTerminalFocused(!!document.activeElement?.closest(".xterm"));
    document.addEventListener("focusin", terminalFocus); onCleanup(() => document.removeEventListener("focusin", terminalFocus));
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setCenterWidth(width); });
    observer.observe(centerElement);
    const heights = new ResizeObserver(entries => { const height = entries[0]?.contentRect.height; if (height) setGroupsHeight(height); }); heights.observe(groupsElement); onCleanup(() => heights.disconnect()); onCleanup(() => observer.disconnect());
    const viewportObserver = new ResizeObserver(() => setViewport(layoutSize(layoutElement)));
    viewportObserver.observe(layoutElement); onCleanup(() => viewportObserver.disconnect());
    setViewport(layoutSize(layoutElement));
    window.addEventListener("keydown", keyboard, true); window.addEventListener("beforeunload", beforeUnload); void w.initialize(applyStartup).then(async () => { setInitialized(true); setSettingsApplied(true); markStartup(STARTUP_MARKS.sessionReady); revealWindow(); afterNextPaint(() => void api.reportStartupTimings(collectStartupTimings()).catch(() => undefined)); await refreshRecentProjects(); const unlisten = await api.onOpenWorkspaceRequested(applyStartup); if (disposed) unlisten(); else unlistenStartup = unlisten; });
    if (isDesktop) {
      void api.onWindowFocus(focused => { if (!focused) w.autoSaveWindowBlur(); else void w.checkExternalChanges(true); }).then(unlisten => { if (disposed) unlisten(); else unlistenFocus = unlisten; });
      void api.onOpenRequestError(message => w.setError(message)).then(unlisten => { if (disposed) unlisten(); else unlistenOpenError = unlisten; });
      // OS file drops: the agent panel handles its own (it attaches them); everything else is routed here.
      void listenNativeDrops(drop => { if (drop.kind === "drop" && !agentAt(drop.point.x, drop.point.y) && explorerDropFolder(drop.point, explorer.isDirectory) === undefined) void openNativeDrop(drop.paths, drop.point.x, drop.point.y); }).then(unlisten => { if (disposed) unlisten(); else unlistenNativeDrop = unlisten; }).catch(() => undefined);
      void api.onFormatWarning(warning => w.setError(`Saved ${fileName(warning.path)} without formatting: ${warning.message}`)).then(unlisten => { if (disposed) unlisten(); else unlistenFormatWarning = unlisten; });
      void api.onWindowState(state => { setFullscreen(state.fullscreen); setNativeTrafficLights(state.hasNativeTrafficLights); }).then(unlisten => { if (disposed) unlisten(); else unlistenResize = unlisten; });
      void getCurrentWindow().onCloseRequested(event => { if (allowAppClose) return; event.preventDefault(); closeIntent++; if (hasUnsaved()) setPendingAppClose(true); else void closeWindow(); }).then(unlisten => { if (disposed) unlisten(); else unlistenClose = unlisten; });
      void api.onNativeAction(action => { if (!["zoomIn", "zoomOut", "resetZoom"].includes(action) && (w.busy() || !modalAllowsGlobalShortcut(new KeyboardEvent("keydown")))) return; if (action === "quit") { void getCurrentWindow().close(); return; } if (action === "findInFile" && openFeedFind(document.activeElement)) return; if ((action === "findInFile" && w.activeTab() === SETTINGS_TAB) || canDispatchAction(action, document.activeElement)) handlers[action]?.(); }).then(unlisten => { if (disposed) unlisten(); else { unlistenNative = unlisten; setNativeReady(true); } });
    }
  });
  onCleanup(() => { window.removeEventListener("keydown", keyboard, true); window.removeEventListener("beforeunload", beforeUnload); disposed = true; unlistenClose?.(); unlistenNative?.(); unlistenResize?.(); unlistenStartup?.(); unlistenFormatWarning?.(); unlistenFocus?.(); unlistenOpenError?.(); unlistenNativeDrop?.(); endPanelDrag?.(); });
  createEffect(() => { document.documentElement.dataset.theme = theme(); });
  createEffect(() => { if (settingsApplied()) rememberBootTheme(theme()); });
  createSyntaxColorsEffect(() => document.documentElement, theme, () => w.settings().syntaxColors);
  const configuredZoomLevel = createMemo(() => w.settings().zoomLevel);
  createEffect(on([w.workspaceGeneration, configuredZoomLevel], ([, level], previous) => { if (level !== null) applyZoom(() => zoom.setLevel(level)); else if (previous && previous[1] !== null) applyZoom(zoom.reset); }, { defer: true }));
  // Workspace trust is asked once, when a folder is opened (and when the last one is restored on startup).
  const workspaceTrust = useWorkspaceTrust();
  createEffect(on(() => w.workspace()?.root, root => { if (root) void workspaceTrust.check(root); else workspaceTrust.reset(); }));
  createEffect(on(w.activePath, path => { if (path && explorerPrefs().autoReveal && showLeft() && leftView() === "Files" && !isSettingsBuffer(path)) void explorer.reveal(path, !explorer.selection().includes(path) && explorer.selection().length < 2); }, { defer: true }));
  createEffect(on(w.workspaceGeneration, () => { setFileAction(undefined); fileDrag.cancel(); setContext(undefined); }, { defer: true }));
  // One check per launch, only when the user turned it on in their own settings file (ADR 0004).
  // It waits for the restored session to be on screen so the network calls never compete with startup.
  let launchChecked = false;
  createEffect(() => { if (isDesktop && settingsApplied() && !launchChecked && w.settings().updates?.checkOnLaunch) { launchChecked = true; afterNextPaint(() => void checkAllUpdates()); } });
  let menuSync = 0;
  // Every store error becomes a notification: a short toast now, and an entry in the bell history after.
  createEffect(() => {
    const message = w.error(); if (!message) return;
    const path = untrack(() => w.activePath());
    const failedPath = path && untrack(() => w.failed().has(path)) ? path : undefined;
    notifyError(message, failedPath ? { key: `save-failed:${failedPath}`, actions: [{ label: "Retry", run: () => void w.save(failedPath) }, { label: "Recover draft", run: () => void w.acceptAgentBuffer(failedPath) }] } : {});
    w.setError("");
  });
  createEffect(() => { const keys = bindings(); const recording = recordingShortcut(); const shellFocused = terminalFocused(); if (!isDesktop || !nativeReady()) return; const generation = ++menuSync; void api.syncNativeMenu(menuBindingsForFocus(keys, platform, shellFocused, recording)).then(owned => { if (!disposed && generation === menuSync) setNativeActions(new Set(owned as ActionId[])); }).catch(error => w.setError(String(error))); });

  function PanelHandle(props: { label: string; restoreLabel: string; direction: "horizontal" | "vertical"; value: number; min: number; max: number; collapsed: boolean; automatic?: boolean; overlay?: boolean; shortcut?: string; reverse?: boolean; onResize: (value: number) => void; onShown: (shown: boolean) => void }) {
    let handle!: HTMLDivElement;
    const [dragging, setDragging] = createSignal(false);
    const side = props.direction === "vertical" ? "bottom" : props.reverse ? "right" : "left";
    const tooltipId = `panel-handle-tooltip-${side}`;
    return <div ref={handle} data-panel-side={side} style={props.overlay ? { position: "absolute", top: "0", bottom: "0", "z-index": 21, left: side === "left" ? `${8 + props.value}px` : undefined, right: side === "right" ? `${8 + props.value}px` : undefined } : undefined} class={`resize-handle resize-${props.direction} panel-handle ${props.collapsed ? "collapsed" : ""} ${dragging() ? "dragging" : ""}`} role="separator" aria-label={props.collapsed ? props.restoreLabel : props.label} aria-orientation={props.direction === "horizontal" ? "vertical" : "horizontal"} aria-valuenow={props.collapsed ? 0 : Math.round(props.value)} aria-valuemin={0} aria-valuemax={props.max} tabIndex={0} aria-describedby={tooltipId} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " " || event.key === "Home") { event.preventDefault(); props.onShown(event.key === "Home" ? false : props.collapsed); return; }
      const positive = props.direction === "horizontal" ? event.key === "ArrowRight" : event.key === "ArrowDown";
      const negative = props.direction === "horizontal" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      if (positive || negative) { event.preventDefault(); const delta = (positive ? 1 : -1) * (props.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10); if (props.collapsed) { if (delta > 0) props.onShown(true); } else props.onResize(Math.max(props.min, Math.min(props.max, props.value + delta))); }
    }} onPointerDown={event => {
      if (event.button !== 0) return; endPanelDrag?.(); setDragging(true);
      const start = props.direction === "horizontal" ? event.clientX : event.clientY;
      const remembered = props.value; const initial = props.collapsed ? 0 : props.value; let moved = false; let collapsed = props.collapsed;
      const move = (next: PointerEvent) => { const coordinate = props.direction === "horizontal" ? next.clientX : next.clientY; const raw = initial + (coordinate - start) / cssZoomFactor() * (props.reverse ? -1 : 1); if (Math.abs(coordinate - start) > 3) moved = true;
        if (w.settings().collapsePanelsOnDrag && !collapsed && raw < 64) { collapsed = true; props.onResize(remembered); props.onShown(false); }
        else if (collapsed && raw > 120) { collapsed = false; props.onShown(true); }
        if (!collapsed) props.onResize(Math.max(props.min, Math.min(props.max, raw)));
      };
      const finish = (next?: PointerEvent) => { setDragging(false); if (next?.type === "pointerup" && !moved && props.collapsed) props.onShown(true); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", finish); if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); document.body.style.cursor = ""; document.body.style.userSelect = ""; endPanelDrag = undefined; void w.persistSession(); };
      endPanelDrag = finish; handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish); handle.setPointerCapture(event.pointerId); document.body.style.cursor = props.direction === "horizontal" ? "col-resize" : "row-resize"; document.body.style.userSelect = "none"; event.preventDefault();
    }}><span class="panel-rail-grip" aria-hidden="true"><i /><i /><i /></span><span id={tooltipId} role="tooltip" class="panel-handle-tooltip"><span>{props.collapsed ? props.restoreLabel : props.label}</span><Show when={props.shortcut}><kbd>{props.shortcut}</kbd></Show><span class="panel-handle-hint">{props.automatic ? "Hidden to keep the editor usable. Click to show." : props.collapsed ? "Click or drag" : "Drag to resize"}</span></span></div>;
  }

  function GitDocument(props: { path: string }) {
    const view = () => git.views()[gitTabKey(props.path) || ""];
    const workingPath = () => view()?.path && view()?.repositoryId === git.context()?.repository?.id
      ? workspaceGitPath(git.context(), view()!.path!) : undefined;
    return (
      <Show when={view()} fallback={<div class="git-empty">This Git comparison is no longer available. Reopen it from Source control.</div>}>
        {value => <GitDiffView
          lineReview={value().lineReview}
          lineReviewError={value().lineReviewError}
          lineActionDisabled={!git.ready()}
          onLineAction={async (review, ids, metadata) => { if (!await git.applyReviewedLines(value().key, review, ids, metadata)) throw new Error(git.error() || "The selected changes were not applied. Refresh and review them again."); }}
          hunkData={value().hunkData}
          hunkActionDisabled={!git.ready()}
          onHunkAction={id => void git.applyHunk(value().key, id)}
          actionError={git.error()}
          title={value().title}
          diff={value().diff}
          loading={value().loading}
          refreshDisabled={!git.context()?.enabled}
          error={value().error}
          repositoryRoot={value().repositoryRoot}
          commit={value().commit}
          outsideWorkspace={!!value().path && workingPath() === undefined}
          onRefresh={() => void git.refreshView(value().key)}
          onOpenFile={workingPath() !== undefined ? () => navigate(workingPath()!) : undefined}
        />}
      </Show>
    );
  }
  /** Files that are not text open in the file viewer: never in the editor, never as raw text. */
  function DocumentView(props: { path: string; group: number; active: boolean }) {
    return <Show when={w.binaryFile(props.path)} fallback={<TextDocumentView {...props} />}>{file => <WorkspaceFileView file={file()} readBytes={api.readFileBytes} onOpenWithSystem={isDesktop ? () => api.openFileWithSystem(props.path) : undefined} onReveal={isDesktop ? () => api.revealFile(props.path) : undefined} revealLabel={revealLabel(platform)} />}</Show>;
  }
  function TextDocumentView(props: { path: string; group: number; active: boolean }) {
    const [syntax, setSyntax] = createSignal<SyntaxSnapshot>();
    const markdown = () => w.isMarkdown(props.path);
    const asset = () => isAssetPath(props.path);
    const svg = () => isSvgPath(props.path);
    const view = () => w.markdownView(props.path);
    const assetSource = createMemo(() => { const document = w.documents()[props.path]?.document; return svg() && props.active && view() !== "source" && document && document.length <= 1024 * 1024 ? document.toString() : undefined; });
    const editorActive = () => !w.busy() && props.active && (!(markdown() || asset()) || view() !== "preview");
    const previewActive = () => props.active && view() !== "source";
    createEffect(() => {
      const path = props.path; const doc = w.documents()[path]?.document; const revision = w.buffers[path]?.revision; setSyntax(undefined);
      if (!doc || isSettingsBuffer(path) || !isDesktop || !props.active || ((markdown() || asset()) && view() === "preview")) return;
      const timer = setTimeout(() => { if (!w.synchronized(path)) return; void api.syntax(path).then(result => { if (w.documents()[path]?.document === doc && w.buffers[path]?.revision === revision && result.revision === revision) setSyntax(result); }).catch(() => undefined); }, 100); onCleanup(() => clearTimeout(timer));
    });
    const lspReady = () => { const server = serverForBuffer(props.path); const root = w.workspace()?.root; if (!server || !root) return false; const entry = languageServers.entryFor(server, `${root.replace(/[\\/]+$/, "")}/${props.path}`); return !!entry && entry.enabled && entry.state.kind === "ready"; };
    return <div class="document-view" onContextMenu={event => showContext(event, props.path, "editor", props.group)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, props.path, "editor", props.group); }}><Show when={markdown() || svg()}><div class="markdown-view-toolbar" role="toolbar" aria-label="Markdown view"><SourcePreviewToggle value={view()} onChange={mode => w.setMarkdownView(props.path, mode)} /></div></Show><div class={`document-view-content ${(markdown() || svg()) && view() === "both" ? "markdown-both" : ""}`}>
      <div class="source-view" onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) w.autoSaveEditorBlur(props.path); }} style={{ display: (markdown() || asset()) && view() === "preview" ? "none" : "flex" }}><Show when={w.buffers[props.path]}>{buffer => <Editor onGitReview={side => { const path = gitDecorations.baseline(props.path)?.path; if (path) git.openDiff(path, side); }} gitBlame={gitLineInfo.blame(props.path)} gitBlameEnabled={gitLineInfo.enabled()} gitBaseline={gitDecorations.baseline(props.path)} buffer={buffer()} document={w.documents()[props.path]?.document} change={w.documents()[props.path]?.change} onEdit={edit => w.edit(props.path, edit)} onUndo={() => w.applyHistory(props.path)} onRedo={() => w.applyHistory(props.path, true)} onSave={saveActive} onJavaRun={() => requestJavaRun(props.path)} javaRunAvailable={isDesktop && javaRuntimeAvailable() && props.path.endsWith(".java") && !w.busy()} clipboard={{ readText: api.readClipboard, writeText: api.writeClipboard }} onFormat={() => void w.format(props.path)} lsp={!isSettingsBuffer(props.path) ? lspBindingFor(props.path, { workspaceRoot: () => w.workspace()?.root, getRevision: () => w.buffers[props.path]?.revision ?? 0, isSynchronized: () => w.synchronized(props.path), isActive: editorActive, getWorkspaceGeneration: w.workspaceGeneration, openLocation: location => void openNavigationLocation(location), notify: w.setError }) : undefined} onCommands={commands => { const key = `${props.group}:${props.path}`; if (commands) editorCommands.set(key, commands); else editorCommands.delete(key); }} onCursor={value => { if (props.active) setCursor(value); }} syntax={syntax()} active={editorActive()} readOnly={w.busy() || !!git.operation()} theme={theme()} fontSize={w.settings().fontSize} fontFamily={w.settings().editorFontFamily} tabSize={w.settings().tabSize} wordWrap={w.settings().wordWrap} revealLine={reveal()?.path === props.path ? reveal()?.line : undefined} revealColumn={reveal()?.path === props.path ? reveal()?.column : undefined} proposal={proposals().find(p => p.path === props.path)} proposalBusy={proposalBusy()} proposalStale={!w.synchronized(props.path)} onApplyProposal={(id, ids) => { void reviewProposal?.(id, ids); }} onRejectProposal={id => { void reviewProposal?.(id, []); }} />}</Show><Show when={isDesktop && !isSettingsBuffer(props.path)}><ProblemsBadge path={props.path} problems={problemsFor(props.path)} checked={problemCounts(props.path) !== undefined || lspReady()} onJump={(line, column) => navigate(props.path, line, column)} onAskAgent={askAgent} lineText={line => { const doc = w.documents()[props.path]?.document; return doc && line >= 1 && line <= doc.lines ? doc.line(line).text : undefined; }} /></Show></div>
      <Show when={markdown() || asset()}><div class="preview-view" style={{ display: view() === "source" ? "none" : "flex" }}><Show when={markdown()} fallback={<AssetPreview path={props.path} source={assetSource()} active={previewActive()} loadImage={path => api.readImage(path)} />}><MarkdownPreview onRunCode={markdownRunner()} text={w.documents()[props.path]?.document || ""} documentPath={`${w.workspace()?.root}/${props.path}`} workspaceRoot={w.workspace()?.root || ""} active={previewActive()} onOpenFile={path => navigate(path)} loadImage={path => api.readImage(path)} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} /></Show></div></Show>
    </div></div>;
  }
  function FileOperationDialog(props: { intent: FileAction }) {
    const intent = props.intent; const [target, setTarget] = createSignal(intent.initial);
    const title = intent.kind === "newFile" ? "New file" : intent.kind === "newFolder" ? "New folder" : intent.kind === "rename" ? "Rename" : intent.kind === "duplicate" ? "Duplicate" : "Move to Trash";
    const submit = async () => { const path = target().trim(); if (intent.kind !== "trash" && !path) throw new Error("Enter a name or relative path."); if (intent.kind === "newFile") await w.newFile(path); else if (intent.kind === "newFolder") await w.newDirectory(path); else if (intent.kind === "rename") await w.renamePath(intent.source, path); else if (intent.kind === "duplicate") await w.duplicatePath(intent.source, path); else await w.trashPath(intent.source); if (fileClipboard()?.cut && fileClipboard()?.path === intent.source) setFileClipboard(undefined); if (fileAction() === intent) setFileAction(undefined); };
    return <Modal label={title} class="confirm-modal" onClose={() => setFileAction(undefined)} onSubmit={submit} busy={w.fileOperationBusy()} initialFocus={intent.kind === "trash" ? "[data-modal-cancel]" : "input"}>
      <MenuIcon name={intent.kind === "trash" ? "trash" : intent.directory ? "folder" : "file"} size={28} /><h2>{title}{intent.kind === "trash" ? ` ${fileName(intent.source)}?` : ""}</h2>
      <Show when={intent.kind !== "trash"} fallback={<p>The item will move to the system Trash. Save or discard any unsaved files before continuing.</p>}><label style={{ display: "block", margin: "12px 0 6px" }} for="file-operation-path">Name or relative path</label><input id="file-operation-path" aria-label="Name or relative path" value={target()} onInput={event => setTarget(event.currentTarget.value)} disabled={w.fileOperationBusy()} spellcheck={false} style={{ width: "100%", padding: "8px", border: "1px solid var(--border)", "border-radius": "5px", background: "var(--field)", margin: "0 0 20px" }} /></Show>
      <div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class={intent.kind === "trash" ? "button primary danger" : "button primary"} data-modal-default><MenuIcon name={intent.kind === "trash" ? "trash" : "save"} size={15} />{intent.kind === "newFile" || intent.kind === "newFolder" ? "Create" : title}</button></div>
    </Modal>;
  }
  function SettingsDocument() {
    onCleanup(() => { setSettingsDirty(false); saveSettingsDraft = undefined; revertSettingsDraft = undefined; });
    return <SettingsPage settings={w.scopeSettings()} scope={w.settingsScope()} configuredKeys={w.configuredSettingsKeys()} settingsPath={w.settingsScope() === "user" ? "User settings.jsonc" : ".span/settings.jsonc"} onScopeChange={w.refreshSettingsScope} onReset={w.resetSetting} onOpenJsonc={() => void w.openSettingsJsonc()} settingsJsonc={w.settingsJsonc()} workspaceName={w.workspace()?.name} onChange={w.updateSettings} onSettingChange={(key, value) => w.updateSettingKey(key, value)} onSaveJsonc={w.saveSettingsJsonc} onReloadJsonc={w.reloadSettingsJsonc} onDirtyChange={setSettingsDirty} onSaveReady={save => { saveSettingsDraft = save; }} onRevertReady={revert => { revertSettingsDraft = revert; }} syntaxColors={<SyntaxColorsSettings value={w.scopeSettings().syntaxColors ?? {}} effective={w.settings().syntaxColors ?? {}} scope={w.settingsScope()} activeTheme={theme()} onScopeChange={w.refreshSettingsScope} onChange={(key, value) => w.updateSettingKey(key, value)} clipboard={{ readText: api.readClipboard, writeText: api.writeClipboard }} />} languageServers={<LanguageServerSettings panel={<LanguageIntelligencePanel embedded view={hub.view()} onAction={hubAction} onToggleServer={hubToggleServer} onCopy={text => api.writeClipboard(text)} />} value={w.scopeSettings().languageServers} userValue={w.settings().languageServers} onChange={(key, value, scope) => w.updateSettingKey(key, value, scope === "user" ? "user" : undefined)} />} storage={<StorageSettings desktop={isDesktop} workspaceOpen={!!w.workspace()} api={isDesktop ? storageApi : undefined} />} updates={<UpdatesSettings desktop={isDesktop} busy={appUpdateBusy() || agentUpdatesBusy()} app={appUpdate()} agents={agentUpdates()} agentError={agentUpdateError()} checkOnLaunch={w.settings().updates?.checkOnLaunch ?? false} onCheck={() => checkAllUpdates(true)} onOpenRelease={url => void api.openExternal(url).catch(error => w.setError(String(error)))} />} agentOptions={<><AgentStartSettings enabled={w.settings().agents?.warmStart ?? true} onChange={warmStart => void w.updateSettingKey("agents", { ...w.settings().agents, warmStart }, "user").catch(error => w.setError(String(error)))} /><AgentHealthSettings enabled={w.settings().agents?.healthCheck ?? true} onChange={healthCheck => void w.updateSettingKey("agents", { ...w.settings().agents, healthCheck }, "user").catch(error => w.setError(String(error)))} /><UsageImportSettings enabled={w.settings().agents?.usage?.importLocalLogs ?? true} onChange={importLocalLogs => void w.updateSettingKey("agents", { ...w.settings().agents, usage: { ...w.settings().agents?.usage, importLocalLogs } }, "user").catch(error => w.setError(String(error)))} /><AgentStartModeSettings value={w.settings().agents?.startMode} onChange={startMode => void w.updateSettingKey("agents", { ...w.settings().agents, startMode }, "user").catch(error => w.setError(String(error)))} /></>} tools={<ToolsSettings tools={tools()} desktop={isDesktop} loaded={toolsLoaded()} busy={toolsBusy()} error={toolsError()} onRefresh={detectTools} />} onOpenTools={() => { if (!toolsLoaded()) void detectTools(); }} agentTools={<RunToolsPreference approvals={runApprovals} available={isDesktop} />} onOpenAgents={() => { setShowRight(true); queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('#agent-prompt, [aria-label="Message to agent"]')?.focus()); }} appearanceOptions={<ZenModeSettings value={zen.settings()} onChange={zen.setSettings} shortcut={shortcut("toggleZenMode")} />} shortcuts={<KeyboardSettings scope={w.settingsScope()} bindingSources={bindingSources()} keybindings={w.scopeSettings().keybindings} onChange={updateKeybindings} onRecordingChange={setRecordingShortcut} platform={platform} />} />;
  }
  function EditorPane(props: { group: EditorGroup; width?: number }) {
    const groupId = props.group.id;
    const group = () => w.groups().find(item => item.id === groupId) || { id: groupId, tabs: [] as string[], active: undefined };
    const active = () => group().active;
    const documentIsActive = (path: string) => active() === path && w.activeGroup() === group().id;
    return <section class={`panel editor-pane ${w.activeGroup() === group().id ? "active-group" : ""}`} aria-label={`Editor group ${group().id}`} style={{ flex: props.width ? `0 0 ${props.width}px` : "1 1 0", "box-shadow": dropTarget()?.group === group().id ? "inset 0 0 0 1px var(--accent)" : undefined }} data-editor-group={group().id} onPointerDown={() => w.setActiveGroup(group().id)} onFocusIn={() => w.setActiveGroup(group().id)}>
      <Show when={dropTarget()?.group === group().id ? dropTarget() : undefined}>{target => <div class="drop-zone" data-zone={target().zone} style={zoneStyle(target().zone)} aria-hidden="true" />}</Show>
      <Show when={!zen.active() || zen.chrome().tabs}><div class="editor-header">
        <div class="editor-tabs" role="tablist" aria-label={`Open files in group ${group().id}`}>
          <For each={group().tabs}>{path => <div draggable={false} onPointerDown={event => { if (!(event.target as Element).closest(".tab-close")) startFileDrag(event, path, group().id); }} data-git-status={gitDecorations.status(path)?.kind} class={`file-tab internal-drag-source ${active() === path ? "active" : ""}`} onContextMenu={event => showContext(event, path, "tab", group().id)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, path, "tab", group().id); }}>
            <button role="tab" aria-label={tabName(path)} aria-description={gitDecorations.status(path)?.label} aria-selected={active() === path} aria-controls={`editor-${group().id}`} title={isSettingsBuffer(path) || path === SETTINGS_TAB || isGitTab(path) || isViewerTab(path) ? tabName(path) : path} onClick={() => path === SETTINGS_TAB ? w.openSettings() : void w.openFile(path, group().id)}>
              <Show when={path !== SETTINGS_TAB} fallback={<Icon name="u-gear" size={15} />}>
                <Show when={!isSettingsBuffer(path)} fallback={<Icon name="menu-file" size={15} />}>
                  <Show when={isGitTab(path)} fallback={<FileIcon path={path} />}><Icon name="split-editor" size={15} /></Show>
                </Show>
              </Show>
              <span>{tabName(path)}</span><Show when={gitDecorations.status(path)}>{decoration => <span class="git-path-badge" aria-hidden="true" title={decoration().label}>{decoration().badge}</span>}</Show>
            </button>
            <button class="tab-close" aria-label={`Close ${tabName(path)}`} title={(path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)) ? "Unsaved changes, close file" : "Close file"} onClick={() => requestCloseTab(path, group().id)}>
              <Show when={path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)} fallback={<span class="cross" />}><span class="dirty-dot" /></Show>
            </button>
          </div>}</For>
        </div>
        <Show when={w.groups().length > 1}><button class="icon-button" aria-label={`Close editor group ${group().id}`} title="Close editor group" onClick={() => requestCloseGroup(group().id)}><MenuIcon name="cancel" size={15} /></button></Show>
        <button class="icon-button save-file" aria-label="Save file" title={`Save (${shortcut("save")})`} disabled={!active() || isGitTab(active()!) || isViewerTab(active()!)} onClick={saveActive}><Icon name="TickCircle" size={15} /></button>
        <button class="icon-button split-editor" aria-label="Split editor" disabled={w.groups().length >= 2} title={`Split editor (${shortcut("splitEditor")})`} onClick={() => w.splitEditor()}><Icon name="split-editor" size={15} /></button>
      </div></Show>
      <div id={`editor-${group().id}`} class="editor-documents" role="tabpanel">
        <For each={group().tabs}>{path => <div class="editor-document" style={{ display: active() === path ? "flex" : "none" }}>
          <Show when={isGitTab(path)} fallback={<Show when={path !== SETTINGS_TAB}><Show when={isViewerTab(path)} fallback={<DocumentView path={path} group={group().id} active={documentIsActive(path)} />}><AttachmentTab view={attachmentTabs.view(path)} onClose={() => requestCloseTab(path, group().id)} /></Show></Show>}>
            <GitDocument path={path} />
          </Show>
        </div>}</For>
        <Show when={!active()}><Show when={w.groups().length === 1} fallback={<div class="editor-empty"><h2>No file open</h2><button onClick={() => void openFilePicker()}><span>Open a file</span><Show when={shortcut("openFile")}>{key => <kbd>{key()}</kbd>}</Show></button><button onClick={() => requestCloseGroup(group().id)}>Close group</button></div>}>
          <div class="editor-empty"><AnimatedLogo size={96} /><h1>span</h1><p>A space for code and agents.</p><button onClick={() => void openFilePicker()}><span>Open a file</span><Show when={shortcut("openFile")}>{key => <kbd>{key()}</kbd>}</Show></button><button onClick={requestWorkspace}><span>Open a folder</span><kbd>{shortcut("openFolder")}</kbd></button><Show when={isDesktop}><button onClick={showSourceControl}><span>Clone a repository</span></button></Show><button onClick={openSearch}><span>Search workspace</span><kbd>{shortcut("searchWorkspace")}</kbd></button><button onClick={() => setPaletteOpen(true)}><span>Show commands</span><kbd>{shortcut("commandPalette")}</kbd></button><Show when={recentProjects().length}><div class="welcome-recents"><span>Recent projects</span><For each={recentProjects().slice(0, 5)}>{project => <button disabled={project.missing} title={project.root} onClick={() => openRecentProject(project.root)}><Icon name="Folder2" size={14} /><span>{project.name}</span><Show when={project.missing}><small>Missing</small></Show></button>}</For></div></Show></div>
        </Show></Show>
      </div>
    </section>;
  }
  const settingsGroup = () => w.groups().findIndex(group => group.active === SETTINGS_TAB);
  /** Attachments opened from the agent panel show as viewer tabs. Views are dropped once no group shows them. */
  const attachmentTabs = createAttachmentTabs();
  createEffect(() => attachmentTabs.prune(w.groups().flatMap(group => group.tabs)));
  const openAttachmentTab = (view: AttachmentTabView) => batch(() => w.openViewerTab(attachmentTabs.register(view)));
  const settingsLayerStyle = () => stacked() ? { display: settingsGroup() >= 0 ? "flex" : "none", left: "0px", width: "100%", top: `${(settingsGroup() > 0 ? groupsHeight() * splitFraction() + 4 : 0) + 40}px`, bottom: settingsGroup() === 0 ? `${groupsHeight() * (1 - splitFraction()) + 4}px` : "0px" } : ({ display: settingsGroup() >= 0 ? "flex" : "none", left: `${settingsGroup() > 0 ? centerWidth() * splitFraction() + 4 : 0}px`, width: w.groups().length < 2 ? "100%" : `${settingsGroup() === 0 ? centerWidth() * splitFraction() - 4 : centerWidth() * (1 - splitFraction()) - 4}px` });

  /** Opening a file from the agent shows the editor: in Agents mode it switches to Editor mode first. */
  const openFromAgent = (path: string, line?: number) => { if (agentsMode()) batch(() => { setAssistantHeld(true); setAgentMode("editor"); }); navigate(path, line); };
  /** Opens a file nobody clicked (follow mode, an export): in Agents mode it opens behind the page and the mode stays. */
  const revealFromAgent = (path: string, line?: number) => { if (agentsMode()) navigate(path, line); else openFromAgent(path, line); };
  /** The agent props, as getters so they stay reactive. One controller serves the sidebar and the Agents page. */
  const agentProps: AgentPanelProps = {
    get workspacePath() { return w.workspace()?.root; },
    get workspaceGeneration() { return w.workspaceGeneration(); },
    onProposalsChange: proposalsChanged,
    onReviewInEditor: (path: string, line?: number) => openFromAgent(path, line),
    onReviewReady: review => { reviewProposal = review; },
    onAttachReady: attach => { attachToAgent = attach; },
    get dropHover() { return explorerOverAgent() || internalDrag()?.target === "agent"; },
    onReviewBusyChange: setProposalBusy,
    get activePath() { return isSettingsBuffer(w.activePath() || "") || w.binaryFile(w.activePath() || "") ? undefined : w.activePath(); },
    removeAgent: api.agentRemove,
    get selectionContext() { return selectionContext(); },
    get incomingPrompt() { return agentDraft(); },
    onBufferChanged: (path, snapshot) => void w.acceptAgentBuffer(path, snapshot),
    onOpenSettings: openSettings,
    onOpenFile: (path: string, line?: number) => openFromAgent(path, line),
    onRevealFile: (path: string, line?: number) => revealFromAgent(path, line),
    onFilesChanged: () => w.refreshTree(),
    onOpenExternal: url => void api.openExternal(url).catch(error => w.setError(String(error))),
    get delegationEnabled() { return w.settings().agents?.delegation?.enabled ?? true; },
    get healthCheck() { return w.settings().agents?.healthCheck ?? true; },
    onDelegationChange: enabled => void w.updateSettingKey("agents", { ...w.settings().agents, delegation: { enabled } }, "user").catch(error => w.setError(String(error))),
    onOpenAttachment: openAttachmentTab,
    uploads: uploadRecorder,
    countPdfPages: countPdfPages,
    get folderOutline() { return isDesktop ? client.folderOutline : undefined; },
    get pickFolder() { return isDesktop ? api.pickFolder : undefined; },
  };
  const agent = createAgentController(agentProps);

  return <main class={`ide theme-${theme()} ${isDesktop ? "desktop" : ""} ${fullscreen() ? "is-fullscreen" : ""} ${nativeTrafficLights() ? "native-traffic-lights" : ""} ${zen.classes()}`} style={{ "--ui-font-size": `${w.settings().uiFontSize}px`, "--ui-font-family": w.settings().uiFontFamily, "--editor-font-family": w.settings().editorFontFamily }} aria-label="span editor" aria-busy={w.busy()} inert={w.busy()}>
    <Show when={internalDrag()}>{state => <div class="internal-drag-preview" role="status" aria-live="off" style={{ left: `${(state().x + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px`, top: `${(state().y + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px` }}><FileIcon path={state().item.path} /><span>{tabName(state().item.path)}</span><small>{state().target === undefined ? "No drop target" : state().target === "agent" ? (attachableTab(state().item.path) ? "Attach to AI" : "Cannot attach") : zoneLabel((state().target as EditorDropTarget).zone, state().item.group !== undefined, state().copy && state().item.path !== SETTINGS_TAB)}</small></div>}</Show>
    <header class="topbar" data-tauri-drag-region><div class="top-left"><span class="traffic-lights" aria-hidden="true"><i /><i /><i /></span><Show when={agentsMode()} fallback={<><button class={`icon-button ${showLeft() ? "" : "off"}`} aria-label="Toggle project panel" aria-pressed={showLeft()} title={`Toggle project panel (${shortcut("toggleProject")})`} onClick={() => togglePanel("toggleProject")}><Icon name="panel-left" /></button><button class={`icon-button ${showBottom() ? "" : "off"}`} aria-label="Toggle terminal panel" aria-pressed={showBottom()} title={`Toggle terminal panel (${shortcut("toggleTerminal")})`} onClick={() => togglePanel("toggleTerminal")}><Icon name="panel-bottom" /></button><button class={`icon-button ${showRight() ? "" : "off"}`} aria-label="Toggle AI Assistant panel" aria-pressed={showRight()} title={`Toggle AI Assistant (${shortcut("toggleAssistant")})`} onClick={() => togglePanel("toggleAssistant")}><Icon name="panel-right" /></button></>}><button class={`icon-button agents-toggle ${agentsPanels.railShown() ? "" : "off"}`} aria-label={!agentsPanels.railShown() && agentsPanels.attention() ? "Toggle session list, a session needs you" : "Toggle session list"} aria-pressed={agentsPanels.railShown()} title={`Toggle session list (${platform === "mac" ? RAIL_SHORTCUT.mac : RAIL_SHORTCUT.other})`} onClick={() => togglePanel("toggleRail")}><Icon name="panel-left" /><Show when={!agentsPanels.railShown() && agentsPanels.attention()}><span class="agents-toggle-dot" aria-hidden="true" /></Show></button><button class={`icon-button ${showBottom() ? "" : "off"}`} aria-label="Toggle terminal panel" aria-pressed={showBottom()} title={`Toggle terminal panel (${shortcut("toggleTerminal")})`} onClick={() => togglePanel("toggleTerminal")}><Icon name="panel-bottom" /></button><button class={`icon-button ${agentsPanels.sideOpen() ? "" : "off"}`} aria-label="Toggle side panel" aria-pressed={agentsPanels.sideOpen()} title={`Toggle side panel (${shortcut("toggleProject")})`} onClick={() => togglePanel("toggleAssistant")}><Icon name="panel-right" /></button></Show><span class="toolbar-separator" /><button class="icon-button" aria-label="Open quick open" title={`Go to file (${shortcut("quickOpen")})`} onClick={() => setQuickOpen(true)}><Icon name="goto" /></button><button class="icon-button open-folder-toolbar" aria-label="Open folder" title={`Open folder (${shortcut("openFolder")})`} onClick={requestWorkspace}><Icon name="Folder2" /></button><span class="toolbar-separator" /><AgentModeSwitch mode={agentMode()} onChange={setAgentMode} shortcut={platform === "mac" ? AGENT_MODE_SHORTCUT.mac : AGENT_MODE_SHORTCUT.other} /></div><div class="top-center"><button class="project-title" aria-label="Recent projects" aria-haspopup="menu" onClick={showProjectHistory}>{w.workspace()?.name || "span"}</button><button class="branch-button" aria-label="Source control" title={sourceControlTitle()} onClick={showSourceControl}><Icon name="Hierarchy" size={14} /><span>{git.status()?.repository.branch || (git.status()?.repository.detached ? "Detached HEAD" : "Git")}</span><Show when={git.status()?.entries.length}>{count => <span class="git-branch-dirty" aria-label={`${count()} changed files`}>{count()}</span>}</Show></button></div><div class="top-right"><RunConfigurationSelect options={runOptions()} value={runs.selectedId()} disabled={w.busy() || runs.loading()} running={runs.running()} busy={!!runs.operation()} onSelect={runs.setSelectedId} onManage={() => setRunManagerOpen(true)} onRun={launchRun} onStop={() => void runs.stop()} onOpen={runs.refreshCurrentFile} /><img class="product-logo" src="/span-logo.svg" alt="span" title="span, phase 0.1" /><LanguageIntelligenceButton view={hub.view()} open={hubOpen()} onToggle={toggleHub} /><button class="icon-button" aria-label="Show terminal" title="Show terminal" onClick={revealTerminal}><Icon name="u-play" /></button><button class="icon-button" aria-label="Search workspace" title={`Search workspace (${shortcut("searchWorkspace")})`} onClick={openSearch}><Icon name="SearchNormal1" /></button><button class="icon-button" aria-label="Usage" aria-pressed={usageOpen()} title="Usage: tokens and cost estimates" onClick={() => setUsageOpen(!usageOpen())}><Icon name="Usage" /></button><button class="icon-button" aria-label="Settings" title={`Settings (${shortcut("settings")})`} onClick={openSettings}><Icon name="u-gear" /></button></div></header>
    <ZenChrome zen={zen} title={agentsMode() ? "Agents" : w.activeTab() ? tabName(w.activeTab()!) : "No file open"} path={!agentsMode() && w.activePath() && !isSettingsBuffer(w.activePath()!) ? w.activePath() : undefined} shortcut={shortcut("toggleZenMode")} />
    <ExternalFileConflict state={w.externalReview() ?? w.externalChanges()[w.activePath() ?? ""]} currentText={w.externalReview() ? w.externalReviewText() : w.documents()[w.activePath() ?? ""]?.document.toString() ?? ""} open={!!w.externalReview()} busy={!!w.externalOperation()} onCopy={text => api.writeClipboard(text)} onReview={() => w.reviewExternalFile((w.externalReview() ?? w.externalChanges()[w.activePath() ?? ""])?.path)} onClose={() => w.reviewExternalFile()} onResolve={async action => { const path = (w.externalReview() ?? w.externalChanges()[w.activePath() ?? ""])?.path; if (path) await w.resolveExternalChange(path, action); }} />
    <div class="workbench-main managed-panel-layout" ref={layoutElement}>
      <aside class="panel explorer-panel" onFocusIn={() => setPreferredSidebar("project")} classList={{ "sidebar-overlay": sides().project.overlay || zen.active() }} style={{ "--sidebar-width": `${leftWidth()}px`, width: `${leftWidth()}px`, display: showLeft() && !uploadsOpen() && !agentsMode() ? "flex" : "none" }} aria-label="Project" onContextMenu={treeContext} onKeyDown={treeContext}>
        <div class="panel-header explorer-header">
          <For each={["Files", "Search", "Git", "Uploads"] as const}>{view => <button class={`panel-tab ${leftView() === view ? "selected" : ""}`} aria-label={view} aria-pressed={leftView() === view} title={view === "Git" ? sourceControlTitle() : undefined} onClick={() => { if (view === "Git") showSourceControl(); else { setLeftView(view); if (view === "Search") openSearch(); } }}>{view}<Show when={view === "Git" && git.status()?.entries.length}>{count => <span class="git-total-count">{count()}</span>}</Show></button>}</For>
          <button class="icon-button" aria-label="New file" title="New file" disabled={!w.workspace()} onClick={() => void withFiles(() => explorer.startCreate("file"))}><MenuIcon name="newFile" /></button>
          <button class="icon-button" aria-label="New folder" title="New folder" disabled={!w.workspace()} onClick={() => void withFiles(() => explorer.startCreate("folder"))}><MenuIcon name="newFolder" /></button>
        </div>
        <Explorer gitDecorations={gitDecorations} git={<GitSourceControl github={<GitHubPanel github={github} git={git} onOpenUrl={url => void api.openExternal(url).catch(cause => w.setError(String(cause)))} />} onResolveConflict={openGitConflict} git={git} view={gitView} available={isDesktop} active={showLeft() && leftView() === "Git"} activePath={isSettingsBuffer(w.activePath() || "") ? undefined : w.activePath()} />} workbench={w} state={explorer} view={leftView() === "Uploads" ? "Files" : leftView() as "Files" | "Search" | "Git"} onNavigate={navigate} onOpenToSide={path => { void w.openToSide(path); }} onEditorTarget={editorTargetAt} onEditorPreview={setExplorerDropTarget} onEditorDrop={dropFilesOnEditor} onAgentTarget={agentAt} onAgentPreview={setExplorerOverAgent} onAgentDrop={entries => attachToAgent?.(entries)} nativeDrops={isDesktop} />
      </aside>
      <Show when={!agentsMode()}><PanelHandle label="Resize project panel" restoreLabel="Restore project panel" shortcut={shortcut("toggleProject")} direction="horizontal" value={leftWidth()} min={200} max={sides().project.max} overlay={sides().project.overlay} automatic={!w.panels().projectCollapsed && !showLeft()} collapsed={!showLeft()} onResize={setLeftWidth} onShown={setShowLeft} /></Show>
      <div class="center-area" ref={centerElement}><Show when={hubOpen() ? undefined : hub.view().banner}>{banner => <TrustBanner banner={banner()} onTrust={() => hubAction("trust", banner().server)} onDismiss={() => hub.dismissBanner(banner().root)} />}</Show><div class={`editor-groups ${stacked() ? "stacked" : ""}`} ref={groupsElement}><For each={w.groups().map(group => group.id)}>{(id, index) => <><Show when={index() > 0}><ResizeHandle label="Resize editor groups" direction={stacked() ? "vertical" : "horizontal"} value={groupsExtent() * splitFraction()} min={groupsExtent() * .2} max={groupsExtent() * .8} onResize={size => setSplitFraction(size / groupsExtent())} /></Show><EditorPane group={w.groups().find(group => group.id === id)!} width={w.groups().length > 1 && index() === 0 ? groupsExtent() * splitFraction() - 4 : undefined} /></>}</For><Show when={uploadsOpen()}><div class="uploads-view-layer"><UploadsWorkspace api={uploadsApi} platform={platform} onShowExplorer={() => { setLeftView("Files"); setShowLeft(true); }} /></div></Show><LibraryViewer /><Show when={agentsMode()}><div class="agents-view-layer"><AgentsPage agent={agent} workspaceRoot={w.workspace()?.root} workspaceName={w.workspace()?.name || "No folder"} windowWidth={windowWidth()} onOpenEditor={() => setAgentMode("editor")} onOpenFile={path => openFromAgent(path)} newRequest={agentsNewRequest()} panels={agentsPanels} railShortcut={platform === "mac" ? RAIL_SHORTCUT.mac : RAIL_SHORTCUT.other} searchShortcut={platform === "mac" ? "⌘K" : "Ctrl+K"} newShortcut={shortcut("newFile")} /></div></Show><div class="settings-view-layer" style={settingsLayerStyle()} onFocusIn={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }} onPointerDown={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }}><SettingsDocument /></div></div>
      <PanelHandle label="Resize terminal panel" restoreLabel="Restore terminal panel" shortcut={shortcut("toggleTerminal")} direction="vertical" reverse value={bottomHeight()} min={100} max={bottomLimit()} collapsed={!showBottom()} onResize={setBottomHeight} onShown={setShowBottom} />
      <section class="panel run-bottom-panel" style={{ height: `${bottomHeight()}px`, display: showBottom() ? "flex" : "none" }} aria-label="Workspace output"><div class="run-bottom-content" aria-hidden={bottomTab() !== "run"} inert={bottomTab() !== "run"} style={{ display: bottomTab() === "run" ? "flex" : "none" }}><RunOutput workbench={runs} available={isDesktop} headerStart={<OutputViewTabs />} onHide={() => setShowBottom(false)} /></div><div class="run-bottom-content" aria-hidden={bottomTab() !== "terminal"} inert={bottomTab() !== "terminal"} style={{ display: bottomTab() === "terminal" ? "flex" : "none" }}><Show when={isDesktop && initialized() && w.workspace()} fallback={<><div class="run-preview-toolbar"><OutputViewTabs /><button aria-label="Close terminal panel" onClick={() => setShowBottom(false)}><MenuIcon name="cancel" size={14} /></button></div><div class="terminal-empty" role="region" aria-label="Terminal"><Icon name="u-terminal" size={18} /><span>{isDesktop ? "Open a workspace folder to start a terminal." : "Interactive terminals require the span desktop app. Browser preview does not execute commands."}</span></div></>}><For each={[w.workspaceGeneration()]}>{() => { const transport = createTerminalTransport(w.workspace()?.root || null); return <TerminalDock headerStart={<OutputViewTabs />} visible={terminalVisible()} workspaceRoot={w.workspace()?.root || ""} transport={transport} fontSize={w.settings().fontSize} fontFamily={w.settings().editorFontFamily} onReveal={revealTerminal} onHide={() => setShowBottom(false)} onReady={controller => { terminalDock = controller; }} clipboard={{ readText: api.readClipboard, writeText: api.writeClipboard }} />; }}</For></Show></div><div class="run-bottom-content" aria-hidden={!navigationBottomTab()} inert={!navigationBottomTab()} style={{ display: navigationBottomTab() ? "flex" : "none" }}><div class="run-preview-toolbar"><OutputViewTabs /><button aria-label="Close navigation panel" onClick={() => setShowBottom(false)}><MenuIcon name="cancel" size={14} /></button></div><NavigationPanels /></div></section></div>
      <Show when={!agentsMode()}><PanelHandle label="Resize AI Assistant panel" restoreLabel="Restore AI Assistant panel" shortcut={shortcut("toggleAssistant")} direction="horizontal" reverse value={rightWidth()} min={260} max={sides().assistant.max} overlay={sides().assistant.overlay} automatic={!w.panels().assistantCollapsed && !showRight()} collapsed={!showRight()} onResize={setRightWidth} onShown={setShowRight} /></Show>
      <aside class="panel assistant-panel" onFocusIn={() => setPreferredSidebar("assistant")} classList={{ "sidebar-overlay": sides().assistant.overlay }} style={{ "--sidebar-width": `${rightWidth()}px`, width: `${rightWidth()}px`, display: showRight() && !agentsMode() ? "flex" : "none" }} aria-label="AI Assistant panel"><Show when={!agentsMode()}><AgentPanel {...agentProps} controller={agent} /></Show></aside>
    </div>
    <Show when={runManagerOpen()}><RunConfigurationManager catalog={runs.catalog()} selectedId={runs.selectedId()} available={isDesktop && !!w.workspace()} onSave={runs.save} onDuplicate={runs.duplicate} onDelete={runs.remove} onSelect={runs.setSelectedId} onClose={() => setRunManagerOpen(false)} onDirtyChange={setRunDraftDirty} onSaveReady={save => { saveRunDraft = save; }} agentTools={<RunToolsPreference approvals={runApprovals} available={isDesktop} />} /></Show>
    <Show when={!w.busy() && runApprovals.pending()[0]}>{request => <RunApprovalModal request={request()} queued={runApprovals.pending().length} busy={!!runApprovals.resolving()} error={runApprovals.error()} onResolve={(id, allow) => void runApprovals.resolve(id, allow)} />}</Show>
    <Show when={!zen.active()}><footer class="statusbar"><div class="breadcrumbs"><Show when={w.activePath()} fallback={<span>{w.activeTab() === SETTINGS_TAB ? "Workspace settings" : isViewerTab(w.activeTab() || "") ? "Attachment preview" : w.busy() ? "Opening folder…" : "Ready"}</span>}><Breadcrumbs path={w.activePath()} workspace={w.workspace()} symbols={symbolCrumbs()} onSymbol={symbol => openSymbol(symbol)} focusRequest={breadcrumbFocus()} listDirectory={api.listDirectory} onOpen={path => navigate(path)} onReveal={path => void revealPath(path)} onContextMenu={(event, path, directory) => showContext(event, path, directory ? "directory" : "file")} /></Show></div><div class="status-right"><Show when={!isDesktop}><span class="preview-label" title={previewNotice}>Browser preview</span></Show><GitLineStatus onBlame={showGitBlame} info={gitLineInfo} decorations={gitDecorations} path={w.activePath()} line={cursor().line} text={w.activePath() ? w.documents()[w.activePath()!]?.document.toString() : undefined} onHistory={showFileHistory} /><span>{cursor().line}:{cursor().column}</span><Show when={w.autoSaveFailures().length}><button title="Review Auto Save error" onClick={() => w.setError(w.autoSaveFailures()[0].message)}>Auto Save failed</button></Show><LanguageServerStatus view={hub.view()} language={activeLanguage()} open={hubOpen()} onToggle={toggleHub} /><NotificationBell /><span>UTF-8</span><span class="version-label">span 0.1.0</span></div></footer></Show>
    <Show when={usageOpen()}><UsagePage api={{ summary: client.usageSummary, sessions: client.usageSessions, importScan: client.usageImportScan, importStatus: client.usageImportStatus, blocks: client.usageBlocks }} desktop={isDesktop} importEnabled={w.settings().agents?.usage?.importLocalLogs ?? true} onImportChange={importLocalLogs => w.updateSettingKey("agents", { ...w.settings().agents, usage: { ...w.settings().agents?.usage, importLocalLogs } }, "user")} onClose={() => setUsageOpen(false)} onExport={isDesktop && w.workspace() ? async (name, text) => { const saved = await api.saveAttachment("", name, bytesToBase64(new TextEncoder().encode(text))); void navigate(saved.path); } : undefined} exportUnavailable={isDesktop ? "Open a folder to export usage as CSV" : "Export is available in the desktop app"} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} onOpenSettings={() => { setUsageOpen(false); openSettings(); }} canOpenSession={row => row.agentId === agent.agentId()} onOpenSession={row => { setUsageOpen(false); setAgentMode("agents"); void agent.resumeChat(row.sessionId); }} /></Show>
    <Show when={hubOpen()}><LanguageIntelligencePanel view={hub.view()} fileLanguage={activeLanguage()} placement={hubPlacement()} onAction={hubAction} onToggleServer={hubToggleServer} onClose={closeHub} onOpenSettings={openSettings} onCopy={text => api.writeClipboard(text)} /></Show>
    <ToastStack />
    <Show when={gitMergePath()}>{path => <Modal label={`Resolve conflict: ${path()}`} class="git-review-modal" busy={!!git.operation()} preventCloseWhileBusy onClose={closeGitConflict} initialFocus="#git-merge-result"><div class="git-review-modal-heading"><strong>Resolve conflict</strong><button class="icon-button" aria-label="Close conflict editor" disabled={!!git.operation()} onClick={closeGitConflict}><MenuIcon name="cancel" /></button></div><GitMergeEditor path={path()} resource={gitMergeResource()} loading={gitMergeLoading()} error={gitMergeError() || git.error()} saving={git.operation() === "save conflict resolution"} resolving={git.operation() === "mark resolved"} onDirtyChange={setGitMergeDirty} onSaveReady={save => { saveGitMergeDraft = save; }} onRefresh={() => void refreshGitConflict()} onSave={async (content, reviewed) => { const resource = reviewed ?? gitMergeResource(); if (!resource) return false; const ok = await git.saveConflict(path(), content, resource.state.status.indexRevision, resource.state.worktreeSnapshot); if (ok) await refreshGitConflict(); return ok; }} onMarkResolved={async reviewed => { const resource = reviewed ?? gitMergeResource(); if (!resource) return false; const ok = await git.markResolved(path(), resource.state); if (ok) { setGitMergeDirty(false); setGitMergePath(undefined); setGitMergeResource(undefined); } return ok; }} /></Modal>}</Show>
    <Show when={pendingGitMergeClose()}><Modal label="Unsaved merge resolution" class="confirm-modal" initialFocus="[data-modal-cancel]" onClose={() => setPendingGitMergeClose(false)}><h2>Save this merge draft?</h2><p>Your edited result has not been saved to the working file.</p><div class="dialog-actions"><button class="button" onClick={() => { setPendingGitMergeClose(false); setGitMergeDirty(false); gitMergeRequest++; setGitMergePath(undefined); setGitMergeResource(undefined); }}>Discard draft</button><span /><button class="button" data-modal-cancel>Keep editing</button><button class="button primary" disabled={!!git.operation()} onClick={async () => { if (await saveGitMergeDraft?.()) { setPendingGitMergeClose(false); setGitMergePath(undefined); setGitMergeResource(undefined); } }}>Save and close</button></div></Modal></Show>
    <Show when={gitBlamePath()}>{path => <Modal label="File blame" class="git-review-modal" onClose={() => setGitBlamePath(undefined)}><GitBlameView info={gitLineInfo} decorations={gitDecorations} path={path()} text={w.documents()[path()]?.document.toString()} onCommit={(commitId, file) => void openBlameCommit(commitId, file)} onHistory={file => { showFileHistory(file); setGitBlamePath(undefined); }} onClose={() => setGitBlamePath(undefined)} /></Modal>}</Show>
    <Show when={quickOpen()}><QuickOpen initialQuery={quickOpenQuery()} symbols={createSymbolSource()} onQueryFiles={w.queryFiles} indexStatus={w.indexStatus()} indexError={w.indexError()} discoveryRevision={w.discoveryRevision()} workspaceGeneration={w.workspaceGeneration()} files={w.files()} onOpen={navigate} onClose={() => setQuickOpen(false)} onOpenFolder={requestWorkspace} workspace={w.workspace()} activePath={isSettingsBuffer(w.activePath() || "") ? undefined : w.activePath()} recentPaths={w.recentPaths()} handlers={handlers} bindings={bindings()} onPreview={async path => { const document = w.documents()[path]?.document; if (document) return document.sliceString(0, 64 * 1024); if (isBinaryAssetPath(path)) return "Image preview is available when opened."; if (w.binaryFile(path) || isKnownBinaryPath(path)) return NOT_TEXT_MESSAGE; try { return (await api.peekBuffer(path)).text.slice(0, 64 * 1024); } catch (error) { if (isNotTextError(error)) return NOT_TEXT_MESSAGE; throw error; } }} onSearch={api.search} /></Show>
    <NavigationLayer line={cursor().line} column={cursor().column} />
    <WorkspaceTrustDialog trust={workspaceTrust} root={() => w.workspace()?.root} />
    <Show when={fileAction()}>{intent => <FileOperationDialog intent={intent()} />}</Show>
    <Show when={context()}>{menu => <ContextMenu x={menu().x} y={menu().y} items={menu().items} label={menu().label} onClose={() => setContext(undefined)} />}</Show>
    <Show when={paletteOpen()}><CommandPalette bindings={bindings()} handlers={handlers} onClose={() => setPaletteOpen(false)} platform={platform} /></Show>
    <Show when={pendingSettingsClose()}>{action => <Modal label="Unsaved settings" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveSettingsClose} onClose={() => setPendingSettingsClose(undefined)}><h2>Save changes to workspace settings?</h2><p>Your JSONC draft has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { const next = action(); revertSettingsDraft?.(); setPendingSettingsClose(undefined); next(); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save</button></div></Modal>}</Show>
    <Show when={pendingExternal()}>{pending => <Modal label="Open requested project" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveExternalClose} onClose={() => { pending().resolve(false); setPendingExternal(undefined); }}><h2>Open another project?</h2><p>A file or command-line request wants to open {pending().request.workspaceRoot}. This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { revertSettingsDraft?.(); pending().resolve(true); setPendingExternal(undefined); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save all</button></div></Modal>}</Show>
    <Show when={outsideFiles()}>{pending => <Modal label="File outside the open folder" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={() => { pending().resolve(true); setOutsideFiles(undefined); }} onClose={() => { pending().resolve(false); setOutsideFiles(undefined); }}><h2>Open {fileName(pending().files[0].path)}{pending().files.length > 1 ? ` and ${pending().files.length - 1} more` : ""}?</h2><p>Span edits files inside the open folder, and {pending().files.length > 1 ? "these files are" : "this file is"} outside it. Your current project stays open unless you switch to {pending().folder}.</p><div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Keep current project</button><button class="button primary" data-modal-default>Open that folder</button></div></Modal>}</Show>
    <Show when={explorer.templateRequest()}>{request => <NewPopup request={request()} where={request().folder ? fileName(request().folder) : (w.workspace()?.name ?? "project")} onClose={() => { explorer.setTemplateRequest(undefined); queueMicrotask(() => document.querySelector<HTMLElement>('.explorer-panel [role="treeitem"]')?.focus()); }} onPick={id => { const folder = request().folder; explorer.setTemplateRequest(undefined); void explorer.startTemplate(id, folder); }} />}</Show>
    <Show when={(() => { const d = explorer.dialog(); return d?.kind === "import-conflict" ? d : undefined; })()}>{d => <ImportConflictDialog folder={d().folder} name={d().name} remaining={d().remaining} project={w.workspace()?.name ?? "project"} resolve={d().resolve} />}</Show>
    <Show when={(() => { const d = explorer.dialog(); return d?.kind === "paste-name" ? d : undefined; })()}>{d => <PasteNameDialog folder={d().folder} pasted={d().pasted} value={d().value} project={w.workspace()?.name ?? "project"} resolve={d().resolve} />}</Show>
    <Show when={explorer.dialog()}>{dialog => <Show when={dialog().kind === "conflict" ? (dialog() as Extract<ReturnType<typeof explorer.dialog> & object, { kind: "conflict" }>) : undefined} fallback={<Show when={dialog().kind === "delete" ? (dialog() as Extract<ReturnType<typeof explorer.dialog> & object, { kind: "delete" }>) : undefined}>{del => <Modal label="Delete" class="confirm-modal" initialFocus="[data-modal-default]" onClose={() => del().resolve(false)} onSubmit={() => { del().resolve(true); }}><h2>{del().paths.length === 1 ? `Are you sure you want to delete '${fileName(del().paths[0])}'?` : `Are you sure you want to delete the following ${del().paths.length} items?`}</h2><Show when={del().paths.length > 1}><ul class="dialog-list">{del().paths.map(path => <li>{fileName(path)}</li>)}</ul></Show><p>You can restore {del().paths.length === 1 ? "it" : "them"} from the Trash.</p><div class="dialog-actions"><span /><button class="button" data-modal-cancel>Cancel</button><button class="button primary danger" data-modal-default onClick={() => del().resolve(true)}>Move to Trash</button></div></Modal>}</Show>}>{conflict => <Modal label="File conflict" class="confirm-modal" initialFocus="[data-modal-default]" onClose={() => conflict().resolve("cancel")} onSubmit={() => { conflict().resolve("keep"); }}><h2>{conflict().names.length === 1 ? `A file or folder named '${conflict().names[0]}' already exists in '${conflict().folder ? fileName(conflict().folder) : (w.workspace()?.name ?? "project")}'.` : `${conflict().names.length} items already exist in '${conflict().folder ? fileName(conflict().folder) : (w.workspace()?.name ?? "project")}'.`}</h2><Show when={conflict().names.length > 1}><ul class="dialog-list">{conflict().names.map(name => <li>{name}</li>)}</ul></Show><p>Replace overwrites the existing {conflict().names.length === 1 ? "item" : "items"}. Keep Both adds "copy" to the name of the moved {conflict().names.length === 1 ? "item" : "items"}.</p><div class="dialog-actions"><button class="button" data-modal-cancel>Cancel</button><span /><button class="button primary" data-modal-default onClick={() => conflict().resolve("keep")}>Keep Both</button><button class="button danger" onClick={() => conflict().resolve("replace")}>Replace</button></div></Modal>}</Show>}</Show>
    <Show when={pendingJavaRun()}>{pending => <Modal label="Save Java source before running" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveJavaRun} onClose={() => setPendingJavaRun(undefined)}><h2>Save {tabName(pending().path)} before running?</h2><p>Java runs this saved file in standalone mode. Project build steps and dependencies are not applied. Save your current changes and run its main method.</p><div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default><MenuIcon name="save" size={15} />Save and Run</button></div></Modal>}</Show>
    <Show when={w.pendingClose()}>{pending => <Modal label="Unsaved changes" class="confirm-modal" onClose={() => void w.confirmClose("cancel")} onSubmit={() => w.confirmClose("save")} busy={w.closeBusy()} preventCloseWhileBusy={w.externalAbandoning()} initialFocus="[data-modal-default]"><Icon name="DocumentText" size={28} /><h2>Save changes to {tabName(pending().path)}?</h2><p>Your changes will be lost if you close this file without saving.</p><div class="dialog-actions"><button class="button" onClick={() => void w.confirmClose("discard")}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default><MenuIcon name="save" size={15} />Save</button></div></Modal>}</Show>
    <Show when={pendingAppClose()}><Modal label="Close span" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveWindowClose} onClose={cancelClose}><h2>Save changes before closing?</h2><p>This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { void closeWindow(true); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save all</button></div></Modal></Show>
    <Show when={w.pendingRecovery()}>{recovery => <Modal label="Retained local draft" class="confirm-modal" onClose={() => w.resolveRecovery(false)}><h2>Your newer local draft was retained</h2><p>The current accepted document is open in {recovery().path.split("/").pop()}. You can keep it or restore your local draft for review.</p><div class="dialog-actions"><button class="button" onClick={() => w.resolveRecovery(false)}>Keep current document</button><span /><button class="button primary" data-modal-default onClick={() => w.resolveRecovery(true)}>Restore my draft</button></div></Modal>}</Show>
    <Show when={w.pendingWorkspace()}><Modal label="Open another folder" class="confirm-modal" onClose={() => w.setPendingWorkspace(false)}><h2>Open another folder?</h2><p>There are unsaved changes in this workspace. Discard them to open another folder.</p><div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default onClick={() => { w.setPendingWorkspace(false); void w.openWorkspace(); }}>Discard and open folder</button></div></Modal></Show>
  </main>;
}
