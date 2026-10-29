import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { api, isDesktop } from "../../lib/client";
import type { AgentController } from "../../lib/agent-controller";
import { liveSessions } from "../../lib/agent-stores/live-sessions";
import { agentLimits } from "../../lib/agent-stores/limits";
import { findHealth } from "../../lib/agent-health";
import { readLastConfig } from "../../lib/last-config";
import { friendlyAgentName } from "../../lib/live-agents";
import { NARROW_WINDOW, RAIL_WIDTH, SIDE_OPEN_KEY, SIDE_WIDTH, SIDE_WIDTH_KEY, clampWidth, currentThreadState, planLimits, railRows, readSideWidth, readStored, readWidth, sidePanelDefault, sidePanelMax, sidePanelOpenByDefault, writeStored, type RailRow } from "../../lib/agents-page";
import { threadRowMeta } from "../../lib/session-threads";
import { Modal } from "../Modal";
import { NewSessionPicker, type PickerAgent } from "./NewSessionPicker";
import { PlanLimits } from "./PlanLimits";
import { PageGrip } from "./PageGrip";
import { SessionsRail, type RailScope } from "./SessionsRail";
import { SIDE_TABS, SidePanel, type SideTab } from "./SidePanel";
import { ThreadView } from "./ThreadView";
import "../../styles/agents-page.css";

export type AgentsPageProps = {
  agent: AgentController;
  workspaceRoot?: string;
  workspaceName: string;
  windowWidth: number;
  /** Switch to Editor mode, where the sidebar shows the same thread. */
  onOpenEditor: () => void;
  /** Open a workspace file in the editor (switches to Editor mode). */
  onOpenFile: (path: string) => void;
  /** Bumped by the app for Cmd+N while the page is shown. */
  newRequest?: number;
  searchShortcut?: string;
  newShortcut?: string;
};

const isSideTab = (value: string | undefined): value is SideTab => SIDE_TABS.some((tab) => tab.id === value);

/**
 * The Agents page (ADR 0011 phase 3): the sessions rail, the thread and the side panel, in place of the editor area.
 * It reads the same controller as the sidebar, so a thread is the same thread in both views, and switching view never
 * starts, stops or reloads a session.
 */
export function AgentsPage(props: AgentsPageProps) {
  const a = props.agent;
  const live = liveSessions.use();
  const [now, setNow] = createSignal(Date.now());
  const [railOpen, setRailOpen] = createSignal(readStored("railOpen") !== "false");
  const [railWidth, setRailWidth] = createSignal(readWidth("railWidth", RAIL_WIDTH));
  // The side panel's open state and width are the user's choice once made; until then they follow the window.
  const storedOpen = readStored(SIDE_OPEN_KEY);
  const [sideChoice, setSideChoice] = createSignal<boolean | undefined>(storedOpen === "true" ? true : storedOpen === "false" ? false : undefined);
  const [sideWidth, setSideWidth] = createSignal<number | undefined>(readSideWidth());
  const storedTab = readStored("sideTab");
  const [sideTab, setSideTab] = createSignal<SideTab>(isSideTab(storedTab) ? storedTab : "changes");
  const [searchRequest, setSearchRequest] = createSignal(0);
  const [picking, setPicking] = createSignal(false);
  const [renaming, setRenaming] = createSignal<{ row: RailRow; title: string }>();
  /** Below `NARROW_WINDOW` the rail leaves the layout and opens as an overlay over the thread. */
  const narrow = () => props.windowWidth < NARROW_WINDOW;
  const [overlayOpen, setOverlayOpen] = createSignal(false);
  createEffect(on(narrow, () => setOverlayOpen(false), { defer: true }));
  const railShown = () => (narrow() ? overlayOpen() : railOpen());
  const limits = agentLimits.use();
  const sideMax = () => sidePanelMax(props.windowWidth, railOpen() && !narrow() ? railWidth() : 0);
  const shownSideWidth = () => clampWidth(sideWidth() ?? sidePanelDefault(props.windowWidth), SIDE_WIDTH.min, sideMax());
  /** Something for the side panel to show: proposed edits or delegated tasks (the delegates in the Agents tab). */
  const sideHasContent = () => a.feed().some((item) => item.kind === "proposal" || item.kind === "delegation");
  const sideOpen = () => sideChoice() ?? sidePanelOpenByDefault(props.windowWidth, sideHasContent());
  const setSideOpen = (open: boolean) => setSideChoice(open);

  createEffect(() => writeStored("railOpen", String(railOpen())));
  createEffect(() => writeStored("railWidth", String(railWidth())));
  createEffect(() => {
    const choice = sideChoice();
    if (choice !== undefined) writeStored(SIDE_OPEN_KEY, String(choice));
  });
  createEffect(() => {
    const width = sideWidth();
    if (width !== undefined) writeStored(SIDE_WIDTH_KEY, String(width));
  });
  createEffect(() => writeStored("sideTab", sideTab()));

  onMount(() => {
    if (isDesktop) void live.start();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    // Cmd+K (Ctrl+K) searches sessions while the page is shown; nothing else in the app binds it.
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return;
      event.preventDefault();
      if (narrow()) setOverlayOpen(true);
      else if (!railOpen()) setRailOpen(true);
      setSearchRequest((value) => value + 1);
    };
    window.addEventListener("keydown", keyboard);
    onCleanup(() => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", keyboard);
    });
  });
  // The rail lists the agent's sessions: read them when the page opens, the agent connects, or the scope changes.
  createEffect(
    on(
      () => [a.connected(), a.state().canList, a.sessionScope(), a.agentId()] as const,
      ([connected, canList]) => {
        if (connected && canList) void a.loadSessions();
      },
    ),
  );

  const waiting = (): "approval" | "answer" | undefined => (a.permission() || a.childPermission() ? "approval" : a.elicitation() ? "answer" : undefined);
  const current = createMemo(() => {
    const id = a.state().sessionId;
    const agent = a.state().agent;
    const name = agent?.title || agent?.name || a.agentName();
    const own = a.agentId() ?? agent?.name;
    const agents = [...(own && name ? [{ id: own, name }] : []), ...(id ? threadRowMeta(a.threadFor(id)).agents.filter((entry) => entry.id !== own) : [])];
    return { sessionId: id, title: a.currentTitle(), agents, ...currentThreadState({ running: a.running(), waiting: waiting(), failed: Boolean(a.state().failure), stopping: a.state().stopRequested, connected: a.connected(), queued: a.queue().length }) };
  });
  const rows = createMemo(() => {
    const agent = a.state().agent;
    const name = agent?.title || agent?.name || a.agentName();
    const id = a.agentId() ?? agent?.name;
    return railRows({
      listed: a.sessions(),
      metas: a.sessionMeta(),
      agentId: a.agentId(),
      threadFor: a.threadFor,
      statusOf: a.rowStatus,
      brand: id && name ? { id, name } : undefined,
      current: current(),
      live: live.sessions(),
      focusedConnection: a.focusedThread().key.connectionId || undefined,
      workspace: props.workspaceRoot,
      canLoad: Boolean(a.state().canLoad),
      now: now(),
    });
  });

  const openRow = (row: RailRow) => {
    if (row.unavailable) return;
    setPicking(false);
    setOverlayOpen(false);
    if (row.current) {
      a.focusPrompt();
      return;
    }
    void a.resumeChat(row.sessionId);
  };
  const newBlocked = () => (a.working() ? "Wait until the agent finishes connecting" : undefined);
  const newSession = () => {
    if (newBlocked()) return;
    setOverlayOpen(false);
    if (a.installed().length) setPicking(true);
    else if (a.connected()) void a.newChat();
    else setup();
  };
  /** Lead agent cards: every installed agent, the connected one first, with its model and health when known. */
  const pickerAgents = createMemo<PickerAgent[]>(() => {
    const connectedId = a.connected() ? a.agentId() : undefined;
    const modelOption = a.state().config.find((option) => option.category === "model");
    const modelName = modelOption ? modelOption.groups.flatMap((group) => group.choices).find((choice) => choice.value === modelOption.currentValue)?.name : undefined;
    return a
      .installed()
      .map((entry) => {
        const name = a.registryName(entry.id) || friendlyAgentName(entry.id);
        const connected = entry.id === connectedId;
        return { id: entry.id, name, connected, model: connected ? modelName : readLastConfig(entry.id).model, health: findHealth(a.health(), entry.id, name) };
      })
      .sort((x, y) => Number(y.connected) - Number(x.connected));
  });
  const pickLead = (id: string) => {
    setPicking(false);
    if (a.connected() && a.agentId() === id) void a.newChat();
    else a.connectInstalled(id);
  };
  const footerLimits = createMemo(() => planLimits(a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || friendlyAgentName(entry.id) })), limits.limitedModels(), a.agentId()));
  const setup = () => {
    a.setView("connect");
    props.onOpenEditor();
  };
  createEffect(on(() => props.newRequest, (value) => value && newSession(), { defer: true }));
  const showTask = (taskId: string) => {
    const card = document.querySelector<HTMLElement>(`.ap-thread [data-task-id="${CSS.escape(taskId)}"]`);
    if (!card) return;
    a.setPinned(false);
    card.scrollIntoView({ block: "nearest", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    card.focus({ preventScroll: true });
  };
  const workspaceName = () => props.workspaceName;

  return (
    <div class="ap-page" classList={{ narrow: narrow() }} style={{ "--ap-rail-width": `${railWidth()}px`, "--ap-side-width": `${shownSideWidth()}px` }}>
      <Show when={narrow() && overlayOpen()}>
        <button type="button" class="ap-scrim" aria-label="Close sessions" tabIndex={-1} onClick={() => setOverlayOpen(false)} />
      </Show>
      <Show
        when={railShown()}
        fallback={
          <button
            type="button"
            class="ap-rail-restore"
            aria-label={rows().some((row) => row.state === "needs" || row.state === "failed") ? "Show sessions, some need you" : "Show sessions"}
            title="Show sessions"
            onClick={() => (narrow() ? setOverlayOpen(true) : setRailOpen(true))}
          >
            <span class="ap-grip-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <Show when={rows().some((row) => row.state === "needs" || row.state === "failed")}>
              <span class="ap-attention-dot" aria-hidden="true" />
            </Show>
          </button>
        }
      >
        <SessionsRail
          rows={rows()}
          now={now()}
          workspaceName={workspaceName()}
          scope={a.sessionScope() as RailScope}
          onScope={(scope) => a.setSessionScope(scope)}
          busy={a.sessionsBusy()}
          error={a.sessionsError() || undefined}
          onOpen={openRow}
          onNew={newSession}
          newBlocked={newBlocked()}
          onClose={(row) => void a.closeChat(row.sessionId)}
          canClose={(row) => Boolean(row.current) && a.canClose()}
          onCopyId={(row) => void api.writeClipboard(row.sessionId).catch(() => undefined)}
          searchShortcut={props.searchShortcut}
          newShortcut={props.newShortcut}
          searchRequest={searchRequest()}
          onRename={a.canRename() ? (row) => setRenaming({ row, title: row.title }) : undefined}
          onArchive={a.canArchive() ? (row, archived) => void a.archiveChat(row.sessionId, archived) : undefined}
          onFork={a.canFork() && a.state().canLoad ? (row) => void a.forkChat(row.sessionId) : undefined}
          onExport={a.canExport() ? (row) => void a.exportChat(row.sessionId) : undefined}
          overlay={narrow()}
          onDismiss={() => setOverlayOpen(false)}
          footer={<PlanLimits limits={footerLimits()} now={now()} />}
        />
        <Show when={!narrow()}>
          <PageGrip label="Resize sessions" side="left" value={railWidth()} min={RAIL_WIDTH.min} max={RAIL_WIDTH.max} onResize={setRailWidth} onReset={() => setRailWidth(RAIL_WIDTH.initial)} onCollapse={() => setRailOpen(false)} collapseBelow={150} />
        </Show>
      </Show>
      <ThreadView
        agent={a}
        workspaceName={workspaceName()}
        onOpenEditor={props.onOpenEditor}
        onOpenAgents={() => {
          setSideTab("agents");
          setSideOpen(true);
        }}
        sideOpen={sideOpen()}
        onToggleSide={() => setSideOpen(!sideOpen())}
        onSetup={setup}
        picker={
          picking() || (!a.connected() && a.installed().length > 0 && !a.feed().length) ? (
            <NewSessionPicker
              workspaceName={workspaceName()}
              agents={pickerAgents()}
              busy={a.working()}
              now={now()}
              showHealth={a.healthOn()}
              delegationEnabled={a.props.delegationEnabled !== false}
              onDelegationChange={a.props.onDelegationChange}
              onPick={pickLead}
              onCancel={picking() && (a.connected() || a.feed().length > 0) ? () => setPicking(false) : undefined}
              onMoreAgents={setup}
            />
          ) : undefined
        }
      />
      <Show when={sideOpen()}>
        <PageGrip label="Resize side panel" side="right" value={shownSideWidth()} min={SIDE_WIDTH.min} max={sideMax()} onResize={setSideWidth} onReset={() => (setSideWidth(undefined), writeStored(SIDE_WIDTH_KEY, ""))} />
        <SidePanel agent={a} tab={sideTab()} onTab={setSideTab} onClose={() => setSideOpen(false)} onOpenFile={props.onOpenFile} onShowTask={showTask} />
      </Show>
      <Show when={renaming()}>
        {(open) => (
          <Modal
            label="Rename session"
            class="confirm-modal"
            initialFocus="input"
            onClose={() => setRenaming(undefined)}
            onSubmit={() => {
              const title = open().title.trim();
              if (title) void a.renameChat(open().row.sessionId, title);
              setRenaming(undefined);
            }}
          >
            <h2>Rename session</h2>
            <input class="ap-rename-input" aria-label="Session title" value={open().title} onInput={(event) => setRenaming({ row: open().row, title: event.currentTarget.value })} />
            <div class="dialog-actions">
              <span />
              <button class="button" data-modal-cancel>Cancel</button>
              <button class="button primary" data-modal-default disabled={!open().title.trim()}>Rename</button>
            </div>
          </Modal>
        )}
      </Show>
    </div>
  );
}

export default AgentsPage;
