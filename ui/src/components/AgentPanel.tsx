import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api, isDesktop } from "../lib/client";
import { ATTACH_UNAVAILABLE, createAgentController, NATIVE_UNAVAILABLE, type AgentPanelProps } from "../lib/agent-controller";
import { isNearBottom, relativeTime } from "../lib/agent-feed";
import { hintText } from "../lib/agent-hint-text";
import { capabilityChips, classifyFailure, leaf } from "../lib/agent-view";
import { AnimatedLogo } from "./AnimatedLogo";
import { BrandIcon } from "./BrandIcon";
import { Icon } from "./Icon";
import { AttachmentViewer, DropOverlay, attachmentBlockReason } from "./attachments";
import { AgentComposer } from "./agent/AgentComposer";
import { AgentFeed } from "./agent/AgentFeed";
import { ErrorCard, OfflineBar } from "./agent/Banners";
import { ConnectingSteps, ReadyCard } from "./agent/ConnectFlow";
import { ConnectScreen } from "./agent/ConnectScreen";
import { EditorToast } from "./agent/EditorToast";
import { EmptySession } from "./agent/EmptySession";
import { FollowPill } from "./agent/FollowPill";
import { HistoryList } from "./agent/HistoryList";
import { HintLine, SignIn } from "./agent/SignIn";
import type { ActionView, KeyHint } from "./agent/types";
import { modalOpen } from "./agent/util";
import "../styles/agent.css";

const KEYS: KeyHint[] = [
  { keys: ["⌘", "."], label: "Ask agent", where: "Editor & Terminal" },
  { keys: ["⌥", "↩"], label: "Add context", where: "Chat" },
  { keys: ["/"], label: "Commands", where: "Chat" },
];

export function AgentPanel(props: AgentPanelProps) {
  const a = createAgentController(props);
  const [query, setQuery] = createSignal("");
  const [feedElement, setFeedElement] = createSignal<HTMLDivElement>();
  const agent = () => a.state().agent;
  const label = () => agent()?.title || agent()?.name || a.agentName();
  const brand = () => ({ id: a.agentId() ?? agent()?.name, name: label() });
  const hasAgent = () => Boolean(a.agentId() || agent());
  const title = () => a.state().sessionTitle || (a.connected() || a.connecting() || a.state().auth ? label() : "AI Assistant");
  const busyOverlay = () => a.connected() || a.feed().length > 0;
  const body = createMemo(() => {
    if (a.view() === "logs") return "logs";
    if (a.view() === "history") return "history";
    if (!isDesktop) return "unavailable";
    if (a.view() === "connect") return "connect";
    if (a.connecting()) return "connecting";
    if (a.state().auth) return "signin";
    if (a.connected()) return a.feed().length ? "feed" : "empty";
    return a.feed().length ? "feed" : "connect";
  });
  const failure = createMemo(() => {
    const current = a.state().failure;
    return current ? { ...classifyFailure(current), log: current.log } : undefined;
  });
  const chooseAgent = () => {
    a.dismissFailure();
    a.leaveConnecting();
    a.setView("connect");
  };
  const failureActions = createMemo<ActionView[]>(() => {
    const current = failure();
    if (!current) return [];
    const actions: ActionView[] = [];
    if (["exit", "timeout"].includes(current.kind) || (current.kind === "auth" && a.state().failure?.phase !== "auth")) {
      if (a.launch()) actions.push({ label: "Reconnect", primary: true, onAct: a.reconnect });
      actions.push({ label: "Choose agent", onAct: chooseAgent });
    } else if (["missing-binary", "protocol"].includes(current.kind) || (current.kind === "other" && a.state().failure?.phase === "connect")) {
      actions.push({ label: "Choose agent", primary: true, onAct: chooseAgent });
    }
    if (isDesktop && current.kind !== "workspace") actions.push({ label: "Show ACP log", onAct: () => a.setView("logs") });
    actions.push({
      label: "Dismiss",
      onAct: () => {
        a.dismissFailure();
        if (a.connecting()?.failed) a.leaveConnecting();
      },
    });
    return actions;
  });
  const sessionRows = createMemo(() =>
    a.sessions().map((session) => ({
      id: session.sessionId,
      brand: brand(),
      title: session.title || "Untitled chat",
      updatedAt: session.updatedAt ? Date.parse(session.updatedAt) || 0 : 0,
      inWorkspace: true,
      current: session.sessionId === a.state().sessionId,
      locked: !a.state().canLoad,
    })),
  );
  const recents = createMemo(() =>
    a.state().canLoad
      ? a
          .sessions()
          .filter((session) => session.sessionId !== a.state().sessionId)
          .slice(0, 4)
          .map((session) => ({ id: session.sessionId, title: session.title || "Untitled chat", time: relativeTime(session.updatedAt) }))
      : [],
  );
  /** Methods that cannot run from Span and need nothing typed. Methods that take a key or gateway get a form instead. */
  const unsupportedAuth = () => a.state().auth?.methods.filter((method) => !method.supported && !method.input) ?? [];
  /** Per-method hints that the header hint does not already say. */
  const methodHints = () => {
    const shown = hintText(a.state().auth?.hint);
    return [...new Set(unsupportedAuth().flatMap((method) => (hintText(method.hint) ? [hintText(method.hint)!] : [])))].filter((line) => line !== shown);
  };
  const unhinted = () => unsupportedAuth().filter((method) => !method.hint);
  const presetRows = () => a.presets().map((preset) => ({ id: preset.id, name: preset.name, description: preset.description, command: [preset.launch.command, ...preset.launch.args].join(" ") }));
  const openHistory = () => {
    a.setView(a.view() === "history" ? "session" : "history");
    if (a.view() === "history") void a.loadSessions();
  };

  let panel: HTMLElement | undefined;
  onMount(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        a.focusPrompt();
      }
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      // Escape belongs to whatever has focus. Only a key pressed inside this panel, outside a dock (docks answer
      // Escape themselves) and with no modal open, closes the agent menu or stops the turn.
      const target = event.target;
      if (!panel || !(target instanceof Node) || !panel.contains(target) || modalOpen()) return;
      if (target instanceof Element && target.closest(".sb-dock")) return;
      if (a.menu()) {
        event.preventDefault();
        a.setMenu(null);
        a.focusPrompt();
      } else if (a.running() && !a.elicitation()) {
        // An open input request answers Escape itself (decline), so it does not also stop the turn.
        event.preventDefault();
        void a.stop();
      }
    };
    window.addEventListener("keydown", keyboard);
    onCleanup(() => window.removeEventListener("keydown", keyboard));
  });
  createEffect(() => {
    a.feed();
    a.state().logs;
    a.view();
    a.queue();
    if (a.pinned()) a.scrollToLatest();
  });
  createEffect(() => {
    // Markdown and highlighting settle after the feed signal changes, so watch the real height.
    const element = feedElement();
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (a.pinned()) a.scrollToLatest();
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  return (
    <section
      ref={panel}
      class="agent-panel"
      aria-label="AI Assistant"
      onDragEnter={a.intake.onDragEnter}
      onDragOver={a.intake.onDragOver}
      onDragLeave={a.intake.onDragLeave}
      onDrop={a.intake.onDrop}
    >
      <header class="agent-header">
        <Show when={hasAgent()} fallback={<span class="agent-logo" aria-hidden="true" />}>
          <BrandIcon id={brand().id} name={brand().name} size={15} />
        </Show>
        <span class="agent-title" title={title()}>
          {title()}
        </span>
        <span class="agent-dot" classList={{ ready: a.connected(), busy: a.running(), connecting: a.working(), error: Boolean(failure()) }} aria-hidden="true" />
        <span class="agent-header-spacer" />
        <Show when={(a.view() === "history" || a.view() === "connect") && busyOverlay()}>
          <button class="agent-icon-button" aria-label="Back to session" title="Back to session" onClick={() => a.setView("session")}>
            <Icon name="arrow-left4" size={14} />
          </button>
        </Show>
        <Show when={isDesktop && a.connected()}>
          <FollowPill following={a.following()} onToggle={a.toggleFollow} />
        </Show>
        <Show when={a.connected() && a.state().canList && a.view() !== "history"}>
          <button class="agent-icon-button" aria-label="Earlier sessions" title="Earlier sessions" onClick={openHistory}>
            <Icon name="Clock" size={15} />
          </button>
        </Show>
        <Show when={isDesktop}>
          <button
            class="agent-icon-button"
            aria-label={a.connected() ? "New chat" : "Connect an agent"}
            title={a.connected() ? "New chat" : "Connect an agent"}
            disabled={a.working() || a.running()}
            onClick={() => (a.connected() ? void a.newChat() : a.setView("connect"))}
          >
            <Icon name="Add" size={16} />
          </button>
        </Show>
        <button class="agent-log-tab" classList={{ active: a.view() === "logs" }} title="Inspect actual ACP traffic" aria-pressed={a.view() === "logs"} onClick={() => a.setView(a.view() === "logs" ? "session" : "logs")}>
          ACP log
        </button>
        <Show when={isDesktop}>
          <button class="agent-icon-button" aria-label="Session actions" aria-haspopup="menu" aria-expanded={a.menu() === "actions"} onClick={() => a.setMenu(a.menu() === "actions" ? null : "actions")}>
            <Icon name="3DotsMore" size={15} />
          </button>
        </Show>
        <Show when={a.menu() === "actions"}>
          <button class="agent-menu-dismiss" aria-label="Close session actions" tabindex="-1" onClick={() => a.setMenu(null)} />
          <div class="sb-menu agent-actions-menu" role="menu" aria-label="Session actions" ref={(element) => queueMicrotask(() => element.querySelector<HTMLElement>("[role='menuitem']")?.focus())}>
            <button class="sb-menu-item" role="menuitem" onClick={() => (a.setMenu(null), a.setView("connect"))}>
              <Icon name="collaborators" size={13} />
              <span>{a.connected() ? "Connect another agent" : "Connect an agent"}</span>
            </button>
            <Show when={a.launch() && !a.connected() && !a.working()}>
              <button class="sb-menu-item" role="menuitem" onClick={() => (a.setMenu(null), a.reconnect())}>
                <Icon name="Refresh2" size={13} />
                <span>Reconnect {a.launch()!.name}</span>
              </button>
            </Show>
            <Show when={a.state().sessionId || a.state().auth}>
              <button class="sb-menu-item" role="menuitem" disabled={a.working()} onClick={() => void a.disconnect()}>
                <Icon name="CloseCircle" size={13} />
                <span>Disconnect session</span>
              </button>
            </Show>
            <button class="sb-menu-item" role="menuitem" disabled={a.registryBusy()} onClick={() => (a.setMenu(null), void a.loadAgents())}>
              <Icon name="Refresh2" size={13} />
              <span>{a.registryBusy() ? "Loading agents…" : "Refresh agent list"}</span>
            </button>
            <Show when={props.onOpenSettings}>
              <button class="sb-menu-item" role="menuitem" onClick={() => (a.setMenu(null), props.onOpenSettings?.())}>
                <Icon name="Setting2" size={13} />
                <span>Open settings</span>
              </button>
            </Show>
          </div>
        </Show>
      </header>
      <Show when={isDesktop && !a.online() && (a.connected() || a.queue().length > 0)}>
        <OfflineBar text={a.queue().length ? "Queued messages wait until the network is back." : "Agents that need the network will fail until you reconnect."} onRetry={() => a.setOnline(navigator.onLine !== false)} />
      </Show>
      <div class="agent-content" ref={(element) => (a.scrollers.content = element)} onScroll={(event) => a.setPinned(isNearBottom(event.currentTarget))}>
        <Switch>
          <Match when={body() === "logs"}>
            <div class="agent-log-note">
              ACP traffic · latest {a.state().logs.length} of {a.state().logCount} lines · up to 6,000 characters per line
            </div>
            <Show
              when={a.state().logs.length}
              fallback={<div class="agent-log-empty">No ACP traffic recorded. {isDesktop ? "Connect an agent to inspect its protocol messages." : "A native agent connection is unavailable in browser preview."}</div>}
            >
              <pre class="agent-logs">{a.state().logs.join("\n")}</pre>
            </Show>
          </Match>
          <Match when={body() === "history"}>
            <Show when={a.sessionsError()}>
              <p class="sb-fine agent-pad" role="alert">
                {a.sessionsError()}
              </p>
            </Show>
            <Show when={a.sessionsBusy() && !a.sessions().length} fallback={<HistoryList rows={sessionRows()} query={query()} onQuery={setQuery} formatTime={(row) => relativeTime(new Date(row.updatedAt).toISOString())} onOpen={(id) => void a.resumeChat(id)} onCopyId={(id) => void api.writeClipboard(id)} onDelete={a.canDelete() ? (id) => void a.deleteChat(id) : undefined} onClose={a.canClose() ? (id) => void a.closeChat(id) : undefined} />}>
              <p class="sb-fine agent-pad" role="status">
                Loading chats…
              </p>
            </Show>
          </Match>
          <Match when={body() === "unavailable"}>
            <div class="agent-body">
              <section class="sb-connect" aria-labelledby="agent-unavailable-title">
                <header class="sb-hero">
                  <AnimatedLogo size={22} label="Span" />
                  <h2 id="agent-unavailable-title" class="sb-title">
                    Agents require the desktop app
                  </h2>
                  <p class="sb-lede">This browser preview cannot start local agent processes, so nothing here talks to an agent.</p>
                </header>
              </section>
            </div>
          </Match>
          <Match when={body() === "connect"}>
            <div class="agent-body">
              <ConnectScreen
                found={a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || entry.id, subtitle: `${entry.version} · ${entry.launch.command}` }))}
                presets={presetRows()}
                onPreset={a.connectPreset}
                registry={a
                  .registry()
                  .filter((entry) => !a.installed().some((agent) => agent.id === entry.id))
                  .map((entry) => ({ id: entry.id, name: entry.name, subtitle: entry.description, status: a.installing() === entry.id ? "installing" : entry.installable ? "available" : "unsupported" }))}
                busy={a.working() || Boolean(a.installing())}
                onConnect={a.connectInstalled}
                onInstall={(id) => void a.install(id)}
                onCustom={a.connectCustom}
              />
              <Show when={a.registryBusy()}>
                <p class="sb-fine" role="status">
                  Loading installed agents and the ACP registry…
                </p>
              </Show>
              <Show when={!props.workspacePath}>
                <p class="sb-fine">Open a folder first. Agents start in the workspace folder.</p>
              </Show>
            </div>
          </Match>
          <Match when={body() === "connecting"}>
            <div class="agent-body agent-connecting">
              <ConnectingSteps phases={a.phases()} />
              <Show when={agent()}>{(info) => <ReadyCard id={brand().id} name={label()} title={info().title || info().name || label()} version={info().version} capabilities={capabilityChips(info().features)} />}</Show>
            </div>
          </Match>
          <Match when={body() === "signin"}>
            <div class="agent-body">
              <SignIn
                id={brand().id}
                name={label()}
                title={`Sign in to ${label()}`}
                text={a.state().auth!.message}
                hint={hintText(a.state().auth!.hint)}
                methods={a
                  .state()
                  .auth!.methods.filter((method) => method.supported || method.input)
                  .map((method) => ({ id: method.id, name: method.name, description: method.description ?? undefined, input: method.input ?? undefined }))}
                busy={a.pendingAction() === "auth"}
                onPick={(id) => void a.authenticate(id)}
                onSubmit={(id, secret) => void a.authenticateWith(id, secret)}
              />
              <Show when={unsupportedAuth().length}>
                <For each={methodHints()}>{(line) => <p class="sb-fine"><HintLine text={line} /></p>}</For>
                <Show when={unhinted().length}>
                  <p class="sb-fine">
                    {unhinted()
                      .map((method) => method.name)
                      .join(", ")}{" "}
                    {unhinted().length === 1 ? "needs" : "need"} a terminal sign-in, which Span does not run. Sign in from a terminal, then reconnect.
                  </p>
                </Show>
                <div class="sb-actions">
                  <button class="sb-btn" disabled={a.working()} onClick={a.reconnect}>
                    Reconnect
                  </button>
                </div>
              </Show>
            </div>
          </Match>
          <Match when={body() === "empty"}>
            <div class="agent-body">
              <EmptySession
                id={brand().id}
                name={label()}
                title={`New session with ${label()}`}
                text={`Working in ${leaf(props.workspacePath || "the workspace")}. Ask a question or hand off a task. Selected code comes along as context.`}
                keys={KEYS}
                recents={recents()}
                onOpenRecent={(id) => void a.resumeChat(id)}
              />
            </div>
          </Match>
          <Match when={body() === "feed"}>
            <AgentFeed agent={a} ref={setFeedElement} />
            <Show when={!a.connected() && !failure()}>
              <div class="sb-actions agent-pad">
                <Show when={a.launch()}>
                  <button class="sb-btn primary" disabled={a.working()} onClick={a.reconnect}>
                    Reconnect {a.launch()!.name}
                  </button>
                </Show>
                <button class="sb-btn" onClick={() => a.setView("connect")}>
                  Choose an agent
                </button>
              </div>
            </Show>
          </Match>
        </Switch>
        <Show when={failure() && body() !== "logs"}>
          <div class="agent-pad">
            <ErrorCard level={failure()!.level} title={failure()!.title} text={failure()!.text} log={failure()!.log?.length ? failure()!.log : undefined} actions={failureActions()} />
          </div>
        </Show>
      </div>
      <Show when={!a.pinned() && (a.feed().length > 0 || a.view() === "logs")}>
        <button class="agent-jump" aria-label="Jump to latest message" onClick={a.followLatest}>
          <Icon name="arrow-down4" size={11} />
          {a.running() ? "New activity" : "Latest"}
        </button>
      </Show>
      <AgentComposer agent={a} brand={brand()} label={hasAgent() ? label() : "agent"} />
      <Show when={a.viewingItem()}>
        {(item) => {
          const closeViewer = () => {
            a.setViewing(undefined);
            a.focusPrompt();
          };
          const message = () => a.feed().find((entry) => entry.kind === "user" && entry.attachments?.some((attachment) => attachment.id === item().id));
          /** Sent-message attachments only. Time is omitted because feed items carry no timestamp. */
          const source = () => {
            if (a.viewingInComposer() || !message()) return undefined;
            const session = a.state().sessionTitle;
            const name = hasAgent() ? label() : undefined;
            if (!session && !name) return undefined;
            return { agent: hasAgent() ? { id: brand().id, name: brand().name } : undefined, verb: session ? "Sent in" : "Sent to", session: session || name };
          };
          const showInSession = () => {
            const target = message();
            if (!target) return;
            a.setViewing(undefined);
            a.setPinned(false);
            requestAnimationFrame(() => feedElement()?.querySelector<HTMLElement>(`[data-feed-id="${target.id}"]`)?.scrollIntoView?.({ block: "center" }));
          };
          return (
            <AttachmentViewer
              item={item()}
              onClose={closeViewer}
              blockedReason={a.viewingInComposer() ? a.blocked().find((entry) => entry.item.id === item().id)?.reason ?? attachmentBlockReason(item(), a.caps()) : undefined}
              nativeUnavailable={isDesktop ? undefined : NATIVE_UNAVAILABLE}
              source={source()}
              onShowInSession={a.viewingInComposer() || !message() ? undefined : showInSession}
              onShowSessionList={() => {
                a.setViewing(undefined);
                a.setView("history");
                void a.loadSessions();
              }}
              onRemove={a.viewingInComposer() ? a.removeAttachment : undefined}
              onSaveToWorkspace={a.saveAttachment}
              onCopyPath={(path) => api.writeClipboard(path)}
              onOpenInEditor={(attachment) => {
                if (attachment.path) a.openInEditor(attachment.path);
                a.setViewing(undefined);
              }}
              loadImage={(path) => api.readImage(path)}
            />
          );
        }}
      </Show>
      <DropOverlay visible={a.intake.dragging()} capabilities={a.caps()} description={isDesktop ? undefined : ATTACH_UNAVAILABLE} />
      <EditorToast name={a.toast()} onDismiss={a.clearToast} />
    </section>
  );
}
export default AgentPanel;
