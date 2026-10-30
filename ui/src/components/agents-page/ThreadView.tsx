import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { api, isDesktop } from "../../lib/client";
import { NATIVE_UNAVAILABLE, type AgentController } from "../../lib/agent-controller";
import { pillVisible } from "../../lib/agent-feed";
import { liveTone, orderByUrgency } from "../../lib/live-agents";
import { AgentComposer } from "../agent/AgentComposer";
import { AgentFeed } from "../agent/AgentFeed";
import { AgentSetup, type SetupView } from "../agent/AgentSetup";
import { EditorToast, OpenRefusal } from "../agent/EditorToast";
import { modalOpen } from "../agent/util";
import { AttachmentViewer, DropOverlay, attachmentBlockReason } from "../attachments";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";
import { PageFailure } from "./PageFailure";
import { FollowPill } from "../agent/FollowPill";
import { FeedFind } from "../agent/FeedFind";
import type { CheckpointStore } from "../../lib/checkpoints";
import { CheckpointTimeline, CheckpointUndoToast } from "./Checkpoints";

export type ThreadViewProps = {
  agent: AgentController;
  workspaceName: string;
  /** Show this thread in the editor's agent sidebar (Editor mode). Only the header button calls it, on a click. */
  onOpenEditor: () => void;
  /** Open the side panel on its Agents tab. */
  onOpenAgents: () => void;
  sideOpen: boolean;
  onToggleSide: () => void;
  /** Opens the in-page connect view (choose, install or connect an agent). Never the editor sidebar. */
  onChooseAgent: () => void;
  /** Turn checkpoints of this thread (ADR 0013); without it no timeline shows. */
  checkpoints?: CheckpointStore;
  /** Show one turn's checkpoint changes in the side panel. */
  onShowChanges?: (turn: number) => void;
  /** The new-session picker, shown in place of the thread while set. */
  picker?: JSX.Element;
};

/**
 * The Agents page thread: a header (title, folder, live agents, Open in editor) over the same feed and composer stack
 * the sidebar renders, from the same controller and thread store (ADR 0011 b). Prose keeps a readable column while
 * tables and code may use the wider pane; the composer is docked at the bottom.
 */
export function ThreadView(props: ThreadViewProps) {
  const a = props.agent;
  const [feedElement, setFeedElement] = createSignal<HTMLDivElement>();
  const [away, setAway] = createSignal(false);
  let section: HTMLElement | undefined;
  const agent = () => a.state().agent;
  const label = () => agent()?.title || agent()?.name || a.agentName();
  const brand = () => ({ id: a.agentId() ?? agent()?.name, name: label() });
  const hasAgent = () => Boolean(a.agentId() || agent());
  const title = () => a.currentTitle() || "New session";
  const crew = createMemo(() => orderByUrgency(a.liveAgents(), a.healthOn()));
  /**
   * What the thread area shows. Connecting, signing in, choosing an agent and the ACP log all render here on the page,
   * from the same controller as the sidebar, so the page never sends the user to the editor sidebar to finish.
   */
  const body = createMemo(() => {
    if (!isDesktop) return "unavailable";
    if (a.view() === "logs") return "logs";
    if (a.view() === "connect") return "setup";
    if (a.connecting() || a.state().auth) return "setup";
    if (props.picker) return "picker";
    if (a.feed().length) return "feed";
    return a.connected() ? "empty" : "setup";
  });
  const setupView = (): SetupView => (a.view() === "connect" ? "connect" : a.connecting() ? "connecting" : a.state().auth ? "signin" : "connect");
  const setupTitle = () => (setupView() === "connecting" ? `Connecting ${label()}` : setupView() === "signin" ? `Sign in to ${label()}` : "Connect an agent");
  /** The connect view opened over a thread or the picker can go back to it. */
  const canLeaveSetup = () => a.view() === "connect" && (a.connected() || a.feed().length > 0 || a.installed().length > 0);
  const jumpShown = () => away() && !a.pinned() && a.feed().length > 0;

  // Attachments open in the page's own viewer: the workbench tabs that the sidebar opens them in are hidden here.
  onMount(() => a.setAttachmentOpener(undefined));
  createEffect(() => {
    if (a.pinned()) setAway(false);
  });
  createEffect(() => {
    a.feed();
    a.queue();
    if (a.pinned()) a.scrollToLatest();
  });
  createEffect(() => {
    const element = feedElement();
    if (element) onCleanup(a.follow.observe(element));
  });
  onMount(() => {
    // The same Escape rule as the sidebar: inside the thread, outside a dock and with no modal, Escape closes the
    // composer menu or stops the turn. Docks answer Escape themselves.
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      const target = event.target;
      if (!section || !(target instanceof Node) || !section.contains(target) || modalOpen()) return;
      if (target instanceof Element && target.closest(".sb-dock")) return;
      if (a.menu()) {
        event.preventDefault();
        a.setMenu(null);
        a.focusPrompt();
      } else if (a.running() && !a.elicitation()) {
        event.preventDefault();
        void a.stop();
      }
    };
    window.addEventListener("keydown", keyboard);
    onCleanup(() => window.removeEventListener("keydown", keyboard));
  });

  return (
    <section
      ref={section}
      class="agent-panel ap-thread"
      aria-label="Thread"
      onDragEnter={a.intake.onDragEnter}
      onDragOver={a.intake.onDragOver}
      onDragLeave={a.intake.onDragLeave}
      onDrop={a.intake.onDrop}
    >
      <header class="ap-thread-head">
        <h2 class="ap-thread-title" title={title()}>{title()}</h2>
        <span class="ap-chip">
          <Icon name="Folder2" size={11} />
          {props.workspaceName}
        </span>
        <Show when={hasAgent() && a.state().sessionId}>
          <span class="ap-chip ap-chip-plain" title={a.connected() ? `Connected to ${label()}` : `${label()} is not connected`}>
            <BrandIcon id={brand().id} name={brand().name} size={12} />
            {label()}
          </span>
        </Show>
        <span class="ap-grow" />
        <Show when={crew().length > 1}>
          <button type="button" class="ap-crew" aria-label={`Live agents: ${crew().map((entry) => `${entry.name}, ${entry.state}`).join("; ")}`} onClick={() => props.onOpenAgents()}>
            <For each={crew().slice(0, 4)}>
              {(entry) => (
                <span class="ap-crew-face" data-tone={liveTone(entry, a.healthOn())}>
                  <BrandIcon id={entry.id} name={entry.name} size={14} />
                </span>
              )}
            </For>
            <span>Live agents</span>
          </button>
        </Show>
        <Show when={isDesktop && a.connected()}>
          <FollowPill following={a.following()} onToggle={a.toggleFollow} />
        </Show>
        <button type="button" class="ap-btn" onClick={() => props.onOpenEditor()}>
          <Icon name="Code1" size={12} />
          Open in editor
        </button>
        <button type="button" class="ap-icon-btn" aria-label={props.sideOpen ? "Hide side panel" : "Show side panel"} aria-pressed={props.sideOpen} title={props.sideOpen ? "Hide side panel" : "Show side panel"} onClick={() => props.onToggleSide()}>
          <Icon name="panel-right" size={15} />
        </button>
      </header>
      <p class="sb-visually-hidden" aria-live="polite" aria-atomic="true">{a.attentionAnnouncement()}</p>
      <div class="agent-feed-region">
        <div
          class="agent-content ap-thread-scroll"
          tabIndex={-1}
          ref={(element) => {
            a.scrollers.content = element;
            onCleanup(a.follow.attach(element));
          }}
          onScroll={(event) => setAway(pillVisible(away(), event.currentTarget))}
        >
          <Show when={body() === "picker"}>{props.picker}</Show>
          <Show when={body() === "feed"}>
            <AgentFeed agent={a} ref={setFeedElement} />
            <Show when={props.checkpoints}>
              {(store) => <CheckpointTimeline store={store()} running={a.running()} onViewChanges={(turn) => props.onShowChanges?.(turn)} />}
            </Show>
          </Show>
          <Show when={body() === "empty"}>
            <div class="ap-thread-empty">
              <BrandIcon id={brand().id} name={brand().name} size={26} />
              <h3>New session with {label()}</h3>
              <p>Working in {props.workspaceName}. Ask a question or hand off a task. Selected code comes along as context.</p>
            </div>
          </Show>
          <Show when={body() === "setup"}>
            <section class="ap-setup" aria-label={setupTitle()}>
              <header class="ap-setup-head">
                <Show when={canLeaveSetup()}>
                  <button type="button" class="ap-icon-btn" aria-label="Back to the thread" title="Back to the thread" onClick={() => a.setView("session")}>
                    <Icon name="arrow-left4" size={14} />
                  </button>
                </Show>
                <h3 class="ap-setup-title">{setupTitle()}</h3>
              </header>
              <AgentSetup
                agent={a}
                view={setupView()}
                workspacePath={a.props.workspacePath}
                removeAgent={a.props.removeAgent}
                onOpenExternal={a.props.onOpenExternal}
                delegationEnabled={a.props.delegationEnabled}
                onDelegationChange={a.props.onDelegationChange}
              />
            </section>
          </Show>
          <Show when={body() === "logs"}>
            <section class="ap-setup" aria-label="ACP log">
              <header class="ap-setup-head">
                <button type="button" class="ap-icon-btn" aria-label="Back to the thread" title="Back to the thread" onClick={() => a.setView("session")}>
                  <Icon name="arrow-left4" size={14} />
                </button>
                <h3 class="ap-setup-title">ACP traffic</h3>
                <span class="ap-setup-sub">
                  latest {a.state().logs.length} of {a.state().logCount} lines
                </span>
              </header>
              <Show when={a.state().logs.length} fallback={<p class="ap-note">No ACP traffic recorded. Connect an agent to inspect its protocol messages.</p>}>
                <pre class="agent-logs">{a.state().logs.join("\n")}</pre>
              </Show>
            </section>
          </Show>
          <Show when={body() === "unavailable"}>
            <div class="ap-thread-empty">
              <h3>Agents require the desktop app</h3>
              <p>This browser preview cannot start local agent processes, so nothing here talks to an agent.</p>
            </div>
          </Show>
          <Show when={body() === "feed" && !a.connected() && !a.state().failure && !a.working()}>
            <div class="ap-thread-actions">
              <Show when={a.launch()}>
                <button type="button" class="ap-btn primary" onClick={a.reconnect}>
                  Reconnect {a.launch()!.name}
                </button>
              </Show>
              <button type="button" class="ap-btn" onClick={() => props.onChooseAgent()}>
                Choose an agent
              </button>
            </div>
          </Show>
          <Show when={body() !== "setup" && body() !== "picker" && body() !== "logs"}>
            <PageFailure agent={a} label={label()} onChooseAgent={props.onChooseAgent} onShowLog={() => a.setView("logs")} />
          </Show>
        </div>
        <FeedFind agent={a} scope={() => section} feed={feedElement} />
        <button type="button" class="agent-jump" classList={{ shown: jumpShown() }} aria-label="Jump to latest message" aria-hidden={jumpShown() ? undefined : "true"} tabIndex={jumpShown() ? 0 : -1} onClick={a.followLatest}>
          <Icon name="arrow-down4" size={11} />
          {a.running() ? "New activity" : "Latest"}
        </button>
      </div>
      <div class="ap-thread-composer">
        <AgentComposer agent={a} brand={brand()} label={hasAgent() ? label() : "agent"} />
      </div>
      <Show when={a.viewingItem()}>
        {(item) => (
          <AttachmentViewer
            item={item()}
            onClose={() => {
              a.setViewing(undefined);
              a.focusPrompt();
            }}
            blockedReason={a.viewingInComposer() ? attachmentBlockReason(item(), a.caps()) : undefined}
            nativeUnavailable={isDesktop ? undefined : NATIVE_UNAVAILABLE}
            onRemove={a.viewingInComposer() ? a.removeAttachment : undefined}
            onSaveToWorkspace={a.saveAttachment}
            onCopyPath={(path) => api.writeClipboard(path)}
            onOpenInEditor={(attachment) => {
              a.setViewing(undefined);
              // An explicit click: the app switches to Editor mode for the file, without opening the sidebar.
              if (attachment.path) a.openInEditor(attachment.path);
            }}
            loadImage={(path) => api.readImage(path)}
          />
        )}
      </Show>
      <DropOverlay visible={a.intake.dragging()} capabilities={a.caps()} />
      <Show when={props.checkpoints}>{(store) => <CheckpointUndoToast store={store()} />}</Show>
      <EditorToast name={a.toast()} onDismiss={a.clearToast} />
      <OpenRefusal refusal={a.openRefusal()} onCopy={(path) => api.writeClipboard(path)} onDismiss={a.clearOpenRefusal} />
    </section>
  );
}
