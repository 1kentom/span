import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api, isDesktop } from "../../lib/client";
import { NATIVE_UNAVAILABLE, type AgentController } from "../../lib/agent-controller";
import { isNearBottom, pillVisible } from "../../lib/agent-feed";
import { classifyFailure } from "../../lib/agent-view";
import { liveTone, orderByUrgency } from "../../lib/live-agents";
import { AgentComposer } from "../agent/AgentComposer";
import { AgentFeed } from "../agent/AgentFeed";
import { ErrorCard } from "../agent/Banners";
import { modalOpen } from "../agent/util";
import { AttachmentViewer, DropOverlay, attachmentBlockReason } from "../attachments";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";

export type ThreadViewProps = {
  agent: AgentController;
  workspaceName: string;
  /** Show this thread in the editor's agent sidebar (Editor mode). */
  onOpenEditor: () => void;
  /** Open the side panel on its Agents tab. */
  onOpenAgents: () => void;
  sideOpen: boolean;
  onToggleSide: () => void;
  /** Connecting, signing in and choosing an agent still live in the sidebar: switch there with its connect view. */
  onSetup: () => void;
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
  const failure = createMemo(() => {
    const current = a.state().failure;
    return current ? classifyFailure(current, label()) : undefined;
  });
  /** What the thread area shows: the feed, or a pointer to the sidebar for what the page does not host yet. */
  const body = createMemo(() => {
    if (!isDesktop) return "unavailable";
    if (a.connecting() || a.state().auth || a.view() === "connect") return "setup";
    if (a.feed().length) return "feed";
    return a.connected() ? "empty" : "setup";
  });
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
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (a.pinned()) a.scrollToLatest();
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
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
          ref={(element) => (a.scrollers.content = element)}
          onScroll={(event) => {
            a.setPinned(isNearBottom(event.currentTarget));
            setAway(pillVisible(away(), event.currentTarget));
          }}
        >
          <Show when={body() === "feed"}>
            <AgentFeed agent={a} ref={setFeedElement} />
          </Show>
          <Show when={body() === "empty"}>
            <div class="ap-thread-empty">
              <BrandIcon id={brand().id} name={brand().name} size={26} />
              <h3>New session with {label()}</h3>
              <p>Working in {props.workspaceName}. Ask a question or hand off a task. Selected code comes along as context.</p>
            </div>
          </Show>
          <Show when={body() === "setup"}>
            <div class="ap-thread-empty">
              <h3>{a.connecting() ? `Connecting ${label()}…` : a.state().auth ? `Sign in to ${label()}` : "Connect an agent"}</h3>
              <p>Choosing an agent, connecting and signing in happen in the agent sidebar for now. The thread appears here once a session starts.</p>
              <button type="button" class="ap-btn primary" onClick={() => props.onSetup()}>
                {a.connecting() || a.state().auth ? "Continue in the sidebar" : "Choose an agent"}
              </button>
            </div>
          </Show>
          <Show when={body() === "unavailable"}>
            <div class="ap-thread-empty">
              <h3>Agents require the desktop app</h3>
              <p>This browser preview cannot start local agent processes, so nothing here talks to an agent.</p>
            </div>
          </Show>
          <Show when={failure() && body() !== "setup"}>
            <div class="ap-thread-failure">
              <ErrorCard
                level={failure()!.level}
                title={failure()!.title}
                text={failure()!.text}
                actions={[
                  ...(isDesktop ? [{ label: "Show in sidebar", onAct: () => props.onSetup() }] : []),
                  { label: "Dismiss", onAct: () => a.dismissFailure() },
                ]}
              />
            </div>
          </Show>
        </div>
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
              if (attachment.path) {
                a.openInEditor(attachment.path);
                props.onOpenEditor();
              }
            }}
            loadImage={(path) => api.readImage(path)}
          />
        )}
      </Show>
      <DropOverlay visible={a.intake.dragging()} capabilities={a.caps()} />
    </section>
  );
}
