import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { api, isDesktop } from "../../lib/client";
import type { AgentController } from "../../lib/agent-controller";
import { liveSessions } from "../../lib/agent-stores/live-sessions";
import { RAIL_WIDTH, SIDE_WIDTH, clampWidth, currentThreadState, railRows, readStored, readWidth, sidePanelMax, writeStored, type RailRow } from "../../lib/agents-page";
import { threadRowMeta } from "../../lib/session-threads";
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
  const [sideOpen, setSideOpen] = createSignal(readStored("sideOpen") !== "false");
  const [sideWidth, setSideWidth] = createSignal(readWidth("sideWidth", SIDE_WIDTH));
  const storedTab = readStored("sideTab");
  const [sideTab, setSideTab] = createSignal<SideTab>(isSideTab(storedTab) ? storedTab : "changes");
  const [searchRequest, setSearchRequest] = createSignal(0);
  const sideMax = () => sidePanelMax(props.windowWidth, railOpen() ? railWidth() : 0);
  const shownSideWidth = () => clampWidth(sideWidth(), SIDE_WIDTH.min, sideMax());

  createEffect(() => writeStored("railOpen", String(railOpen())));
  createEffect(() => writeStored("railWidth", String(railWidth())));
  createEffect(() => writeStored("sideOpen", String(sideOpen())));
  createEffect(() => writeStored("sideWidth", String(sideWidth())));
  createEffect(() => writeStored("sideTab", sideTab()));

  onMount(() => {
    if (isDesktop) void live.start();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    // Cmd+K (Ctrl+K) searches sessions while the page is shown; nothing else in the app binds it.
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return;
      if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) return;
      event.preventDefault();
      if (!railOpen()) setRailOpen(true);
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
    if (row.current) {
      a.focusPrompt();
      return;
    }
    void a.resumeChat(row.sessionId);
  };
  const newBlocked = () => (a.working() ? "Wait until the agent finishes connecting" : undefined);
  const newSession = () => {
    if (newBlocked()) return;
    if (a.connected()) void a.newChat();
    else setup();
  };
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
    <div class="ap-page" style={{ "--ap-rail-width": `${railWidth()}px`, "--ap-side-width": `${shownSideWidth()}px` }}>
      <Show
        when={railOpen()}
        fallback={
          <button type="button" class="ap-rail-restore" aria-label="Show sessions" title="Show sessions" onClick={() => setRailOpen(true)}>
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
        />
        <PageGrip label="Resize sessions" side="left" value={railWidth()} min={RAIL_WIDTH.min} max={RAIL_WIDTH.max} onResize={setRailWidth} onReset={() => setRailWidth(RAIL_WIDTH.initial)} onCollapse={() => setRailOpen(false)} collapseBelow={150} />
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
      />
      <Show when={sideOpen()}>
        <PageGrip label="Resize side panel" side="right" value={shownSideWidth()} min={SIDE_WIDTH.min} max={sideMax()} onResize={setSideWidth} onReset={() => setSideWidth(SIDE_WIDTH.initial)} />
        <SidePanel agent={a} tab={sideTab()} onTab={setSideTab} onClose={() => setSideOpen(false)} onOpenFile={props.onOpenFile} onShowTask={showTask} />
      </Show>
    </div>
  );
}

export default AgentsPage;
