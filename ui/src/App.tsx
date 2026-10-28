import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor, type EditorCommands, type EditorCursor } from "./components/Editor";
import AgentPanel from "./components/AgentPanel";
import { Explorer } from "./components/Explorer";
import Icon, { FileIcon } from "./components/Icon";
import { Modal } from "./components/Modal";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardSettings } from "./components/KeyboardSettings";
import { MarkdownPreview } from "./components/MarkdownPreview";
import { ResizeHandle } from "./components/ResizeHandle";
import { AnimatedLogo } from "./components/AnimatedLogo";
import { AssetPreview, isAssetPath, isBinaryAssetPath, isSvgPath } from "./components/AssetPreview";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { ToolsSettings } from "./components/ToolsSettings";
import { absolutePath, relativePath, fileName, contextMenuPosition, isContextMenuKey } from "./lib/navigation";
import { SettingsPage } from "./components/SettingsPage";
import { createWorkbench, settleIntent, SETTINGS_TAB, type EditorGroup } from "./stores/workbench";
import { canDispatchAction, currentPlatform, dispatchKeyboard, nativeMenuBindings, resolveKeybindings, shortcutLabel, type ActionHandlers, type ActionId } from "./lib/commands";
import { api, isDesktop, previewNotice } from "./lib/client";
import type { EditProposal, SyntaxSnapshot, ToolInfo, StartupRequest_Serialize as StartupRequest, RecentProject_Serialize as RecentProject } from "./bindings";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/workbench.css";
import "./styles/file-icons.css";

export default function App() {
  const w = createWorkbench();
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
  let endPanelDrag: (() => void) | undefined;
  const editorCommands = new Map<string, EditorCommands>();
  const [nativeReady, setNativeReady] = createSignal(false);
  const [nativeActions, setNativeActions] = createSignal<ReadonlySet<ActionId>>(new Set(isDesktop ? ["closeTab"] : []));
  const [cursor, setCursor] = createSignal<EditorCursor>({ line: 1, column: 1, from: 0, to: 0, selectedText: "" });
  const [reveal, setReveal] = createSignal<{ path: string; line: number; column?: number }>();
  const theme = () => w.settings().theme.toLowerCase() as "dark" | "light" | "purple";
  const platform = currentPlatform();
  const bindings = createMemo(() => resolveKeybindings(w.settings().keybindings, platform));
  const shortcut = (id: ActionId) => shortcutLabel(id, bindings(), platform);
  const hasUnsaved = () => w.hasDirty() || settingsDirty();
  const selectionContext = () => { const path = w.activePath(); const current = cursor(); return path && current.selectedText ? { path, text: current.selectedText, startLine: current.line, endLine: current.line + current.selectedText.split("\n").length - 1 } : undefined; };
  const navigate = (path: string, line?: number) => { const relative = relativePath(path, w.workspace()?.root); void w.openFile(relative).then(() => setReveal(line ? { path: relative, line } : undefined)); };
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
  function showContext(event: MouseEvent | KeyboardEvent, path: string, kind: "file" | "directory" | "tab" | "editor", group = w.activeGroup()) {
    event.preventDefault(); event.stopPropagation(); const position = contextMenuPosition(event); const items: ContextMenuItem[] = [];
    if (kind === "directory") items.push({ id: "toggle", label: w.expanded().has(path) ? "Collapse folder" : "Expand folder", onSelect: () => { void w.toggleDirectory(path); setShowLeft(true); setLeftView("Files"); } });
    else if (kind === "file") items.push({ id: "open", label: "Open file", onSelect: () => navigate(path) });
    if (kind === "tab") items.push({ id: "close", label: "Close tab", shortcut: shortcut("closeTab"), onSelect: () => requestCloseTab(path, group) });
    if (kind !== "directory" && path !== SETTINGS_TAB) items.push({ id: "split", label: "Open in new split", onSelect: () => { if (w.groups().length < 2) { void w.openFile(path).then(w.splitEditor); } else { const other = w.groups().find(item => item.id !== group); if (other) void w.openFile(path, other.id); } } }, { id: "save", label: "Save file", disabled: !w.buffers[path], shortcut: shortcut("save"), onSelect: () => { void w.save(path); } });
    if (kind === "editor") {
      const controller = editorCommands.get(`${group}:${path}`);
      const clipboardAction = (action: "copy" | "cut" | "paste" | "selectAll") => { if (controller) void Promise.resolve(controller[action]()).catch(error => w.setError(String(error))); };
      items.push({ id: "cut", label: "Cut", disabled: !controller, onSelect: () => clipboardAction("cut") }, { id: "copy", label: "Copy", disabled: !controller, onSelect: () => clipboardAction("copy") }, { id: "paste", label: "Paste", disabled: !controller, onSelect: () => clipboardAction("paste") }, { id: "selectAll", label: "Select all", disabled: !controller, onSelect: () => clipboardAction("selectAll") });
    }
    if (kind === "editor") items.push({ id: "find", separator: true, label: "Find in file", shortcut: shortcut("findInFile"), onSelect: () => runEditor("find") }, { id: "goto", label: "Go to line", shortcut: shortcut("goToLine"), onSelect: () => runEditor("goToLine") }, { id: "format", label: "Format document", shortcut: shortcut("formatDocument"), onSelect: () => void w.format(path) });
    if (path !== SETTINGS_TAB) { if (kind !== "directory") items.push({ id: "reveal", label: "Reveal in project", onSelect: () => void revealPath(path) }); items.push({ id: "copy-name", label: "Copy filename", separator: true, onSelect: () => { void copyText(fileName(path)); } }, { id: "copy-relative", label: "Copy relative path", separator: true, onSelect: () => copyPath(path) }, { id: "copy-absolute", label: "Copy absolute path", onSelect: () => copyPath(path, true) }); }
    setContext({ ...position, items, label: kind === "editor" ? "Editor actions" : "File actions" });
  }
  const treeContext = (event: MouseEvent | KeyboardEvent) => { if (event instanceof KeyboardEvent && !isContextMenuKey(event)) return; const row = (event.target as Element | null)?.closest<HTMLElement>('[role="treeitem"]'); const path = row?.getAttribute("title"); if (path !== null && path !== undefined) showContext(event, path, row?.hasAttribute("aria-expanded") ? "directory" : "file"); };
  const openSearch = () => { batch(() => { setShowLeft(true); setLeftView("Search"); }); queueMicrotask(() => document.getElementById("workspace-search")?.focus()); };
  const requestCloseTab = (path: string, group: number) => { if (path === SETTINGS_TAB && settingsDirty()) setPendingSettingsClose(() => () => w.closeTab(path, group)); else w.closeTab(path, group); };
  const saveActive = () => { if (w.activeTab() === SETTINGS_TAB) void saveSettingsDraft?.(); else void w.save(); };
  function runEditor(command: keyof EditorCommands) {
    if (w.activeTab() === SETTINGS_TAB) { if (command === "find") document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')?.focus(); return; }
    const path = w.activePath(); if (!path) return;
    if (w.isMarkdown(path) && w.markdownView(path) === "preview") w.setMarkdownView(path, "source");
    queueMicrotask(() => editorCommands.get(`${w.activeGroup()}:${path}`)?.[command]());
  }
  const handlers: ActionHandlers = {
    quickOpen: () => setQuickOpen(true), commandPalette: () => setPaletteOpen(true), findInFile: () => runEditor("find"), searchWorkspace: openSearch,
    settings: openSettings, closeTab: () => { const path = w.activeTab(); if (path) requestCloseTab(path, w.activeGroup()); }, save: saveActive, openFolder: requestWorkspace,
    splitEditor: w.splitEditor, toggleProject: () => setShowLeft(!showLeft()), toggleAssistant: () => setShowRight(!showRight()), toggleTerminal: () => setShowBottom(!showBottom()),
    markdownPreview: () => { const path = w.activePath(); if (path && w.isMarkdown(path)) w.setMarkdownView(path, w.markdownView(path) === "preview" ? "source" : "preview"); },
    formatDocument: () => { void w.format(); }, goToLine: () => runEditor("goToLine"),
  };
  const keyboard = (event: KeyboardEvent) => { dispatchKeyboard(event, { bindings: bindings(), handlers, platform, nativeActions: nativeActions() }); };
  const beforeUnload = (event: BeforeUnloadEvent) => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
  async function closeWindow(discard = false, intent = closeIntent) {
    await settleIntent(intent, token => !disposed && token === closeIntent, async () => { await w.persistSession(); if (!discard && hasUnsaved()) { setPendingAppClose(true); return false; } return true; }, async () => { if (!discard && hasUnsaved()) { setPendingAppClose(true); return; } allowAppClose = true; await getCurrentWindow().close(); });
  }
  onMount(() => {
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setCenterWidth(width); });
    observer.observe(centerElement); onCleanup(() => observer.disconnect());
    const resize = () => setWindowWidth(window.innerWidth); window.addEventListener("resize", resize); onCleanup(() => window.removeEventListener("resize", resize));
    window.addEventListener("keydown", keyboard, true); window.addEventListener("beforeunload", beforeUnload); void w.initialize(applyStartup).then(async () => { await refreshRecentProjects(); if (isDesktop) { const unlisten = await api.onOpenWorkspaceRequested(applyStartup); if (disposed) unlisten(); else unlistenStartup = unlisten; } });
    if (isDesktop) {
      void api.onWindowState(state => { setFullscreen(state.fullscreen); setNativeTrafficLights(state.hasNativeTrafficLights); }).then(unlisten => { if (disposed) unlisten(); else unlistenResize = unlisten; });
      void getCurrentWindow().onCloseRequested(event => { if (allowAppClose) return; event.preventDefault(); closeIntent++; if (hasUnsaved()) setPendingAppClose(true); else void closeWindow(); }).then(unlisten => { if (disposed) unlisten(); else unlistenClose = unlisten; });
      void api.onNativeAction(action => { if (action === "quit") { void getCurrentWindow().close(); return; } if ((action === "findInFile" && w.activeTab() === SETTINGS_TAB) || canDispatchAction(action, document.activeElement)) handlers[action]?.(); }).then(unlisten => { if (disposed) unlisten(); else { unlistenNative = unlisten; setNativeReady(true); } });
    }
  });
  onCleanup(() => { window.removeEventListener("keydown", keyboard, true); window.removeEventListener("beforeunload", beforeUnload); disposed = true; unlistenClose?.(); unlistenNative?.(); unlistenResize?.(); unlistenStartup?.(); endPanelDrag?.(); });
  createEffect(() => { document.documentElement.dataset.theme = theme(); });
  let menuSync = 0;
  createEffect(() => { const keys = bindings(); const recording = recordingShortcut(); if (!isDesktop || !nativeReady()) return; const generation = ++menuSync; void api.syncNativeMenu(recording ? {} : nativeMenuBindings(keys)).then(owned => { if (!disposed && generation === menuSync) setNativeActions(new Set(owned as ActionId[])); }).catch(error => w.setError(String(error))); });

  function PanelHandle(props: { label: string; restoreLabel: string; direction: "horizontal" | "vertical"; value: number; min: number; max: number; collapsed: boolean; reverse?: boolean; onResize: (value: number) => void; onShown: (shown: boolean) => void }) {
    let handle!: HTMLDivElement;
    return <div ref={handle} class={`resize-handle resize-${props.direction} panel-handle ${props.collapsed ? "collapsed" : ""}`} role="separator" aria-label={props.collapsed ? props.restoreLabel : props.label} aria-orientation={props.direction === "horizontal" ? "vertical" : "horizontal"} aria-valuenow={props.collapsed ? 0 : Math.round(props.value)} aria-valuemin={0} aria-valuemax={props.max} tabIndex={0} title={props.collapsed ? `${props.restoreLabel}, click or drag` : "Drag to resize, drag to the edge to collapse"} onKeyDown={event => {
      if (event.key === "Enter" || event.key === " " || event.key === "Home") { event.preventDefault(); props.onShown(event.key === "Home" ? false : props.collapsed); return; }
      const positive = props.direction === "horizontal" ? event.key === "ArrowRight" : event.key === "ArrowDown";
      const negative = props.direction === "horizontal" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
      if (positive || negative) { event.preventDefault(); const delta = (positive ? 1 : -1) * (props.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10); if (props.collapsed) { if (delta > 0) props.onShown(true); } else props.onResize(Math.max(props.min, Math.min(props.max, props.value + delta))); }
    }} onPointerDown={event => {
      if (event.button !== 0) return; endPanelDrag?.();
      const start = props.direction === "horizontal" ? event.clientX : event.clientY;
      const remembered = props.value; const initial = props.collapsed ? 0 : props.value; let moved = false; let collapsed = props.collapsed;
      const move = (next: PointerEvent) => { const coordinate = props.direction === "horizontal" ? next.clientX : next.clientY; const raw = initial + (coordinate - start) * (props.reverse ? -1 : 1); if (Math.abs(coordinate - start) > 3) moved = true;
        if (w.settings().collapsePanelsOnDrag && !collapsed && raw < 64) { collapsed = true; props.onResize(remembered); props.onShown(false); }
        else if (collapsed && raw > 120) { collapsed = false; props.onShown(true); }
        if (!collapsed) props.onResize(Math.max(props.min, Math.min(props.max, raw)));
      };
      const finish = (next?: PointerEvent) => { if (next?.type === "pointerup" && !moved && props.collapsed) props.onShown(true); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", finish); if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); document.body.style.cursor = ""; document.body.style.userSelect = ""; endPanelDrag = undefined; void w.persistSession(); };
      endPanelDrag = finish; handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish); handle.setPointerCapture(event.pointerId); document.body.style.cursor = props.direction === "horizontal" ? "col-resize" : "row-resize"; document.body.style.userSelect = "none"; event.preventDefault();
    }}><Show when={props.collapsed}><span class="panel-rail-grip" aria-hidden="true"><i /><i /><i /></span></Show></div>;
  }

  function DocumentView(props: { path: string; group: number; active: boolean }) {
    const [syntax, setSyntax] = createSignal<SyntaxSnapshot>();
    const markdown = () => w.isMarkdown(props.path);
    const asset = () => isAssetPath(props.path);
    const svg = () => isSvgPath(props.path);
    const view = () => w.markdownView(props.path);
    const assetSource = createMemo(() => { const document = w.documents()[props.path]?.document; return svg() && props.active && view() !== "source" && document && document.length <= 1024 * 1024 ? document.toString() : undefined; });
    const editorActive = () => props.active && (!(markdown() || asset()) || view() !== "preview");
    const previewActive = () => props.active && view() !== "source";
    createEffect(() => {
      const path = props.path; const doc = w.documents()[path]?.document; const revision = w.buffers[path]?.revision; setSyntax(undefined);
      if (!doc || !isDesktop || !props.active || ((markdown() || asset()) && view() === "preview")) return;
      const timer = setTimeout(() => { if (!w.synchronized(path)) return; void api.syntax(path).then(result => { if (w.documents()[path]?.document === doc && w.buffers[path]?.revision === revision && result.revision === revision) setSyntax(result); }).catch(() => undefined); }, 100); onCleanup(() => clearTimeout(timer));
    });
    return <div class="document-view" onContextMenu={event => showContext(event, props.path, "editor", props.group)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, props.path, "editor", props.group); }}><Show when={markdown() || svg()}><div class="markdown-view-toolbar" role="toolbar" aria-label="Markdown view"><For each={["source", "preview", "both"] as const}>{mode => <button aria-pressed={view() === mode} onClick={() => w.setMarkdownView(props.path, mode)}>{mode === "source" ? "Source" : mode === "preview" ? "Preview" : "Both"}</button>}</For></div></Show><div class={`document-view-content ${(markdown() || svg()) && view() === "both" ? "markdown-both" : ""}`}>
      <div class="source-view" style={{ display: (markdown() || asset()) && view() === "preview" ? "none" : "flex" }}><Show when={w.buffers[props.path]}>{buffer => <Editor buffer={buffer()} document={w.documents()[props.path]?.document} change={w.documents()[props.path]?.change} onEdit={edit => w.edit(props.path, edit)} onUndo={() => w.applyHistory(props.path)} onRedo={() => w.applyHistory(props.path, true)} onSave={saveActive} clipboard={{ readText: api.readClipboard, writeText: api.writeClipboard }} onFormat={() => void w.format(props.path)} onCommands={commands => { const key = `${props.group}:${props.path}`; if (commands) editorCommands.set(key, commands); else editorCommands.delete(key); }} onCursor={value => { if (props.active) setCursor(value); }} syntax={syntax()} active={editorActive()} theme={theme()} fontSize={w.settings().fontSize} fontFamily={w.settings().editorFontFamily} tabSize={w.settings().tabSize} wordWrap={w.settings().wordWrap} revealLine={reveal()?.path === props.path ? reveal()?.line : undefined} revealColumn={reveal()?.path === props.path ? reveal()?.column : undefined} proposal={proposals().find(p => p.path === props.path)} proposalBusy={proposalBusy()} proposalStale={!w.synchronized(props.path)} onApplyProposal={(id, ids) => { void reviewProposal?.(id, ids); }} onRejectProposal={id => { void reviewProposal?.(id, []); }} />}</Show></div>
      <Show when={markdown() || asset()}><div class="preview-view" style={{ display: view() === "source" ? "none" : "flex" }}><Show when={markdown()} fallback={<AssetPreview path={props.path} source={assetSource()} active={previewActive()} loadImage={path => api.readImage(path)} />}><MarkdownPreview text={w.documents()[props.path]?.document || ""} documentPath={`${w.workspace()?.root}/${props.path}`} workspaceRoot={w.workspace()?.root || ""} active={previewActive()} onOpenFile={path => navigate(path)} loadImage={path => api.readImage(path)} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} /></Show></div></Show>
    </div></div>;
  }
  function SettingsDocument() {
    onCleanup(() => { setSettingsDirty(false); saveSettingsDraft = undefined; revertSettingsDraft = undefined; });
    return <SettingsPage settings={w.settings()} settingsJsonc={w.settingsJsonc()} workspaceName={w.workspace()?.name} onChange={w.updateSettings} onSaveJsonc={w.saveSettingsJsonc} onReloadJsonc={w.reloadSettingsJsonc} onDirtyChange={setSettingsDirty} onSaveReady={save => { saveSettingsDraft = save; }} onRevertReady={revert => { revertSettingsDraft = revert; }} tools={<ToolsSettings tools={tools()} desktop={isDesktop} loaded={toolsLoaded()} busy={toolsBusy()} error={toolsError()} onRefresh={detectTools} />} onOpenTools={() => { if (!toolsLoaded()) void detectTools(); }} onOpenAgents={() => { setShowRight(true); queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('[aria-label="Message to agent"]')?.focus()); }} shortcuts={<KeyboardSettings keybindings={w.settings().keybindings} onChange={keybindings => w.updateSettings({ keybindings })} onRecordingChange={setRecordingShortcut} platform={platform} />} />;
  }
  function EditorPane(props: { group: EditorGroup; width?: number }) {
    const groupId = props.group.id;
    const group = () => w.groups().find(item => item.id === groupId) || { id: groupId, tabs: [] as string[], active: undefined };
    const active = () => group().active;
    const documentIsActive = (path: string) => active() === path && w.activeGroup() === group().id;
    return <section class={`panel editor-pane ${w.activeGroup() === group().id ? "active-group" : ""}`} aria-label={`Editor group ${group().id}`} style={{ flex: props.width ? `0 0 ${props.width}px` : "1 1 0" }} onPointerDown={() => w.setActiveGroup(group().id)} onFocusIn={() => w.setActiveGroup(group().id)}>
      <div class="editor-header"><div class="editor-tabs" role="tablist" aria-label={`Open files in group ${group().id}`}><For each={group().tabs}>{path => <div class={`file-tab ${active() === path ? "active" : ""}`} onContextMenu={event => showContext(event, path, "tab", group().id)} onKeyDown={event => { if (isContextMenuKey(event)) showContext(event, path, "tab", group().id); }}><button role="tab" aria-selected={active() === path} aria-controls={`editor-${group().id}`} title={path === SETTINGS_TAB ? "Settings" : path} onClick={() => path === SETTINGS_TAB ? w.openSettings() : void w.openFile(path, group().id)}><Show when={path !== SETTINGS_TAB} fallback={<Icon name="u-gear" size={15} />}><FileIcon path={path} /></Show><span>{path === SETTINGS_TAB ? "Settings" : path.split("/").pop()}</span></button><button class="tab-close" aria-label={`Close ${path === SETTINGS_TAB ? "Settings" : path.split("/").pop()}`} title={(path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)) ? "Unsaved changes, close file" : "Close file"} onClick={() => requestCloseTab(path, group().id)}><Show when={path === SETTINGS_TAB ? settingsDirty() : w.dirty(path)} fallback={<span class="cross" />}><span class="dirty-dot" /></Show></button></div>}</For></div><button class="icon-button split-editor" aria-label="Split editor" title={`Split editor (${shortcut("splitEditor")})`} onClick={w.splitEditor}><Icon name="panel-right" size={15} /></button><button class="icon-button save-file" aria-label="Save file" title={`Save (${shortcut("save")})`} disabled={!active()} onClick={saveActive}><Icon name="TickCircle" size={15} /></button></div>
      <div id={`editor-${group().id}`} class="editor-documents" role="tabpanel"><For each={group().tabs}>{path => <div class="editor-document" style={{ display: active() === path ? "flex" : "none" }}><Show when={path !== SETTINGS_TAB}><DocumentView path={path} group={group().id} active={documentIsActive(path)} /></Show></div>}</For><Show when={!active()}><div class="editor-empty"><AnimatedLogo size={96} /><h1>span</h1><p>A space for code and agents.</p><button onClick={() => setQuickOpen(true)}><span>Open a file</span><kbd>{shortcut("quickOpen")}</kbd></button><button onClick={requestWorkspace}><span>Open a folder</span><kbd>{shortcut("openFolder")}</kbd></button><button onClick={openSearch}><span>Search workspace</span><kbd>{shortcut("searchWorkspace")}</kbd></button><button onClick={() => setPaletteOpen(true)}><span>Show commands</span><kbd>{shortcut("commandPalette")}</kbd></button><Show when={recentProjects().length}><div class="welcome-recents"><span>Recent projects</span><For each={recentProjects().slice(0, 5)}>{project => <button disabled={project.missing} title={project.root} onClick={() => openRecentProject(project.root)}><Icon name="Folder2" size={14} /><span>{project.name}</span><Show when={project.missing}><small>Missing</small></Show></button>}</For></div></Show></div></Show></div>
    </section>;
  }
  const settingsGroup = () => w.groups().findIndex(group => group.active === SETTINGS_TAB);
  const settingsLayerStyle = () => ({ display: settingsGroup() >= 0 ? "flex" : "none", left: `${settingsGroup() > 0 ? centerWidth() * splitFraction() + 4 : 0}px`, width: w.groups().length < 2 ? "100%" : `${settingsGroup() === 0 ? centerWidth() * splitFraction() - 4 : centerWidth() * (1 - splitFraction()) - 4}px` });

  return <main class={`ide theme-${theme()} ${isDesktop ? "desktop" : ""} ${fullscreen() ? "is-fullscreen" : ""} ${nativeTrafficLights() ? "native-traffic-lights" : ""}`} style={{ "--ui-font-size": `${w.settings().uiFontSize}px`, "--ui-font-family": w.settings().uiFontFamily, "--editor-font-family": w.settings().editorFontFamily }} aria-label="span editor">
    <header class="topbar" data-tauri-drag-region><div class="top-left"><span class="traffic-lights" aria-hidden="true"><i /><i /><i /></span><button class={`icon-button ${showLeft() ? "" : "off"}`} aria-label="Toggle project panel" aria-pressed={showLeft()} title={`Toggle project panel (${shortcut("toggleProject")})`} onClick={() => setShowLeft(!showLeft())}><Icon name="panel-left" /></button><button class={`icon-button ${showBottom() ? "" : "off"}`} aria-label="Toggle terminal panel" aria-pressed={showBottom()} title={`Toggle terminal panel (${shortcut("toggleTerminal")})`} onClick={() => setShowBottom(!showBottom())}><Icon name="panel-bottom" /></button><button class={`icon-button ${showRight() ? "" : "off"}`} aria-label="Toggle AI Assistant panel" aria-pressed={showRight()} title={`Toggle AI Assistant (${shortcut("toggleAssistant")})`} onClick={() => setShowRight(!showRight())}><Icon name="panel-right" /></button><span class="toolbar-separator" /><button class="icon-button" aria-label="Open quick open" title={`Go to file (${shortcut("quickOpen")})`} onClick={() => setQuickOpen(true)}><Icon name="goto" /></button><button class="icon-button open-folder-toolbar" aria-label="Open folder" title={`Open folder (${shortcut("openFolder")})`} onClick={requestWorkspace}><Icon name="Folder2" /></button></div><div class="top-center"><button class="project-title" aria-label="Recent projects" aria-haspopup="menu" onClick={showProjectHistory}>{w.workspace()?.name || "span"}</button><button class="branch-button" aria-label="Source control" title="Source control, phase 0.3" onClick={() => { setShowLeft(true); setLeftView("Git"); }}><Icon name="Hierarchy" size={14} /><span>{isDesktop ? "workspace" : "main"}</span></button></div><div class="top-right"><img class="product-logo" src="/span-logo.svg" alt="span" title="span, phase 0.1" /><button class="icon-button blue" aria-label="Show AI Assistant" onClick={() => setShowRight(true)}><Icon name="flash" /></button><button class="icon-button" aria-label="Show terminal" title="Terminal, phase 0.3" onClick={() => setShowBottom(true)}><Icon name="u-play" /></button><button class="icon-button" aria-label="Search workspace" title={`Search workspace (${shortcut("searchWorkspace")})`} onClick={openSearch}><Icon name="SearchNormal1" /></button><button class="icon-button" aria-label="Settings" title={`Settings (${shortcut("settings")})`} onClick={openSettings}><Icon name="u-gear" /></button></div></header>
    <div class="workbench-main">
      <aside class="panel explorer-panel" style={{ width: `${leftWidth()}px`, display: showLeft() ? "flex" : "none" }} aria-label="Project" onContextMenu={treeContext} onKeyDown={treeContext}><div class="panel-header explorer-header"><For each={["Files", "Search", "Git", "History"] as const}>{view => <button class={`panel-tab ${leftView() === view ? "selected" : ""}`} aria-pressed={leftView() === view} onClick={() => { setLeftView(view); if (view === "Search") openSearch(); }}>{view}</button>}</For><button class="icon-button" aria-label="Open folder" onClick={requestWorkspace}><Icon name="Add" /></button></div><Explorer workbench={w} view={leftView()} onNavigate={navigate} /></aside>
      <PanelHandle label="Resize project panel" restoreLabel="Restore project panel" direction="horizontal" value={leftWidth()} min={200} max={Math.min(1000, windowWidth() * .42)} collapsed={!showLeft()} onResize={setLeftWidth} onShown={setShowLeft} />
      <div class="center-area" ref={centerElement}><div class="editor-groups"><For each={w.groups().map(group => group.id)}>{(id, index) => <><Show when={index() > 0}><ResizeHandle label="Resize editor groups" direction="horizontal" value={centerWidth() * splitFraction()} min={centerWidth() * .2} max={centerWidth() * .8} onResize={width => setSplitFraction(width / centerWidth())} /></Show><EditorPane group={w.groups().find(group => group.id === id)!} width={w.groups().length > 1 && index() === 0 ? centerWidth() * splitFraction() - 4 : undefined} /></>}</For><div class="settings-view-layer" style={settingsLayerStyle()} onFocusIn={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }} onPointerDown={() => { const group = w.groups()[settingsGroup()]; if (group) w.setActiveGroup(group.id); }}><SettingsDocument /></div></div>
      <PanelHandle label="Resize terminal panel" restoreLabel="Restore terminal panel" direction="vertical" reverse value={bottomHeight()} min={100} max={Math.min(1000, window.innerHeight * .7)} collapsed={!showBottom()} onResize={setBottomHeight} onShown={setShowBottom} />
      <section class="panel terminal-panel" style={{ height: `${bottomHeight()}px`, display: showBottom() ? "flex" : "none" }} aria-label="Terminal"><div class="panel-header"><span class="panel-tab selected">Terminal<button class="close-button" aria-label="Close terminal panel" onClick={() => setShowBottom(false)}>×</button></span><span class="phase-note">Phase 0.3</span></div><div class="terminal-empty"><Icon name="u-terminal" size={18} /><span>Terminal sessions will be available in phase 0.3.</span></div></section></div>
      <PanelHandle label="Resize AI Assistant panel" restoreLabel="Restore AI Assistant panel" direction="horizontal" reverse value={rightWidth()} min={260} max={Math.min(1000, windowWidth() * .42)} collapsed={!showRight()} onResize={setRightWidth} onShown={setShowRight} />
      <aside class="panel assistant-panel" style={{ width: `${rightWidth()}px`, display: showRight() ? "flex" : "none" }} aria-label="AI Assistant panel"><AgentPanel workspacePath={w.workspace()?.root} workspaceGeneration={w.workspaceGeneration()} onProposalsChange={proposalsChanged} onReviewInEditor={path => navigate(path)} onReviewReady={review => { reviewProposal = review; }} onReviewBusyChange={setProposalBusy} activePath={w.activePath()} selectionContext={selectionContext()} onBufferChanged={(path, snapshot) => void w.acceptAgentBuffer(path, snapshot)} onOpenSettings={openSettings} onOpenFile={path => navigate(path)} onFilesChanged={() => w.refreshTree()} onOpenExternal={url => void api.openExternal(url).catch(error => w.setError(String(error)))} /></aside>
    </div>
    <footer class="statusbar"><div class="breadcrumbs"><Show when={w.activePath()} fallback={<span>{w.activeTab() === SETTINGS_TAB ? "Workspace settings" : w.busy() ? "Opening folder…" : "Ready"}</span>}><Breadcrumbs path={w.activePath()} workspace={w.workspace()} listDirectory={api.listDirectory} onOpen={path => navigate(path)} onReveal={path => void revealPath(path)} onContextMenu={(event, path, directory) => showContext(event, path, directory ? "directory" : "file")} /></Show></div><div class="status-right"><Show when={!isDesktop}><span class="preview-label" title={previewNotice}>Browser preview</span></Show><span>{cursor().line}:{cursor().column}</span><span>UTF-8</span><span>{w.buffers[w.activePath() || ""]?.language || "Plain text"}</span><span class="version-label">span 0.1.0</span></div></footer>
    <Show when={w.error()}><div class="error-toast" role="alert"><Icon name="Warning2" /><span>{w.error()}</span><Show when={w.activePath() && w.failed().has(w.activePath()!)}><button onClick={() => void w.save()}>Retry</button><button onClick={() => { const path = w.activePath(); if (path) void w.acceptAgentBuffer(path); }}>Recover draft</button></Show><button class="close-button" aria-label="Dismiss notification" onClick={() => w.setError("")}>×</button></div></Show>
    <Show when={quickOpen()}><QuickOpen files={w.files()} onOpen={navigate} onClose={() => setQuickOpen(false)} onOpenFolder={requestWorkspace} workspace={w.workspace()} recentPaths={w.recentPaths()} handlers={handlers} bindings={bindings()} onPreview={async path => { const document = w.documents()[path]?.document; if (document) return document.sliceString(0, 64 * 1024); if (isBinaryAssetPath(path)) return "Image preview is available when opened."; return (await api.openBuffer(path)).text.slice(0, 64 * 1024); }} onSearch={api.search} /></Show>
    <Show when={context()}>{menu => <ContextMenu x={menu().x} y={menu().y} items={menu().items} label={menu().label} onClose={() => setContext(undefined)} />}</Show>
    <Show when={paletteOpen()}><CommandPalette bindings={bindings()} handlers={handlers} onClose={() => setPaletteOpen(false)} platform={platform} /></Show>
    <Show when={pendingSettingsClose()}>{action => <Modal label="Unsaved settings" class="confirm-modal" onClose={() => setPendingSettingsClose(undefined)}><h2>Save changes to workspace settings?</h2><p>Your JSONC draft has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { const next = action(); revertSettingsDraft?.(); setPendingSettingsClose(undefined); next(); }}>Discard changes</button><span /><button class="button" onClick={() => setPendingSettingsClose(undefined)}>Cancel</button><button class="button primary" onClick={() => { const next = action(); void settleIntent(next, current => pendingSettingsClose() === current, async () => await saveSettingsDraft?.() || false, () => { setPendingSettingsClose(undefined); next(); }); }}>Save</button></div></Modal>}</Show>
    <Show when={pendingExternal()}>{pending => <Modal label="Open requested project" class="confirm-modal" onClose={() => { pending().resolve(false); setPendingExternal(undefined); }}><h2>Open another project?</h2><p>A file or command-line request wants to open {pending().request.workspaceRoot}. This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { revertSettingsDraft?.(); pending().resolve(true); setPendingExternal(undefined); }}>Discard changes</button><span /><button class="button" onClick={() => { pending().resolve(false); setPendingExternal(undefined); }}>Cancel</button><button class="button primary" onClick={() => { const request = pending(); void settleIntent(request, current => pendingExternal() === current, async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || pendingExternal() !== request) return false; } if (settingsDirty() && !await saveSettingsDraft?.()) return false; return !hasUnsaved(); }, () => { request.resolve(true); setPendingExternal(undefined); }); }}>Save all</button></div></Modal>}</Show>
    <Show when={w.pendingClose()}>{pending => <Modal label="Unsaved changes" class="confirm-modal" onClose={() => void w.confirmClose("cancel")}><Icon name="DocumentText" size={28} /><h2>Save changes to {pending().path.split("/").pop()}?</h2><p>Your changes will be lost if you close this file without saving.</p><div class="dialog-actions"><button class="button" onClick={() => void w.confirmClose("discard")}>Discard changes</button><span /><button class="button" onClick={() => void w.confirmClose("cancel")}>Cancel</button><button class="button primary" onClick={() => void w.confirmClose("save")}>Save</button></div></Modal>}</Show>
    <Show when={pendingAppClose()}><Modal label="Close span" class="confirm-modal" onClose={cancelClose}><h2>Save changes before closing?</h2><p>This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { void closeWindow(true); }}>Discard changes</button><span /><button class="button" onClick={cancelClose}>Cancel</button><button class="button primary" onClick={() => { const intent = closeIntent; void settleIntent(intent, current => current === closeIntent && pendingAppClose(), async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) { if (!await w.save(path) || intent !== closeIntent) return false; } if (settingsDirty() && !await saveSettingsDraft?.()) return false; return !hasUnsaved(); }, () => closeWindow(false, intent)); }}>Save all</button></div></Modal></Show>
    <Show when={w.pendingRecovery()}>{recovery => <Modal label="Retained local draft" class="confirm-modal" onClose={() => w.resolveRecovery(false)}><h2>Your newer local draft was retained</h2><p>The current accepted document is open in {recovery().path.split("/").pop()}. You can keep it or restore your local draft for review.</p><div class="dialog-actions"><button class="button" onClick={() => w.resolveRecovery(false)}>Keep current document</button><span /><button class="button primary" onClick={() => w.resolveRecovery(true)}>Restore my draft</button></div></Modal>}</Show>
    <Show when={w.pendingWorkspace()}><Modal label="Open another folder" class="confirm-modal" onClose={() => w.setPendingWorkspace(false)}><h2>Open another folder?</h2><p>There are unsaved changes in this workspace. Discard them to open another folder.</p><div class="dialog-actions"><span /><button class="button" onClick={() => w.setPendingWorkspace(false)}>Cancel</button><button class="button primary" onClick={() => { w.setPendingWorkspace(false); void w.openWorkspace(); }}>Discard and open folder</button></div></Modal></Show>
  </main>;
}
