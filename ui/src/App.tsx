import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor, type EditorCursor } from "./components/Editor";
import AgentPanel from "./components/AgentPanel";
import { Explorer } from "./components/Explorer";
import Icon, { FileIcon } from "./components/Icon";
import { Modal } from "./components/Modal";
import { QuickOpen } from "./components/QuickOpen";
import { ResizeHandle } from "./components/ResizeHandle";
import { Settings } from "./components/Settings";
import { createWorkbench, type EditorGroup } from "./stores/workbench";
import { api, isDesktop, previewNotice } from "./lib/client";
import type { EditProposal, SyntaxSnapshot } from "./bindings";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/workbench.css";
import "./styles/file-icons.css";

export default function App() {
  const w = createWorkbench();
  const [showLeft, setShowLeft] = createSignal(true);
  const [showRight, setShowRight] = createSignal(true);
  const [showBottom, setShowBottom] = createSignal(true);
  const [leftWidth, setLeftWidth] = createSignal(Math.max(230, Math.round(window.innerWidth * .25) - 12));
  const [rightWidth, setRightWidth] = createSignal(Math.max(260, Math.round(window.innerWidth * .25) - 12));
  const [centerWidth, setCenterWidth] = createSignal(Math.round(window.innerWidth * .48));
  const [splitFraction, setSplitFraction] = createSignal(.5);
  let centerElement!: HTMLDivElement;
  const [bottomHeight, setBottomHeight] = createSignal(Math.round(window.innerHeight * .31));
  const [leftView, setLeftView] = createSignal<"Files" | "Search" | "Git" | "History">("Files");
  const [quickOpen, setQuickOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [pendingAppClose, setPendingAppClose] = createSignal(false);
  const [proposals, setProposals] = createSignal<EditProposal[]>([]);
  const [proposalBusy, setProposalBusy] = createSignal(false);
  let reviewProposal: ((id: string, hunkIds: string[]) => Promise<void>) | undefined;
  const proposalsChanged = (next: EditProposal[]) => { const prior = new Set(proposals().map(proposal => proposal.id)); setProposals(next); const added = next.find(proposal => !prior.has(proposal.id)); if (added) void w.openFile(added.path); };
  let allowAppClose = false;
  let unlistenClose: (() => void) | undefined;
  let disposed = false;
  const [cursor, setCursor] = createSignal<EditorCursor>({ line: 1, column: 1, from: 0, to: 0, selectedText: "" });
  const [reveal, setReveal] = createSignal<{ path: string; line: number }>();
  const theme = () => w.settings().theme.toLowerCase() as "dark" | "light" | "purple";
  const selectionContext = () => { const path = w.activePath(); const current = cursor(); return path && current.selectedText ? { path, text: current.selectedText, startLine: current.line, endLine: current.line + current.selectedText.split("\n").length - 1 } : undefined; };
  const navigate = (path: string, line?: number) => { void w.openFile(path).then(() => setReveal(line ? { path, line } : undefined)); };
  const openSearch = () => { batch(() => { setShowLeft(true); setLeftView("Search"); }); queueMicrotask(() => document.getElementById("workspace-search")?.focus()); };
  const keyboard = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "k" || key === "p") { event.preventDefault(); setQuickOpen(true); }
    else if (key === "f" && event.shiftKey) { event.preventDefault(); openSearch(); }
    else if (key === "b") { event.preventDefault(); event.altKey ? setShowRight(!showRight()) : setShowLeft(!showLeft()); }
    else if (key === "j") { event.preventDefault(); setShowBottom(!showBottom()); }
    else if (key === "\\") { event.preventDefault(); w.splitEditor(); }
    else if (key === "s") { event.preventDefault(); void w.save(); }
    else if (key === "o") { event.preventDefault(); w.requestWorkspace(); }
    else if (key === ",") { event.preventDefault(); setSettingsOpen(true); }
  };
  const beforeUnload = (event: BeforeUnloadEvent) => { if (w.hasDirty()) { event.preventDefault(); event.returnValue = ""; } };
  onMount(() => {
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width) setCenterWidth(width); });
    observer.observe(centerElement); onCleanup(() => observer.disconnect());
    window.addEventListener("keydown", keyboard); window.addEventListener("beforeunload", beforeUnload); void w.initialize();
    if (isDesktop) void getCurrentWindow().onCloseRequested(event => { if (!allowAppClose && w.hasDirty()) { event.preventDefault(); setPendingAppClose(true); } }).then(unlisten => { if (disposed) unlisten(); else unlistenClose = unlisten; });
  });
  onCleanup(() => { window.removeEventListener("keydown", keyboard); window.removeEventListener("beforeunload", beforeUnload); disposed = true; unlistenClose?.(); });
  createEffect(() => { document.documentElement.dataset.theme = theme(); });

  function DocumentView(props: { path: string; group: number; active: boolean }) {
    const [syntax, setSyntax] = createSignal<SyntaxSnapshot>();
    createEffect(() => {
      const path = props.path; const doc = w.documents()[path]?.document; const revision = w.buffers[path]?.revision;
      setSyntax(undefined);
      if (!doc || !isDesktop || !props.active) return;
      const timer = setTimeout(() => {
        if (!w.synchronized(path)) return;
        void api.syntax(path).then(result => { if (w.documents()[path]?.document === doc && w.buffers[path]?.revision === revision && result.revision === revision) setSyntax(result); }).catch(() => undefined);
      }, 100);
      onCleanup(() => clearTimeout(timer));
    });
    return <Show when={w.buffers[props.path]}>{buffer => <Editor buffer={buffer()} document={w.documents()[props.path]?.document} change={w.documents()[props.path]?.change} onEdit={edit => w.edit(props.path, edit)} onUndo={() => w.applyHistory(props.path)} onRedo={() => w.applyHistory(props.path, true)} onSave={() => { void w.save(props.path); }} onCursor={value => { if (props.active) setCursor(value); }} syntax={syntax()} active={props.active} theme={theme()} fontSize={w.settings().fontSize} tabSize={w.settings().tabSize} wordWrap={w.settings().wordWrap} revealLine={reveal()?.path === props.path ? reveal()?.line : undefined} proposal={proposals().find(proposal => proposal.path === props.path)} proposalBusy={proposalBusy()} proposalStale={!w.synchronized(props.path)} onApplyProposal={(id, hunkIds) => { void reviewProposal?.(id, hunkIds); }} onRejectProposal={id => { void reviewProposal?.(id, []); }} />}</Show>;
  }
  function EditorPane(props: { group: EditorGroup; width?: number }) {
    const active = () => props.group.active;
    return <section class={`panel editor-pane ${w.activeGroup() === props.group.id ? "active-group" : ""}`} aria-label={`Editor group ${props.group.id}`} style={{ flex: props.width ? `0 0 ${props.width}px` : "1 1 0" }} onPointerDown={() => w.setActiveGroup(props.group.id)} onFocusIn={() => w.setActiveGroup(props.group.id)}>
      <div class="editor-header"><div class="editor-tabs" role="tablist" aria-label={`Open files in group ${props.group.id}`}><For each={props.group.tabs}>{path => <div class={`file-tab ${active() === path ? "active" : ""}`}>
        <button role="tab" aria-selected={active() === path} aria-controls={`editor-${props.group.id}`} title={path} onClick={() => void w.openFile(path, props.group.id)}><FileIcon path={path} /><span>{path.split("/").pop()}</span></button><button class="tab-close" aria-label={`Close ${path.split("/").pop()}`} title={w.dirty(path) ? "Unsaved changes, close file" : "Close file"} onClick={() => w.closeTab(path, props.group.id)}><Show when={w.dirty(path)} fallback={<span class="cross" />}><span class="dirty-dot" /></Show></button>
      </div>}</For></div><button class="icon-button split-editor" aria-label="Split editor" title="Split editor (⌘\\)" onClick={w.splitEditor}><Icon name="panel-right" size={15} /></button><button class="icon-button save-file" aria-label="Save file" title="Save file (⌘S)" disabled={!active()} onClick={() => void w.save(active())}><Icon name="TickCircle" size={15} /></button></div>
      <div id={`editor-${props.group.id}`} class="editor-documents" role="tabpanel"><For each={props.group.tabs}>{path => <div class="editor-document" style={{ display: active() === path ? "flex" : "none" }}><DocumentView path={path} group={props.group.id} active={active() === path && w.activeGroup() === props.group.id} /></div>}</For><Show when={!active()}><div class="editor-empty"><span class="span-wordmark">span</span><p>A space for code and agents.</p><button onClick={() => setQuickOpen(true)}><span>Open a file</span><kbd>⌘ K</kbd></button><button onClick={w.requestWorkspace}><span>Open a folder</span><kbd>⌘ O</kbd></button><button onClick={openSearch}><span>Search workspace</span><kbd>⌘ ⇧ F</kbd></button></div></Show></div>
    </section>;
  }
  const breadcrumbs = createMemo(() => w.activePath()?.split("/") || []);
  return <main class={`ide theme-${theme()} ${isDesktop ? "desktop" : ""}`} aria-label="span editor">
    <header class="topbar" data-tauri-drag-region>
      <div class="top-left"><span class="traffic-lights" aria-hidden="true"><i /><i /><i /></span><button class={`icon-button ${showLeft() ? "" : "off"}`} aria-label="Toggle project panel" aria-pressed={showLeft()} title="Toggle project panel (⌘B)" onClick={() => setShowLeft(!showLeft())}><Icon name="panel-left" /></button><button class={`icon-button ${showBottom() ? "" : "off"}`} aria-label="Toggle terminal panel" aria-pressed={showBottom()} title="Toggle terminal panel (⌘J)" onClick={() => setShowBottom(!showBottom())}><Icon name="panel-bottom" /></button><button class={`icon-button ${showRight() ? "" : "off"}`} aria-label="Toggle AI Assistant panel" aria-pressed={showRight()} title="Toggle AI Assistant panel (⌥⌘B)" onClick={() => setShowRight(!showRight())}><Icon name="panel-right" /></button><span class="toolbar-separator" /><button class="icon-button" aria-label="Open quick open" title="Quick open (⌘K)" onClick={() => setQuickOpen(true)}><Icon name="goto" /></button><button class="icon-button open-folder-toolbar" aria-label="Open folder" title="Open folder (⌘O)" onClick={w.requestWorkspace}><Icon name="Folder2" /></button></div>
      <div class="top-center"><button class="project-title" onClick={() => setQuickOpen(true)}>{w.workspace()?.name || "span"}</button><button class="branch-button" aria-label="Source control" title="Source control, phase 0.3" onClick={() => { setShowLeft(true); setLeftView("Git"); }}><Icon name="Hierarchy" size={14} /><span>{isDesktop ? "workspace" : "main"}</span></button></div>
      <div class="top-right"><img class="product-logo" src="/span-logo.svg" alt="span" title="span, phase 0.1" /><button class="icon-button blue" aria-label="Show AI Assistant" title="AI Assistant" onClick={() => setShowRight(true)}><Icon name="flash" /></button><button class="icon-button" aria-label="Show terminal" title="Terminal, phase 0.3" onClick={() => setShowBottom(true)}><Icon name="u-play" /></button><button class="icon-button" aria-label="Search workspace" title="Search workspace (⌘⇧F)" onClick={openSearch}><Icon name="SearchNormal1" /></button><button class="icon-button" aria-label="Settings" title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}><Icon name="u-gear" /></button></div>
    </header>
    <div class="workbench-main">
      <Show when={showLeft()}><aside class="panel explorer-panel" style={{ width: `${leftWidth()}px` }} aria-label="Project"><div class="panel-header explorer-header"><For each={["Files", "Search", "Git", "History"] as const}>{view => <button class={`panel-tab ${leftView() === view ? "selected" : ""}`} aria-pressed={leftView() === view} onClick={() => { setLeftView(view); if (view === "Search") openSearch(); }}>{view}</button>}</For><button class="icon-button" aria-label="Open folder" title="Open folder" onClick={w.requestWorkspace}><Icon name="Add" /></button></div><Explorer workbench={w} view={leftView()} onNavigate={navigate} /></aside><ResizeHandle label="Resize project panel" direction="horizontal" value={leftWidth()} min={200} max={Math.max(250, window.innerWidth * .42)} onResize={setLeftWidth} /></Show>
      <div class="center-area" ref={centerElement}><div class="editor-groups"><For each={w.groups().map(group => group.id)}>{(id, index) => <><Show when={index() > 0}><ResizeHandle label="Resize editor groups" direction="horizontal" value={centerWidth() * splitFraction()} min={centerWidth() * .2} max={centerWidth() * .8} onResize={width => setSplitFraction(width / centerWidth())} /></Show><EditorPane group={w.groups().find(group => group.id === id)!} width={w.groups().length > 1 && index() === 0 ? centerWidth() * splitFraction() - 4 : undefined} /></>}</For></div><Show when={showBottom()}><ResizeHandle label="Resize terminal panel" direction="vertical" reverse value={bottomHeight()} min={100} max={Math.max(160, window.innerHeight * .7)} onResize={setBottomHeight} /><section class="panel terminal-panel" style={{ height: `${bottomHeight()}px` }} aria-label="Terminal"><div class="panel-header"><span class="panel-tab selected">Terminal<button class="close-button" aria-label="Close terminal panel" onClick={() => setShowBottom(false)}>×</button></span><span class="phase-note">Phase 0.3</span></div><div class="terminal-empty"><Icon name="u-terminal" size={18} /><span>Terminal sessions will be available in phase 0.3.</span></div></section></Show></div>
      <Show when={showRight()}><ResizeHandle label="Resize AI Assistant panel" direction="horizontal" reverse value={rightWidth()} min={260} max={Math.max(280, window.innerWidth * .42)} onResize={setRightWidth} /></Show><aside class="panel assistant-panel" style={{ width: `${rightWidth()}px`, display: showRight() ? "flex" : "none" }} aria-label="AI Assistant panel"><AgentPanel workspacePath={w.workspace()?.root} workspaceGeneration={w.workspaceGeneration()} onProposalsChange={proposalsChanged} onReviewInEditor={path => navigate(path)} onReviewReady={review => { reviewProposal = review; }} onReviewBusyChange={setProposalBusy} activePath={w.activePath()} selectionContext={selectionContext()} onBufferChanged={(path, snapshot) => void w.acceptAgentBuffer(path, snapshot)} onOpenSettings={() => setSettingsOpen(true)} /></aside>
    </div>
    <footer class="statusbar"><div class="breadcrumbs"><For each={breadcrumbs()}>{(part, index) => <><Show when={index() > 0}><Icon name="arrow-right4" size={10} /></Show><span>{part}</span></>}</For><Show when={!w.activePath()}><span>{w.busy() ? "Opening folder…" : "Ready"}</span></Show></div><div class="status-right"><Show when={!isDesktop}><span class="preview-label" title={previewNotice}>Browser preview</span></Show><span>{cursor().line}:{cursor().column}</span><span>UTF-8</span><span>{w.buffers[w.activePath() || ""]?.language || "Plain text"}</span><span class="version-label">span 0.1.0</span></div></footer>
    <Show when={w.error()}><div class="error-toast" role="alert"><Icon name="Warning2" /><span>{w.error()}</span><Show when={w.activePath() && w.failed().has(w.activePath()!)}><button onClick={() => void w.save()}>Retry</button><button onClick={() => { const path = w.activePath(); if (path) void w.acceptAgentBuffer(path); }}>Recover draft</button></Show><button class="close-button" aria-label="Dismiss notification" onClick={() => w.setError("")}>×</button></div></Show>
    <Show when={quickOpen()}><QuickOpen files={w.files()} onOpen={navigate} onClose={() => setQuickOpen(false)} onOpenFolder={w.requestWorkspace} /></Show>
    <Show when={settingsOpen()}><Settings settings={w.settings()} workspaceName={w.workspace()?.name} onChange={w.updateSettings} onJsonSaved={w.setSettings} onClose={() => setSettingsOpen(false)} /></Show>
    <Show when={w.pendingClose()}>{pending => <Modal label="Unsaved changes" class="confirm-modal" onClose={() => void w.confirmClose("cancel")}><Icon name="DocumentText" size={28} /><h2>Save changes to {pending().path.split("/").pop()}?</h2><p>Your changes will be lost if you close this file without saving.</p><div class="dialog-actions"><button class="button" onClick={() => void w.confirmClose("discard")}>Discard changes</button><span /><button class="button" onClick={() => void w.confirmClose("cancel")}>Cancel</button><button class="button primary" onClick={() => void w.confirmClose("save")}>Save</button></div></Modal>}</Show>
    <Show when={pendingAppClose()}><Modal label="Close span" class="confirm-modal" onClose={() => setPendingAppClose(false)}><h2>Save changes before closing?</h2><p>This workspace has unsaved changes.</p><div class="dialog-actions"><button class="button" onClick={() => { allowAppClose = true; void getCurrentWindow().close(); }}>Discard changes</button><span /><button class="button" onClick={() => setPendingAppClose(false)}>Cancel</button><button class="button primary" onClick={() => { void (async () => { for (const path of Object.keys(w.buffers).filter(w.dirty)) if (!await w.save(path)) return; if (w.hasDirty()) return; allowAppClose = true; await getCurrentWindow().close(); })(); }}>Save all</button></div></Modal></Show>
    <Show when={w.pendingRecovery()}>{recovery => <Modal label="Retained local draft" class="confirm-modal" onClose={() => w.resolveRecovery(false)}><h2>Your newer local draft was retained</h2><p>The current accepted document is open in {recovery().path.split("/").pop()}. You can keep it or restore your local draft for review.</p><div class="dialog-actions"><button class="button" onClick={() => w.resolveRecovery(false)}>Keep current document</button><span /><button class="button primary" onClick={() => w.resolveRecovery(true)}>Restore my draft</button></div></Modal>}</Show>
    <Show when={w.pendingWorkspace()}><Modal label="Open another folder" class="confirm-modal" onClose={() => w.setPendingWorkspace(false)}><h2>Open another folder?</h2><p>There are unsaved changes in this workspace. Discard them to open another folder.</p><div class="dialog-actions"><span /><button class="button" onClick={() => w.setPendingWorkspace(false)}>Cancel</button><button class="button primary" onClick={() => { w.setPendingWorkspace(false); void w.openWorkspace(); }}>Discard and open folder</button></div></Modal></Show>
  </main>;
}
