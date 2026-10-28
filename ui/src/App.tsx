import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { parse as parseJsonc } from "jsonc-parser";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor, type EditorCommands, type EditorCursor } from "./components/Editor";
import AgentPanel from "./components/AgentPanel";
import { Explorer } from "./components/Explorer";
import Icon, { FileIcon, MenuIcon } from "./components/Icon";
import { Modal, modalAllowsGlobalShortcut } from "./components/Modal";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardSettings } from "./components/KeyboardSettings";
import { SourcePreviewToggle } from "./components/SourcePreviewToggle";
import { MarkdownPreview } from "./components/MarkdownPreview";
import { ResizeHandle } from "./components/ResizeHandle";
import { AnimatedLogo } from "./components/AnimatedLogo";
import { AssetPreview, isAssetPath, isBinaryAssetPath, isSvgPath } from "./components/AssetPreview";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ToolsSettings } from "./components/ToolsSettings";
import { absolutePath, relativePath, fileName, parentPath, contextMenuPosition, isContextMenuKey } from "./lib/navigation";
import { SettingsPage } from "./components/SettingsPage";
import { createWorkbench, settleIntent, SETTINGS_TAB, isSettingsBuffer, tabName, type EditorGroup } from "./stores/workbench";
import { canDispatchAction, currentPlatform, dispatchKeyboard, nativeMenuBindings, resolveKeybindings, shortcutLabel, shortcutFromEvent, type ActionHandlers, type ActionId } from "./lib/commands";
import { createZoomController } from "./lib/zoom";
import { createInternalDrag, type InternalDragState } from "./lib/internal-drag";
import { compactFolders, setCompactFolders } from "./lib/explorer-prefs";
import { api, isDesktop, lspPort, previewNotice } from "./lib/client";
import { LanguageServerStatus } from "./components/LanguageServerStatus";
import { LanguageServerSettings } from "./components/LanguageServerSettings";
import { useLanguageServers } from "./stores/language-servers";
import { serverForBuffer } from "./lib/lsp-client";
import type { EditProposal, SyntaxSnapshot, ToolInfo, StartupRequest_Serialize as StartupRequest, RecentProject_Serialize as RecentProject } from "./bindings";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/workbench.css";
import "./styles/panel-handle.css";
import "./styles/internal-drag.css";
import "./styles/file-icons.css";

export default function App() {
  const w = createWorkbench();
  const languageServers = useLanguageServers(lspPort, { onError: message => w.setError(message) });
  createEffect(on(w.workspaceGeneration, () => { languageServers.pruneDiagnostics(); void languageServers.refresh(); }, { defer: true }));
  // Diagnostics are replayed only for buffers that are still open.
  createEffect(() => { const open = new Set(Object.keys(w.buffers).filter(path => w.buffers[path])); languageServers.pruneDiagnostics(path => open.has(path)); });
  const zoom = createZoomController();
  const applyZoom = (operation: () => Promise<void>) => { void operation().catch(error => w.setError(`Window zoom: ${String(error)}`)); };
  const showLeft = () => !w.panels().projectCollapsed;
  const showRight = () => !w.panels().assistantCollapsed;
  const showBottom = () => !w.panels().terminalCollapsed;
  const setShowLeft = (shown: boolean) => w.setPanels(p => ({ ...p, projectCollapsed: !shown }));
  const setShowRight = (shown: boolean) => w.setPanels(p => ({ ...p, assistantCollapsed: !shown }));
  const setShowBottom = (shown: boolean) => w.setPanels(p => ({ ...p, terminalCollapsed: !shown }));
  const [windowWidth, setWindowWidth] = createSignal(window.innerWidth);
  const leftWidth = () => Math.min(w.panels().projectWidth, windowWidth() * .42);
  const rightWidth = () => Math.min(w.panels().assistantWidth, windowWidth() * .42);
  const bottomHeight = () => Math.min(w.panels().terminalHeight, window.innerHeight * .7);
  const setLeftWidth = (width: number) => w.setPanels(p => ({ ...p, projectWidth: Math.round(width) }));
  const setRightWidth = (width: number) => w.setPanels(p => ({ ...p, assistantWidth: Math.round(width) }));
  const setBottomHeight = (height: number) => w.setPanels(p => ({ ...p, terminalHeight: Math.round(height) }));
  const [centerWidth, setCenterWidth] = createSignal(Math.round(window.innerWidth * .48));
  const [splitFraction, setSplitFraction] = createSignal(.5);
  let centerElement!: HTMLDivElement;
  const [leftView, setLeftView] = createSignal<"Files" | "Search" | "Git" | "History">("Files");
  const [fullscreen, setFullscreen] = createSignal(false);
  const [nativeTrafficLights, setNativeTrafficLights] = createSignal(false);
  const [recentProjects, setRecentProjects] = createSignal<RecentProject[]>([]);
  const [pendingExternal, setPendingExternal] = createSignal<{ request: StartupRequest; resolve: (open: boolean) => void }>();
  const [tools, setTools] = createSignal<ToolInfo[]>([]);
  const [toolsBusy, setToolsBusy] = createSignal(false);
  const [toolsLoaded, setToolsLoaded] = createSignal(false);
  const [toolsError, setToolsError] = createSignal("");
  type FileAction = { kind: "newFile" | "newFolder" | "rename" | "duplicate" | "trash"; source: string; directory: boolean; initial: string };
  const [fileAction, setFileAction] = createSignal<FileAction>();
  const [fileClipboard, setFileClipboard] = createSignal<{ path: string; directory: boolean; workspace: string; cut: boolean }>();
  type DraggedFile = { path: string; group?: number; generation: number };
  const [internalDrag, setInternalDrag] = createSignal<InternalDragState<DraggedFile>>();
  const dropGroup = () => internalDrag()?.target;
  const [context, setContext] = createSignal<{ x: number; y: number; items: ContextMenuItem[]; label: string }>();
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [recordingShortcut, setRecordingShortcut] = createSignal(false);
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
  let endPanelDrag: (() => void) | undefined;
  const editorCommands = new Map<string, EditorCommands>();
  const [nativeReady, setNativeReady] = createSignal(false);
  const [nativeActions, setNativeActions] = createSignal<ReadonlySet<ActionId>>(new Set(isDesktop ? ["closeTab"] : []));
  const [cursor, setCursor] = createSignal<EditorCursor>({ line: 1, column: 1, from: 0, to: 0, selectedText: "" });
  const [reveal, setReveal] = createSignal<{ path: string; line: number; column?: number }>();
  const theme = () => w.settings().theme.toLowerCase() as "dark" | "light" | "purple";
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
  const hasUnsaved = () => w.hasDirty() || settingsDirty();
  const selectionContext = () => { const path = w.activePath(); const current = cursor(); return path && !isSettingsBuffer(path) && current.selectedText ? { path, text: current.selectedText, startLine: current.line, endLine: current.line + current.selectedText.split("\n").length - 1 } : undefined; };
  const navigate = (path: string, line?: number, column?: number) => { const relative = relativePath(path, w.workspace()?.root); void w.openFile(relative).then(() => setReveal(line ? { path: relative, line, column } : undefined)); };
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
  async function openFilePicker() {
    if (pickingFile) return;
    pickingFile = true;
    try {
      const selected = await api.pickFile();
      if (!selected || disposed) return;
      const root = w.workspace()?.root;
      const relative = relativePath(selected, root);
      if (root && !w.busy() && relative && !/^(?:\/|[A-Za-z]:\/)/.test(relative)) await w.openFile(relative);
      else await api.enqueueDroppedPaths([selected]);
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
  async function applyStartup(request: StartupRequest) { const changing = request.workspaceRoot && (!w.workspace() || relativePath(request.workspaceRoot, w.workspace()?.root) !== ""); if (changing && hasUnsaved()) { const open = await new Promise<boolean>(resolve => setPendingExternal({ request, resolve })); if (!open) return; } await performStartup(request); }
  function openRecentProject(root: string) { void applyStartup({ workspaceRoot: root, files: [] }); }
  function showProjectHistory(event: MouseEvent) { event.preventDefault(); const bounds = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : { left: event.clientX, bottom: event.clientY }; void refreshRecentProjects().then(() => setContext({ x: bounds.left, y: bounds.bottom, label: "Projects", items: [{ id: "open", label: "Open folder…", onSelect: requestWorkspace }, ...recentProjects().map(project => ({ id: project.root, label: `${project.name}${project.missing ? " (missing)" : ""}`, disabled: project.missing, onSelect: () => openRecentProject(project.root) })), { id: "clear", label: "Clear recent projects", separator: true, disabled: !recentProjects().length, onSelect: () => { void api.clearRecentProjects().then(refreshRecentProjects); } }] })); }
  const copyPath = (path: string, absolute = false) => { void copyText(absolute ? absolutePath(path, w.workspace()?.root) : relativePath(path, w.workspace()?.root)); };
  function requestFileAction(kind: FileAction["kind"], source: string, directory = false) {
    const folder = directory ? source : parentPath(source);
    const suggested = kind === "newFile" ? `${folder ? `${folder}/` : ""}new-file.ts` : kind === "newFolder" ? `${folder ? `${folder}/` : ""}new-folder` : kind === "duplicate" ? source.replace(/(\.[^/.]+)?$/, " copy$1") : source;
    setFileAction({ kind, source, directory, initial: suggested });
  }
  const fileDrag = createInternalDrag<DraggedFile>({
    valid: item => !disposed && !w.busy() && item.generation === w.workspaceGeneration() && (item.group === undefined ? w.files().some(file => file.path === item.path && !file.isDir) : !!w.groups().find(group => group.id === item.group)?.tabs.includes(item.path)),
    targetAt: (x, y) => {
      const element = document.elementFromPoint(x, y);
      let pane = element?.closest<HTMLElement>("[data-editor-group]");
      if (!pane && element?.closest(".settings-view-layer")) pane = [...document.querySelectorAll<HTMLElement>("[data-editor-group]")].find(candidate => { const box = candidate.getBoundingClientRect(); return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom; });
      const group = Number(pane?.dataset.editorGroup);
      return w.groups().some(item => item.id === group) ? group : undefined;
    },
    preview: setInternalDrag,
    drop: (item, target, copy) => { if (!w.groups().some(group => group.id === target)) return; if (item.group !== undefined) w.moveTab(item.path, item.group, target, copy); else void w.openFile(item.path, target); },
  });
  function startFileDrag(event: PointerEvent, path: string, group?: number) { fileDrag.start(event, { path, group, generation: w.workspaceGeneration() }); }
  createEffect(() => { w.workspaceGeneration(); w.busy(); w.groups().map(group => group.id).join(","); fileDrag.cancel(); });
  onCleanup(fileDrag.dispose);
  function showContext(event: MouseEvent | KeyboardEvent, path: string, kind: "file" | "directory" | "tab" | "editor", group = w.activeGroup()) {
    event.preventDefault(); event.stopPropagation(); const position = contextMenuPosition(event); const items: ContextMenuItem[] = [];
    const regular = path !== SETTINGS_TAB && !isSettingsBuffer(path); const directory = kind === "directory";
    if (directory) items.push({ id: "toggle", label: w.expanded().has(path) ? "Collapse folder" : "Expand folder", icon: "menu-folder", onSelect: () => { void w.toggleDirectory(path); setShowLeft(true); setLeftView("Files"); } }, { id: "compact-folders", label: compactFolders() ? "Show folders separately" : "Compact single-child folders", icon: "menu-folder", onSelect: () => setCompactFolders(!compactFolders()) });
    else if (kind === "file") items.push({ id: "open", label: "Open file", icon: "menu-file", onSelect: () => navigate(path) });
    if (!directory) {
      items.push({ id: "split", label: "Split editor", icon: "split-editor", children: [{ id: "split-right", label: "Open in split to the right", icon: "split-editor", onSelect: () => { void w.openToSide(path, group); } }] });
      if (kind === "tab") items.push({ id: "close", label: "Close tab", icon: "menu-cancel", shortcut: shortcut("closeTab"), onSelect: () => requestCloseTab(path, group) }, { id: "close-group", label: "Close editor group", icon: "menu-cancel", disabled: w.groups().length < 2, onSelect: () => requestCloseGroup(group) });
      items.push({ id: "save", label: "Save file", icon: "menu-save", disabled: !w.buffers[path], shortcut: shortcut("save"), onSelect: () => { void w.save(path); } });
    }
    if (kind === "editor") {
      const controller = editorCommands.get(`${group}:${path}`);
      const clipboardAction = (action: "copy" | "cut" | "paste" | "selectAll") => { if (controller) void Promise.resolve(controller[action]()).catch(error => w.setError(String(error))); };
      items.push({ id: "cut", label: "Cut", icon: "menu-cut", separator: true, disabled: !controller, onSelect: () => clipboardAction("cut") }, { id: "copy", label: "Copy", icon: "menu-copy", disabled: !controller, onSelect: () => clipboardAction("copy") }, { id: "paste", label: "Paste", icon: "menu-paste", disabled: !controller, onSelect: () => clipboardAction("paste") }, { id: "selectAll", label: "Select all", disabled: !controller, onSelect: () => clipboardAction("selectAll") });
      items.push({ id: "find", separator: true, label: "Find in file", icon: "SearchNormal1", shortcut: shortcut("findInFile"), onSelect: () => runEditor("find") }, { id: "goto", label: "Go to line", shortcut: shortcut("goToLine"), onSelect: () => runEditor("goToLine") }, { id: "format", label: "Format document", disabled: isSettingsBuffer(path) || !w.buffers[path], shortcut: shortcut("formatDocument"), onSelect: () => void w.format(path) });
    }
    if (regular) {
      const clipboard = fileClipboard(); const folder = directory ? path : parentPath(path);
      if (kind !== "editor") items.push({ id: "new", label: "New", icon: "menu-newFile", separator: true, children: [{ id: "new-file", label: "New file…", icon: "menu-newFile", disabled: !isDesktop, disabledReason: "Requires the desktop app", onSelect: () => requestFileAction("newFile", path, directory) }, { id: "new-folder", label: "New folder…", icon: "menu-newFolder", disabled: !isDesktop, disabledReason: "Requires the desktop app", onSelect: () => requestFileAction("newFolder", path, directory) }] }, { id: "rename", label: "Rename…", icon: "menu-rename", disabled: !isDesktop || !path, onSelect: () => requestFileAction("rename", path, directory) }, { id: "duplicate", label: "Duplicate…", icon: "menu-duplicate", disabled: !isDesktop || !path, onSelect: () => requestFileAction("duplicate", path, directory) }, { id: "cut-file", label: "Cut file", icon: "menu-cut", separator: true, disabled: !isDesktop || !path, onSelect: () => setFileClipboard({ path, directory, workspace: w.workspace()?.root || "", cut: true }) }, { id: "copy-file", label: "Copy file", icon: "menu-copy", disabled: !isDesktop || !path, onSelect: () => setFileClipboard({ path, directory, workspace: w.workspace()?.root || "", cut: false }) }, { id: "paste-file", label: "Paste file…", icon: "menu-paste", disabled: !isDesktop || !clipboard || clipboard.workspace !== w.workspace()?.root, onSelect: () => { if (clipboard) setFileAction({ kind: clipboard.cut ? "rename" : "duplicate", source: clipboard.path, directory: clipboard.directory, initial: `${folder ? `${folder}/` : ""}${fileName(clipboard.path)}` }); } });
      items.push({ id: "paths", label: "Copy path", icon: "menu-path", separator: true, children: [{ id: "copy-name", label: "Copy filename", icon: "menu-copy", onSelect: () => { void copyText(fileName(path || w.workspace()?.root || "")); } }, { id: "copy-relative", label: "Copy relative path", icon: "menu-path", onSelect: () => copyPath(path) }, { id: "copy-absolute", label: "Copy absolute path", icon: "menu-path", onSelect: () => copyPath(path, true) }] });
      if (!directory) items.push({ id: "reveal", label: "Reveal in project", icon: "menu-folder", onSelect: () => void revealPath(path) });
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
  const handlers: ActionHandlers = {
    quickOpen: () => setQuickOpen(true), toggleFiles, focusFiles, openFile: () => { void openFilePicker(); }, commandPalette: () => setPaletteOpen(true), findInFile: () => runEditor("find"), searchWorkspace: openSearch,
    settings: openSettings, closeTab: () => { const path = w.activeTab(); if (path) requestCloseTab(path, w.activeGroup()); else requestCloseGroup(w.activeGroup()); }, save: saveActive, openFolder: requestWorkspace,
    splitEditor: () => w.splitEditor(), toggleProject: () => setShowLeft(!showLeft()), toggleAssistant: () => setShowRight(!showRight()), toggleTerminal: () => setShowBottom(!showBottom()),
    markdownPreview: () => { const path = w.activePath(); if (path && w.isMarkdown(path)) w.setMarkdownView(path, w.markdownView(path) === "preview" ? "source" : "preview"); },
    formatDocument: () => { void w.format(); }, goToLine: () => runEditor("goToLine"),
    zoomIn: () => applyZoom(zoom.zoomIn), zoomOut: () => applyZoom(zoom.zoomOut), resetZoom: () => applyZoom(zoom.reset),
    toggleWordWrap: () => { void w.updateEffectiveSetting("wordWrap", !w.settings().wordWrap).catch(error => w.setError(String(error))); },
  };
  const isZoomKey = (event: KeyboardEvent) => { const key = shortcutFromEvent(event); return !!key && (["zoomIn", "zoomOut", "resetZoom"] as const).some(action => bindings()[action].includes(key)); };
  const keyboard = (event: KeyboardEvent) => { if (w.busy() && !isZoomKey(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; } if (!modalAllowsGlobalShortcut(event) && !isZoomKey(event)) return; dispatchKeyboard(event, { bindings: bindings(), handlers, platform, nativeActions: nativeActions() }); };
  function saveSettingsClose() {
    const next = pendingSettingsClose(); if (!next) return Promise.resolve(false);
    return settleIntent(next, current => pendingSettingsClose() === current, async () => await saveSettingsDraft?.() || false, () => { setPendingSettingsClose(undefined); next(); });
  }
  function saveExternalClose() {
    const request = pendingExternal(); if (!request) return Promise.resolve(false);
    return settleIntent(request, current => pendingExternal() === current, async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || pendingExternal() !== request) return false; } if (settingsDirty() && !await saveSettingsDraft?.()) return false; return !hasUnsaved(); }, () => { request.resolve(true); setPendingExternal(undefined); });
  }
  function saveWindowClose() {
    const intent = closeIntent;
    return settleIntent(intent, current => current === closeIntent && pendingAppClose(), async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || intent !== closeIntent) return false; } if (settingsDirty() && !await saveSettingsDraft?.()) return false; return !hasUnsaved(); }, () => closeWindow(false, intent));
  }
  const beforeUnload = (event: BeforeUnloadEvent) => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
  async function closeWindow(discard = false, intent = closeIntent) {
    await settleIntent(intent, token => !disposed && token === closeIntent, async () => { await w.persistSession(); if (!discard && hasUnsaved()) { setPendingAppClose(true); return false; } return true; }, async () => { if (!discard && hasUnsaved()) { setPendingAppClose(true); return; } allowAppClose = true; await getCurrentWindow().close(); });
  }
  onMount(() => {
    applyZoom(zoom.restore);
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setCenterWidth(width); });
    observer.observe(centerElement); onCleanup(() => observer.disconnect());
    const resize = () => setWindowWidth(window.innerWidth); window.addEventListener("resize", resize); onCleanup(() => window.removeEventListener("resize", resize));
    window.addEventListener("keydown", keyboard, true); window.addEventListener("beforeunload", beforeUnload); void w.initialize(applyStartup).then(async () => { await refreshRecentProjects(); const unlisten = await api.onOpenWorkspaceRequested(applyStartup); if (disposed) unlisten(); else unlistenStartup = unlisten; });
    if (isDesktop) {
      void api.onWindowFocus(focused => { if (!focused) w.autoSaveWindowBlur(); }).then(unlisten => { if (disposed) unlisten(); else unlistenFocus = unlisten; });
      void api.onOpenRequestError(message => w.setError(message)).then(unlisten => { if (disposed) unlisten(); else unlistenOpenError = unlisten; });
      void api.onFormatWarning(warning => w.setError(`Saved ${fileName(warning.path)} without formatting: ${warning.message}`)).then(unlisten => { if (disposed) unlisten(); else unlistenFormatWarning = unlisten; });
      void api.onWindowState(state => { setFullscreen(state.fullscreen); setNativeTrafficLights(state.hasNativeTrafficLights); }).then(unlisten => { if (disposed) unlisten(); else unlistenResize = unlisten; });
      void getCurrentWindow().onCloseRequested(event => { if (allowAppClose) return; event.preventDefault(); closeIntent++; if (hasUnsaved()) setPendingAppClose(true); else void closeWindow(); }).then(unlisten => { if (disposed) unlisten(); else unlistenClose = unlisten; });
      void api.onNativeAction(action => { if (!["zoomIn", "zoomOut", "resetZoom"].includes(action) && (w.busy() || !modalAllowsGlobalShortcut(new KeyboardEvent("keydown")))) return; if (action === "quit") { void getCurrentWindow().close(); return; } if ((action === "findInFile" && w.activeTab() === SETTINGS_TAB) || canDispatchAction(action, document.activeElement)) handlers[action]?.(); }).then(unlisten => { if (disposed) unlisten(); else { unlistenNative = unlisten; setNativeReady(true); } });
    }
  });
  onCleanup(() => { window.removeEventListener("keydown", keyboard, true); window.removeEventListener("beforeunload", beforeUnload); disposed = true; unlistenClose?.(); unlistenNative?.(); unlistenResize?.(); unlistenStartup?.(); unlistenFormatWarning?.(); unlistenFocus?.(); unlistenOpenError?.(); endPanelDrag?.(); });
  createEffect(() => { document.documentElement.dataset.theme = theme(); });
  const configuredZoomLevel = createMemo(() => w.settings().zoomLevel);
  createEffect(on([w.workspaceGeneration, configuredZoomLevel], ([, level], previous) => { if (level !== null) applyZoom(() => zoom.setLevel(level)); else if (previous && previous[1] !== null) applyZoom(zoom.reset); }, { defer: true }));
  createEffect(on(w.workspaceGeneration, () => { setFileAction(undefined); fileDrag.cancel(); setContext(undefined); }, { defer: true }));
  let menuSync = 0;
  createEffect(() => { const keys = bindings(); const recording = recordingShortcut(); if (!isDesktop || !nativeReady()) return; const generation = ++menuSync; void api.syncNativeMenu(recording ? {} : nativeMenuBindings(keys)).then(owned => { if (!disposed && generation === menuSync) setNativeActions(new Set(owned as ActionId[])); }).catch(error => w.setError(String(error))); });

  function PanelHandle(props: { label: string; restoreLabel: string; direction: "horizontal" | "vertical"; value: number; min: number; max: number; collapsed: boolean; shortcut?: string; reverse?: boolean; onResize: (value: number) => void; onShown: (shown: boolean) => void }) {
    let handle!: HTMLDivElement;
    const [dragging, setDragging] = createSignal(false);
    const side = props.direction === "vertical" ? "bottom" : props.reverse ? "right" : "left";
    const tooltipId = `panel-handle-tooltip-${side}`;
    return <div ref={handle} data-panel-side={side} class={`resize-handle resize-${props.direction} panel-handle ${props.collapsed ? "collapsed" : ""} ${dragging() ? "dragging" : ""}`} role="separator" aria-label={props.collapsed ? props.restoreLabel : props.label} aria-orientation={props.direction === "horizontal" ? "vertical" : "horizontal"} aria-valuenow={props.collapsed ? 0 : Math.round(props.value)} aria-valuemin={0} aria-valuemax={props.max} tabIndex={0} aria-describedby={tooltipId} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " " || event.key === "Home") { event.preventDefault(); props.onShown(event.key === "Home" ? false : props.collapsed); return; }
      const positive = props.direction === "horizontal" ? event.key === "ArrowRight" : event.key === "ArrowDown";
      const negative = props.direction === "horizontal" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      if (positive || negative) { event.preventDefault(); const delta = (positive ? 1 : -1) * (props.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10); if (props.collapsed) { if (delta > 0) props.onShown(true); } else props.onResize(Math.max(props.min, Math.min(props.max, props.value + delta))); }
    }} onPointerDown={event => {
      if (event.button !== 0) return; endPanelDrag?.(); setDragging(true);
      const start = props.direction === "horizontal" ? event.clientX : event.clientY;
      const remembered = props.value; const initial = props.collapsed ? 0 : props.value; let moved = false; let collapsed = props.collapsed;
      const move = (next: PointerEvent) => { const coordinate = props.direction === "horizontal" ? next.clientX : next.clientY; const raw = initial + (coordinate - start) * (props.reverse ? -1 : 1); if (Math.abs(coordinate - start) > 3) moved = true;
        if (w.settings().collapsePanelsOnDrag && !collapsed && raw < 64) { collapsed = true; props.onResize(remembered); props.onShown(false); }
        else if (collapsed && raw > 120) { collapsed = false; props.onShown(true); }
        if (!collapsed) props.onResize(Math.max(props.min, Math.min(props.max, raw)));
      };
      const finish = (next?: PointerEvent) => { setDragging(false); if (next?.type === "pointerup" && !moved && props.collapsed) props.onShown(true); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", finish); if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); document.body.style.cursor = ""; document.body.style.userSelect = ""; endPanelDrag = undefined; void w.persistSession(); };
      endPanelDrag = finish; handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish); handle.setPointerCapture(event.pointerId); document.body.style.cursor = props.direction === "horizontal" ? "col-resize" : "row-resize"; document.body.style.userSelect = "none"; event.preventDefault();
    }}><span class="panel-rail-grip" aria-hidden="true"><i /><i /><i /></span><span id={tooltipId} role="tooltip" class="panel-handle-tooltip"><span>{props.collapsed ? props.restoreLabel : props.label}</span><Show when={props.shortcut}><kbd>{props.shortcut}</kbd></Show><span class="panel-handle-hint">{props.collapsed ? "Click or drag" : "Drag to resize"}</span></span></div>;
  }

  function DocumentView(props: { path: string; group: number; active: boolean }) {
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
    return <div class="document-view" onContextMenu={event => showContext(event, props.path, "editor", props.group)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, props.path, "editor", props.group); }}><Show when={markdown() || svg()}><div class="markdown-view-toolbar" role="toolbar" aria-label="Markdown view"><SourcePreviewToggle value={view()} onChange={mode => w.setMarkdownView(props.path, mode)} /></div></Show><div class={`document-view-content ${(markdown() || svg()) && view() === "both" ? "markdown-both" : ""}`}>
      <div class="source-view" onFocusOut={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) w.autoSaveEditorBlur(props.path); }} style={{ display: (markdown() || asset()) && view() === "preview" ? "none" : "flex" }}><Show when={w.buffers[props.path]}>{buffer => <Editor buffer={buffer()} document={w.documents()[props.path]?.document} change={w.documents()[props.path]?.change} onEdit={edit => w.edit(props.path, edit)} onUndo={() => w.applyHistory(props.path)} onRedo={() => w.applyHistory(props.path, true)} onSave={saveActive} clipboard={{ readText: api.readClipboard, writeText: api.writeClipboard }} onFormat={() => void w.format(props.path)} lsp={isDesktop && !isSettingsBuffer(props.path) ? languageServers.binding(props.path, { workspaceRoot: () => w.workspace()?.root, getRevision: () => w.buffers[props.path]?.revision ?? 0, isSynchronized: () => w.synchronized(props.path), isActive: editorActive, getWorkspaceGeneration: w.workspaceGeneration, openLocation: location => navigate(location.path, location.range.start.line + 1, location.range.start.character + 1), notify: w.setError }) : undefined} onCommands={commands => { const key = `${props.group}:${props.path}`; if (commands) editorCommands.set(key, commands); else editorCommands.delete(key); }} onCursor={value => { if (props.active) setCursor(value); }} syntax={syntax()} active={editorActive()} readOnly={w.busy()} theme={theme()} fontSize={w.settings().fontSize} fontFamily={w.settings().editorFontFamily} tabSize={w.settings().tabSize} wordWrap={w.settings().wordWrap} revealLine={reveal()?.path === props.path ? reveal()?.line : undefined} revealColumn={reveal()?.path === props.path ? reveal()?.column : undefined} proposal={proposals().find(p => p.path === props.path)} proposalBusy={proposalBusy()} proposalStale={!w.synchronized(props.path)} onApplyProposal={(id, ids) => { void reviewProposal?.(id, ids); }} onRejectProposal={id => { void reviewProposal?.(id, []); }} />}</Show></div>
      <Show when={markdown() || asset()}><div class="preview-view" style={{ display: view() === "source" ? "none" : "flex" }}><Show when={markdown()} fallback={<AssetPreview path={props.path} source={assetSource()} active={previewActive()} loadImage={path => api.readImage(path)} />}><MarkdownPreview text={w.documents()[props.path]?.document || ""} documentPath={`${w.workspace()?.root}/${props.path}`} workspaceRoot={w.workspace()?.root || ""} active={previewActive()} onOpenFile={path => navigate(path)} loadImage={path => api.readImage(path)} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} /></Show></div></Show>
    </div></div>;
  }
  function FileOperationDialog(props: { intent: FileAction }) {
    const intent = props.intent; const [target, setTarget] = createSignal(intent.initial);
    const title = intent.kind === "newFile" ? "New file" : intent.kind === "newFolder" ? "New folder" : intent.kind === "rename" ? "Rename" : intent.kind === "duplicate" ? "Duplicate" : "Move to Trash";
    const submit = async () => { const path = target().trim(); if (intent.kind !== "trash" && !path) throw new Error("Enter a name or relative path."); if (intent.kind === "newFile") await w.newFile(path); else if (intent.kind === "newFolder") await w.newDirectory(path); else if (intent.kind === "rename") await w.renamePath(intent.source, path); else if (intent.kind === "duplicate") await w.duplicatePath(intent.source, path); else await w.trashPath(intent.source); if (fileClipboard()?.cut && fileClipboard()?.path === intent.source) setFileClipboard(undefined); if (fileAction() === intent) setFileAction(undefined); };
    return <Modal label={title} class="confirm-modal" onClose={() => setFileAction(undefined)} onSubmit={submit} busy={w.fileOperationBusy()} initialFocus={intent.kind === "trash" ? "[data-modal-cancel]" : "input"}>
      <MenuIcon name={intent.kind === "trash" ? "trash" : intent.directory ? "folder" : "file"} size={28} /><h2>{title}{intent.kind === "trash" ? ` ${fileName(intent.source)}?` : ""}</h2>
      <Show when={intent.kind !== "trash"} fallback={<p>The item will move to the system Trash. Save or discard any unsaved files before continuing.</p>}><label style={{ display: "block", margin: "12px 0 6px" }} for="file-operation-path">Name or relative path</label><input id="file-operation-path" aria-label="Name or relative path" value={target()} onInput={event => setTarget(event.currentTarget.value)} disabled={w.fileOperationBusy()} spellcheck={false} style={{ width: "100%", padding: "8px", border: "1px solid var(--border)", "border-radius": "5px", background: "var(--field)", margin: "0 0 20px" }} /></Show>
      <div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default><MenuIcon name={intent.kind === "trash" ? "trash" : "save"} size={15} />{intent.kind === "newFile" || intent.kind === "newFolder" ? "Create" : title}</button></div>
    </Modal>;
  }
  function SettingsDocument() {
    onCleanup(() => { setSettingsDirty(false); saveSettingsDraft = undefined; revertSettingsDraft = undefined; });
    return <SettingsPage settings={w.scopeSettings()} scope={w.settingsScope()} configuredKeys={w.configuredSettingsKeys()} settingsPath={w.settingsScope() === "user" ? "User settings.jsonc" : ".span/settings.jsonc"} onScopeChange={w.refreshSettingsScope} onReset={w.resetSetting} onOpenJsonc={() => void w.openSettingsJsonc()} settingsJsonc={w.settingsJsonc()} workspaceName={w.workspace()?.name} onChange={w.updateSettings} onSaveJsonc={w.saveSettingsJsonc} onReloadJsonc={w.reloadSettingsJsonc} onDirtyChange={setSettingsDirty} onSaveReady={save => { saveSettingsDraft = save; }} onRevertReady={revert => { revertSettingsDraft = revert; }} languageServers={<LanguageServerSettings value={w.scopeSettings().languageServers} userValue={w.settings().languageServers} onChange={(key, value, scope) => w.updateSettingKey(key, value, scope === "user" ? "user" : undefined)} />} tools={<ToolsSettings tools={tools()} desktop={isDesktop} loaded={toolsLoaded()} busy={toolsBusy()} error={toolsError()} onRefresh={detectTools} />} onOpenTools={() => { if (!toolsLoaded()) void detectTools(); }} onOpenAgents={() => { setShowRight(true); queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('#agent-prompt, [aria-label="Message to agent"]')?.focus()); }} shortcuts={<KeyboardSettings scope={w.settingsScope()} bindingSources={bindingSources()} keybindings={w.scopeSettings().keybindings} onChange={updateKeybindings} onRecordingChange={setRecordingShortcut} platform={platform} />} />;
  }
  function EditorPane(props: { group: EditorGroup; width?: number }) {
    const groupId = props.group.id;
    const group = () => w.groups().find(item => item.id === groupId) || { id: groupId, tabs: [] as string[], active: undefined };
    const active = () => group().active;
    const documentIsActive = (path: string) => active() === path && w.activeGroup() === group().id;
    return <section class={`panel editor-pane ${w.activeGroup() === group().id ? "active-group" : ""}`} aria-label={`Editor group ${group().id}`} style={{ flex: props.width ? `0 0 ${props.width}px` : "1 1 0", "box-shadow": dropGroup() === group().id ? "inset 0 0 0 1px var(--accent)" : undefined }} data-editor-group={group().id} onPointerDown={() => w.setActiveGroup(group().id)} onFocusIn={() => w.setActiveGroup(group().id)}>
      <div class="editor-header"><div class="editor-tabs" role="tablist" aria-label={`Open files in group ${group().id}`}><For each={group().tabs}>{path => <div draggable={false} onPointerDown={event => { if (!(event.target as Element).closest(".tab-close")) startFileDrag(event, path, group().id); }} class={`file-tab internal-drag-source ${active() === path ? "active" : ""}`} onContextMenu={event => showContext(event, path, "tab", group().id)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, path, "tab", group().id); }}><button role="tab" aria-selected={active() === path} aria-controls={`editor-${group().id}`} title={isSettingsBuffer(path) || path === SETTINGS_TAB ? tabName(path) : path} onClick={() => path === SETTINGS_TAB ? w.openSettings() : void w.openFile(path, group().id)}><Show when={path !== SETTINGS_TAB} fallback={<Icon name="u-gear" size={15} />}><Show when={!isSettingsBuffer(path)} fallback={<Icon name="menu-file" size={15} />}><FileIcon path={path} /></Show></Show><span>{tabName(path)}</span></button><button class="tab-close" aria-label={`Close ${tabName(path)}`} title={(path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)) ? "Unsaved changes, close file" : "Close file"} onClick={() => requestCloseTab(path, group().id)}><Show when={path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)} fallback={<span class="cross" />}><span class="dirty-dot" /></Show></button></div>}</For></div><Show when={w.groups().length > 1}><button class="icon-button" aria-label={`Close editor group ${group().id}`} title="Close editor group" onClick={() => requestCloseGroup(group().id)}><MenuIcon name="cancel" size={15} /></button></Show><button class="icon-button save-file" aria-label="Save file" title={`Save (${shortcut("save")})`} disabled={!active()} onClick={saveActive}><Icon name="TickCircle" size={15} /></button><button class="icon-button split-editor" aria-label="Split editor" disabled={w.groups().length >= 2} title={`Split editor (${shortcut("splitEditor")})`} onClick={() => w.splitEditor()}><Icon name="split-editor" size={15} /></button></div>
      <div id={`editor-${group().id}`} class="editor-documents" role="tabpanel"><For each={group().tabs}>{path => <div class="editor-document" style={{ display: active() === path ? "flex" : "none" }}><Show when={path !== SETTINGS_TAB}><DocumentView path={path} group={group().id} active={documentIsActive(path)} /></Show></div>}</For><Show when={!active()}><Show when={w.groups().length === 1} fallback={<div class="editor-empty"><h2>No file open</h2><button onClick={() => void openFilePicker()}><span>Open a file</span><Show when={shortcut("openFile")}>{key => <kbd>{key()}</kbd>}</Show></button><button onClick={() => requestCloseGroup(group().id)}>Close group</button></div>}><div class="editor-empty"><AnimatedLogo size={96} /><h1>span</h1><p>A space for code and agents.</p><button onClick={() => void openFilePicker()}><span>Open a file</span><Show when={shortcut("openFile")}>{key => <kbd>{key()}</kbd>}</Show></button><button onClick={requestWorkspace}><span>Open a folder</span><kbd>{shortcut("openFolder")}</kbd></button><button onClick={openSearch}><span>Search workspace</span><kbd>{shortcut("searchWorkspace")}</kbd></button><button onClick={() => setPaletteOpen(true)}><span>Show commands</span><kbd>{shortcut("commandPalette")}</kbd></button><Show when={recentProjects().length}><div class="welcome-recents"><span>Recent projects</span><For each={recentProjects().slice(0, 5)}>{project => <button disabled={project.missing} title={project.root} onClick={() => openRecentProject(project.root)}><Icon name="Folder2" size={14} /><span>{project.name}</span><Show when={project.missing}><small>Missing</small></Show></button>}</For></div></Show></div></Show></Show></div>
    </section>;
  }
  const settingsGroup = () => w.groups().findIndex(group => group.active === SETTINGS_TAB);
  const settingsLayerStyle = () => ({ display: settingsGroup() >= 0 ? "flex" : "none", left: `${settingsGroup() > 0 ? centerWidth() * splitFraction() + 4 : 0}px`, width: w.groups().length < 2 ? "100%" : `${settingsGroup() === 0 ? centerWidth() * splitFraction() - 4 : centerWidth() * (1 - splitFraction()) - 4}px` });

  return <main class={`ide theme-${theme()} ${isDesktop ? "desktop" : ""} ${fullscreen() ? "is-fullscreen" : ""} ${nativeTrafficLights() ? "native-traffic-lights" : ""}`} style={{ "--ui-font-size": `${w.settings().uiFontSize}px`, "--ui-font-family": w.settings().uiFontFamily, "--editor-font-family": w.settings().editorFontFamily }} aria-label="span editor" aria-busy={w.busy()} inert={w.busy()}>
    <Show when={internalDrag()}>{state => <div class="internal-drag-preview" role="status" aria-live="off" style={{ left: `${(state().x + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px`, top: `${(state().y + 14) / (parseFloat(getComputedStyle(document.documentElement).zoom) || 1)}px` }}><FileIcon path={state().item.path} /><span>{tabName(state().item.path)}</span><small>{state().target === undefined ? "No drop target" : state().item.group === undefined ? "Open" : state().copy && state().item.path !== SETTINGS_TAB ? "Copy" : "Move"}</small></div>}</Show>
    <header class="topbar" data-tauri-drag-region><div class="top-left"><span class="traffic-lights" aria-hidden="true"><i /><i /><i /></span><button class={`icon-button ${showLeft() ? "" : "off"}`} aria-label="Toggle project panel" aria-pressed={showLeft()} title={`Toggle project panel (${shortcut("toggleProject")})`} onClick={() => setShowLeft(!showLeft())}><Icon name="panel-left" /></button><button class={`icon-button ${showBottom() ? "" : "off"}`} aria-label="Toggle terminal panel" aria-pressed={showBottom()} title={`Toggle terminal panel (${shortcut("toggleTerminal")})`} onClick={() => setShowBottom(!showBottom())}><Icon name="panel-bottom" /></button><button class={`icon-button ${showRight() ? "" : "off"}`} aria-label="Toggle AI Assistant panel" aria-pressed={showRight()} title={`Toggle AI Assistant (${shortcut("toggleAssistant")})`} onClick={() => setShowRight(!showRight())}><Icon name="panel-right" /></button><span class="toolbar-separator" /><button class="icon-button" aria-label="Open quick open" title={`Go to file (${shortcut("quickOpen")})`} onClick={() => setQuickOpen(true)}><Icon name="goto" /></button><button class="icon-button open-folder-toolbar" aria-label="Open folder" title={`Open folder (${shortcut("openFolder")})`} onClick={requestWorkspace}><Icon name="Folder2" /></button></div><div class="top-center"><button class="project-title" aria-label="Recent projects" aria-haspopup="menu" onClick={showProjectHistory}>{w.workspace()?.name || "span"}</button><button class="branch-button" aria-label="Source control" title="Source control, phase 0.3" onClick={() => { setShowLeft(true); setLeftView("Git"); }}><Icon name="Hierarchy" size={14} /><span>{isDesktop ? "workspace" : "main"}</span></button></div><div class="top-right"><img class="product-logo" src="/span-logo.svg" alt="span" title="span, phase 0.1" /><button class="icon-button blue" aria-label="Show AI Assistant" onClick={() => setShowRight(true)}><Icon name="flash" /></button><button class="icon-button" aria-label="Show terminal" title="Terminal, phase 0.3" onClick={() => setShowBottom(true)}><Icon name="u-play" /></button><button class="icon-button" aria-label="Search workspace" title={`Search workspace (${shortcut("searchWorkspace")})`} onClick={openSearch}><Icon name="SearchNormal1" /></button><button class="icon-button" aria-label="Settings" title={`Settings (${shortcut("settings")})`} onClick={openSettings}><Icon name="u-gear" /></button></div></header>
    <div class="workbench-main">
      <aside class="panel explorer-panel" style={{ width: `${leftWidth()}px`, display: showLeft() ? "flex" : "none" }} aria-label="Project" onContextMenu={treeContext} onKeyDown={treeContext}><div class="panel-header explorer-header"><For each={["Files", "Search", "Git", "History"] as const}>{view => <button class={`panel-tab ${leftView() === view ? "selected" : ""}`} aria-pressed={leftView() === view} onClick={() => { setLeftView(view); if (view === "Search") openSearch(); }}>{view}</button>}</For><button class="icon-button" aria-label="New file" title="New file" disabled={!isDesktop || !w.workspace()} onClick={() => requestFileAction("newFile", "", true)}><MenuIcon name="newFile" /></button><button class="icon-button" aria-label="New folder" title="New folder" disabled={!isDesktop || !w.workspace()} onClick={() => requestFileAction("newFolder", "", true)}><MenuIcon name="newFolder" /></button></div><Explorer workbench={w} view={leftView()} onNavigate={navigate} onFilePointerDown={(event, path) => startFileDrag(event, path)} /></aside>
      <PanelHandle label="Resize project panel" restoreLabel="Restore project panel" shortcut={shortcut("toggleProject")} direction="horizontal" value={leftWidth()} min={200} max={Math.min(1000, windowWidth() * .42)} collapsed={!showLeft()} onResize={setLeftWidth} onShown={setShowLeft} />
      <div class="center-area" ref={centerElement}><div class="editor-groups"><For each={w.groups().map(group => group.id)}>{(id, index) => <><Show when={index() > 0}><ResizeHandle label="Resize editor groups" direction="horizontal" value={centerWidth() * splitFraction()} min={centerWidth() * .2} max={centerWidth() * .8} onResize={width => setSplitFraction(width / centerWidth())} /></Show><EditorPane group={w.groups().find(group => group.id === id)!} width={w.groups().length > 1 && index() === 0 ? centerWidth() * splitFraction() - 4 : undefined} /></>}</For><div class="settings-view-layer" style={settingsLayerStyle()} onFocusIn={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }} onPointerDown={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }}><SettingsDocument /></div></div>
      <PanelHandle label="Resize terminal panel" restoreLabel="Restore terminal panel" shortcut={shortcut("toggleTerminal")} direction="vertical" reverse value={bottomHeight()} min={100} max={Math.min(1000, window.innerHeight * .7)} collapsed={!showBottom()} onResize={setBottomHeight} onShown={setShowBottom} />
      <section class="panel terminal-panel" style={{ height: `${bottomHeight()}px`, display: showBottom() ? "flex" : "none" }} aria-label="Terminal"><div class="panel-header"><span class="panel-tab selected">Terminal<button class="close-button" aria-label="Close terminal panel" onClick={() => setShowBottom(false)}>×</button></span><span class="phase-note">Phase 0.3</span></div><div class="terminal-empty"><Icon name="u-terminal" size={18} /><span>Terminal sessions will be available in phase 0.3.</span></div></section></div>
      <PanelHandle label="Resize AI Assistant panel" restoreLabel="Restore AI Assistant panel" shortcut={shortcut("toggleAssistant")} direction="horizontal" reverse value={rightWidth()} min={260} max={Math.min(1000, windowWidth() * .42)} collapsed={!showRight()} onResize={setRightWidth} onShown={setShowRight} />
      <aside class="panel assistant-panel" style={{ width: `${rightWidth()}px`, display: showRight() ? "flex" : "none" }} aria-label="AI Assistant panel"><AgentPanel workspacePath={w.workspace()?.root} workspaceGeneration={w.workspaceGeneration()} onProposalsChange={proposalsChanged} onReviewInEditor={(path, line) => navigate(path, line)} onReviewReady={review => { reviewProposal = review; }} onReviewBusyChange={setProposalBusy} activePath={isSettingsBuffer(w.activePath() || "") ? undefined : w.activePath()} removeAgent={api.agentRemove} selectionContext={selectionContext()} onBufferChanged={(path, snapshot) => void w.acceptAgentBuffer(path, snapshot)} onOpenSettings={openSettings} onOpenFile={(path, line) => navigate(path, line)} onFilesChanged={() => w.refreshTree()} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} /></aside>
    </div>
    <footer class="statusbar"><div class="breadcrumbs"><Show when={w.activePath()} fallback={<span>{w.activeTab() === SETTINGS_TAB ? "Workspace settings" : w.busy() ? "Opening folder…" : "Ready"}</span>}><Breadcrumbs path={w.activePath()} workspace={w.workspace()} listDirectory={api.listDirectory} onOpen={path => navigate(path)} onReveal={path => void revealPath(path)} onContextMenu={(event, path, directory) => showContext(event, path, directory ? "directory" : "file")} /></Show></div><div class="status-right"><Show when={!isDesktop}><span class="preview-label" title={previewNotice}>Browser preview</span></Show><span>{cursor().line}:{cursor().column}</span><Show when={w.autoSaveFailures().length}><button title="Review Auto Save error" onClick={() => w.setError(w.autoSaveFailures()[0].message)}>Auto Save failed</button></Show><LanguageServerStatus state={languageServers.bufferState(w.activePath() || "", w.workspace()?.root)} autoInstall={w.settings().languageServers?.autoInstall ?? true} onInstall={server => void languageServers.install(server)} onRestart={server => void languageServers.restart(server)} onRetry={server => void languageServers.retry(server)} onOpenSettings={openSettings} error={(() => { const p = w.activePath(); const id = p ? serverForBuffer(p) : undefined; return id ? languageServers.errorFor(id) : ""; })()} statusError={languageServers.statusError()} onRefresh={() => void languageServers.refresh()} /><span>UTF-8</span><span>{w.buffers[w.activePath() || ""]?.language || "Plain text"}</span><span class="version-label">span 0.1.0</span></div></footer>
    <Show when={w.error()}><div class="error-toast" role="alert"><Icon name="Warning2" /><span>{w.error()}</span><Show when={w.activePath() && w.failed().has(w.activePath()!)}><button onClick={() => void w.save()}>Retry</button><button onClick={() => { const path = w.activePath(); if (path) void w.acceptAgentBuffer(path); }}>Recover draft</button></Show><button class="close-button" aria-label="Dismiss notification" onClick={() => w.setError("")}>×</button></div></Show>
    <Show when={quickOpen()}><QuickOpen onQueryFiles={w.queryFiles} indexStatus={w.indexStatus()} indexError={w.indexError()} workspaceGeneration={w.workspaceGeneration()} files={w.files()} onOpen={navigate} onClose={() => setQuickOpen(false)} onOpenFolder={requestWorkspace} workspace={w.workspace()} activePath={isSettingsBuffer(w.activePath() || "") ? undefined : w.activePath()} recentPaths={w.recentPaths()} handlers={handlers} bindings={bindings()} onPreview={async path => { const document = w.documents()[path]?.document; if (document) return document.sliceString(0, 64 * 1024); if (isBinaryAssetPath(path)) return "Image preview is available when opened."; return (await api.openBuffer(path)).text.slice(0, 64 * 1024); }} onSearch={api.search} /></Show>
    <Show when={fileAction()}>{intent => <FileOperationDialog intent={intent()} />}</Show>
    <Show when={context()}>{menu => <ContextMenu x={menu().x} y={menu().y} items={menu().items} label={menu().label} onClose={() => setContext(undefined)} />}</Show>
    <Show when={paletteOpen()}><CommandPalette bindings={bindings()} handlers={handlers} onClose={() => setPaletteOpen(false)} platform={platform} /></Show>
    <Show when={pendingSettingsClose()}>{action => <Modal label="Unsaved settings" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveSettingsClose} onClose={() => setPendingSettingsClose(undefined)}><h2>Save changes to workspace settings?</h2><p>Your JSONC draft has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { const next = action(); revertSettingsDraft?.(); setPendingSettingsClose(undefined); next(); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save</button></div></Modal>}</Show>
    <Show when={pendingExternal()}>{pending => <Modal label="Open requested project" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveExternalClose} onClose={() => { pending().resolve(false); setPendingExternal(undefined); }}><h2>Open another project?</h2><p>A file or command-line request wants to open {pending().request.workspaceRoot}. This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { revertSettingsDraft?.(); pending().resolve(true); setPendingExternal(undefined); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save all</button></div></Modal>}</Show>
    <Show when={w.pendingClose()}>{pending => <Modal label="Unsaved changes" class="confirm-modal" onClose={() => void w.confirmClose("cancel")} onSubmit={() => w.confirmClose("save")} busy={w.closeBusy()} initialFocus="[data-modal-default]"><Icon name="DocumentText" size={28} /><h2>Save changes to {tabName(pending().path)}?</h2><p>Your changes will be lost if you close this file without saving.</p><div class="dialog-actions"><button class="button" onClick={() => void w.confirmClose("discard")}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default><MenuIcon name="save" size={15} />Save</button></div></Modal>}</Show>
    <Show when={pendingAppClose()}><Modal label="Close span" class="confirm-modal" initialFocus="[data-modal-default]" onSubmit={saveWindowClose} onClose={cancelClose}><h2>Save changes before closing?</h2><p>This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { void closeWindow(true); }}><MenuIcon name="discard" size={15} />Discard changes</button><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default ><MenuIcon name="save" size={15} />Save all</button></div></Modal></Show>
    <Show when={w.pendingRecovery()}>{recovery => <Modal label="Retained local draft" class="confirm-modal" onClose={() => w.resolveRecovery(false)}><h2>Your newer local draft was retained</h2><p>The current accepted document is open in {recovery().path.split("/").pop()}. You can keep it or restore your local draft for review.</p><div class="dialog-actions"><button class="button" onClick={() => w.resolveRecovery(false)}>Keep current document</button><span /><button class="button primary" data-modal-default onClick={() => w.resolveRecovery(true)}>Restore my draft</button></div></Modal>}</Show>
    <Show when={w.pendingWorkspace()}><Modal label="Open another folder" class="confirm-modal" onClose={() => w.setPendingWorkspace(false)}><h2>Open another folder?</h2><p>There are unsaved changes in this workspace. Discard them to open another folder.</p><div class="dialog-actions"><span /><button class="button" data-modal-cancel><MenuIcon name="cancel" size={15} />Cancel</button><button class="button primary" data-modal-default onClick={() => { w.setPendingWorkspace(false); void w.openWorkspace(); }}>Discard and open folder</button></div></Modal></Show>
  </main>;
}
