import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { BrandIcon } from "../BrandIcon";
import { FileIcon, Icon } from "../Icon";
import { AttachMenu, AttachmentNotices, AttachmentTray, type AttachMenuItemId } from "../attachments";
import type { AgentController } from "../../lib/agent-controller";
import { ATTACH_UNAVAILABLE } from "../../lib/agent-controller";
import { composerHints } from "../../lib/agent-hints";
import { shouldFocusDock } from "../../lib/agent-dock-focus";
import { formatElapsed } from "../../lib/agent-feed";
import { delegationLine } from "../../lib/agent-delegation";
import { canCompact, type PermissionEvent } from "../../lib/agent-session";
import { configViews, currentChoice, isSlashQuery, leaf, levelOf, permissionDetails, slashGroups, type SpanCommand } from "../../lib/agent-view";
import { isDesktop } from "../../lib/client";
import { ContextBanner } from "./Banners";
import { ComposerHints } from "./ComposerHints";
import { ActivityBar, PermissionDock, QuestionDock, UrlDock, focusDock } from "./Docks";
import { ModelPopover } from "./ModelPopover";
import { PlanDrawer } from "./PlanDrawer";
import { QueuePanel } from "./QueuePanel";
import { SlashPopover } from "./SlashPopover";
import { UsageRing } from "./UsageRing";
import type { Brand, PlanItem, SlashItem } from "./types";
import { percent } from "./util";

const BANNER_AT = 85;

/** Everything below the conversation: banners, plan, queue, docks, the prompt box and its toolbar. */
export function AgentComposer(props: { agent: AgentController; brand: Brand; label: string }) {
  const a = props.agent;
  let input: HTMLTextAreaElement | undefined;
  let plus: HTMLButtonElement | undefined;
  let uploadInput!: HTMLInputElement;
  let imageInput!: HTMLInputElement;
  let footer: HTMLElement | undefined;
  const [slashClosedFor, setSlashClosedFor] = createSignal<string>();
  /** Focus is inside the open dock. The hints row lists dock keys only then. */
  const [dockFocused, setDockFocused] = createSignal(false);
  /** Time of the last key or input in the prompt box, so a new dock never takes focus from someone typing. */
  let lastTypedAt = 0;
  const noteTyping = (event?: KeyboardEvent) => {
    if (event && ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
    lastTypedAt = Date.now();
  };
  /** Read once when a dock mounts. Never answers anything; at most it moves focus to the primary control. */
  const dockFocusProps = {
    get autoFocus() {
      return shouldFocusDock({ now: Date.now(), lastTypedAt, composerFocused: Boolean(input) && document.activeElement === input, composerText: a.prompt() });
    },
    onFocusChange: setDockFocused,
  };
  const dockOpen = () => Boolean(a.permission() || a.childPermission() || a.elicitation());
  const config = createMemo(() => configViews(a.state().config));
  const model = () => config().find((option) => option.category === "model");
  const level = () => levelOf(config().find((option) => option.category === "thought_level"));
  const mode = () => config().find((option) => option.category === "mode");
  const modelLabel = () => currentChoice(model())?.name ?? props.label;
  const usage = () => a.state().usage;
  const showBanner = () => {
    const current = usage();
    return Boolean(current && a.connected() && !a.bannerDismissed() && percent(current.used, current.size) >= BANNER_AT);
  };
  const plan = createMemo<PlanItem[]>(() =>
    a.state().plan.map((entry) => ({ text: entry.content, status: entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending" })),
  );
  const spanCommands = (): SpanCommand[] => [
    ...(a.connected() && !a.running() ? [{ name: "new", description: "Start a new chat with this agent" }] : []),
    ...(a.connected() && a.state().canList ? [{ name: "history", description: "Browse earlier chats" }] : []),
    ...(a.props.activePath ? [{ name: "file", description: "Add the current file as context" }] : []),
    { name: "log", description: "Show ACP traffic" },
    ...(isDesktop ? [{ name: "agents", description: "Connect a different agent" }] : []),
  ];
  const slashOpen = () => isSlashQuery(a.prompt()) && slashClosedFor() !== a.prompt() && !a.menu();
  const groups = createMemo(() => (slashOpen() ? slashGroups(a.prompt(), props.label, a.connected() ? a.state().commands : [], spanCommands()) : []));
  function pickSlash(item: SlashItem) {
    if (item.source === "agent") {
      a.setPrompt(`${item.name} `);
      queueMicrotask(() => input?.focus());
      return;
    }
    a.setPrompt("");
    const name = item.name.slice(1);
    if (name === "new") void a.newChat();
    else if (name === "history") a.setView("history");
    else if (name === "file") a.addCurrentFile();
    else if (name === "log") a.setView("logs");
    else if (name === "agents") a.setView("connect");
  }
  const toolFor = (toolCallId: string) => {
    const tool = a.feed().find((item) => item.kind === "tool" && item.event.toolCallId === toolCallId);
    return tool?.kind === "tool" ? tool.event : undefined;
  };
  const EDIT_KINDS = ["edit", "delete", "move"];
  const permissionView = (event: PermissionEvent) => {
    const details = permissionDetails(event, a.props.workspacePath, (path, line) => void a.openInEditor(path, line), toolFor(event.toolCallId));
    const edits = EDIT_KINDS.includes(event.toolKind ?? "") || details.diffs.length > 0;
    return { ...details, doubleApproval: Boolean(a.state().agent?.features.doubleApproval) && edits };
  };
  const line = () => delegationLine(a.state().delegation, a.state().sessionId);
  /** One dock instance per request: a new request id remounts the dock, so its open state starts fresh. */
  const sameRequest = <T extends { event: { requestId: string } } | undefined>(previous: T, next: T) => previous?.event.requestId === next?.event.requestId;
  const leadRequest = createMemo(() => a.permission(), undefined, { equals: sameRequest });
  const childRequest = createMemo(() => (a.permission() ? undefined : a.childPermission()), undefined, { equals: sameRequest });
  /** Read once by screen readers when a dock appears. The docks themselves stay out of any live region. */
  const announcement = () => {
    const lead = a.permission();
    if (lead) return `Permission requested: ${lead.event.title}`;
    const child = a.childPermission();
    if (child) return `${child.agentName} asks permission: ${child.event.title}`;
    const ask = a.elicitation();
    if (ask) return ask.mode === "url" ? `The agent asks you to open a page: ${ask.message}` : `Question from the agent: ${ask.message}`;
    return "";
  };
  /** Start and stop of a turn, announced once each. The elapsed timer is never announced. */
  const [ran, setRan] = createSignal(false);
  createEffect(on(a.running, (running) => running && setRan(true)));
  const runStatus = () => (a.running() ? "Agent is working" : ran() ? "Agent finished" : "");
  const field = () => a.fields()[a.form()?.index ?? 0];
  const unavailable = isDesktop ? undefined : ATTACH_UNAVAILABLE;
  /** Only items with a real handler are offered. Folder, Earlier session and Paste screenshot have none (no folder picker, no session attach, no image clipboard command), so they are omitted rather than stubbed. */
  const attachHandlers = (): Partial<Record<AttachMenuItemId, () => void>> => ({
    upload: () => uploadInput.click(),
    image: () => imageInput.click(),
    file: a.addCurrentFile,
    selection: a.showSelection,
  });
  const attachReasons = (): Partial<Record<AttachMenuItemId, string>> => {
    const path = a.props.activePath;
    return {
      file: !path ? "No file is open" : a.contextPaths().includes(path) ? "Already added" : undefined,
      selection: !a.props.selectionContext?.text ? "Nothing is selected" : a.selection() ? "Already included" : undefined,
    };
  };
  const pickFiles = (event: Event & { currentTarget: HTMLInputElement }) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void a.intake.addFiles(files, "picked");
  };
  const hintMode = () => (a.permission() || a.childPermission() ? "permission" : a.elicitation() ? "question" : a.running() ? "running" : "idle");
  const hints = () => composerHints({ permission: (a.permission() ?? a.childPermission())?.event.options, elicitation: a.elicitation(), field: field(), dockFocused: dockFocused() });
  const hasPayload = () => Boolean(a.prompt().trim() || a.attachments().length);
  const loadingOnly = (reason: string) => reason === "Still loading.";
  const reportable = () => a.blocked().filter((entry) => !loadingOnly(entry.reason));
  const toggle = (menu: "model" | "agents" | "attach") => a.setMenu(a.menu() === menu ? null : menu);
  const closeMenu = () => {
    a.setMenu(null);
    input?.focus();
  };

  createEffect(() => {
    a.prompt();
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(61, input.scrollHeight))}px`;
  });

  return (
    <footer ref={footer} class="agent-footer">
      <p class="sb-visually-hidden" aria-live="assertive" aria-atomic="true">{announcement()}</p>
      <p class="sb-visually-hidden agent-run-status" role="status">{runStatus()}</p>
      <Show when={line()}>
        {(entry) => (
          <div class="agent-delegation-line" classList={{ warn: entry().tone === "warn" }} role="status">
            <span class="sb-dot" aria-hidden="true" />
            <span>{entry().text}</span>
          </div>
        )}
      </Show>
      <Show when={showBanner()}>
        <ContextBanner
          used={usage()!.used}
          size={usage()!.size}
          canCompact={canCompact(a.state().commands) && !a.running()}
          onCompact={() => a.sendText("/compact")}
          onDismiss={() => a.setBannerDismissed(true)}
        />
      </Show>
      <Show when={plan().length}>
        <PlanDrawer items={plan()} />
      </Show>
      <Show when={a.queue().length}>
        <QueuePanel
          items={a.queue().map((entry) => ({ id: entry.id, text: entry.text || `${entry.items.length} attachment${entry.items.length === 1 ? "" : "s"}` }))}
          note={a.queueHeld() ? undefined : a.online() ? "Sent when the agent is idle" : "Sent when you're back online"}
          held={a.queueHeld()}
          canSendAll={a.connected() && !a.running() && a.online()}
          onSendAll={a.sendQueued}
          onEdit={a.editQueued}
          onRemove={a.removeQueued}
          onSendNow={a.sendQueuedNow}
          onClear={a.clearQueue}
        />
      </Show>
      <Show when={a.running()}>
        <ActivityBar label={a.state().stopRequested ? "Stopping" : "Working"} elapsed={formatElapsed(a.clock() - a.turnStart())} hint={a.state().stopRequested ? undefined : "Esc to stop"} />
      </Show>
      <Show when={leadRequest()} keyed>
        {(request) => (
          <PermissionDock
            title={request.event.title}
            brand={props.brand}
            details={permissionView(request.event)}
            options={request.event.options}
            busy={Boolean(a.pendingAction())}
            autoFocus={dockFocusProps.autoFocus}
            onFocusChange={dockFocusProps.onFocusChange}
            onChoose={(optionId) => void a.answerPermission(request.event.requestId, optionId)}
          />
        )}
      </Show>
      <Show when={childRequest()} keyed>
        {(request) => (
          <PermissionDock
            title={request.event.title}
            from={request.agentName}
            details={permissionView(request.event)}
            options={request.event.options}
            busy={Boolean(a.pendingAction())}
            autoFocus={dockFocusProps.autoFocus}
            onFocusChange={dockFocusProps.onFocusChange}
            onChoose={(optionId) => void a.answerChildPermission(request, optionId)}
          />
        )}
      </Show>
      <Show when={!a.permission() && !a.childPermission() && a.elicitation()}>
        {(request) => (
          <Show
            when={request().mode === "url"}
            fallback={
              <Show when={`${request().requestId}:${a.form()?.index ?? 0}`} keyed>
                {(_key) => (
                  <QuestionDock
                    asker={{ ...props.brand, label: props.label }}
                    step={a.fields().length > 1 ? `${(a.form()?.index ?? 0) + 1} of ${a.fields().length}` : undefined}
                    prompt={
                      !field()
                        ? request().message
                        : field()!.type === "unsupported"
                          ? `${request().message} (${field()!.label}: Span cannot answer this kind of question)`
                          : a.fields().length === 1
                            ? request().message
                            : `${request().message} (${field()!.label})`
                    }
                    detail={field()?.description}
                    error={a.form()?.error}
                    options={field() ? field()!.options : [{ id: "accept", label: "Continue" }]}
                    allowText={Boolean(field() && !field()!.options.length && field()!.type !== "unsupported")}
                    autoFocus={dockFocusProps.autoFocus}
                    onFocusChange={dockFocusProps.onFocusChange}
                    onAnswer={(answer) => void a.answerForm(answer)}
                    onCancel={() => void a.respondElicitation(request().requestId, "decline")}
                  />
                )}
              </Show>
            }
          >
            <UrlDock
              title="The agent asks you to open a page"
              text={`${request().message} Span opens this address in your browser only after you choose Open browser.`}
              brand={props.brand}
              href={request().url ?? ""}
              autoFocus={dockFocusProps.autoFocus}
              onFocusChange={dockFocusProps.onFocusChange}
              onOpen={() => void a.openElicitationUrl(request().requestId, request().url ?? "")}
              onCancel={() => void a.respondElicitation(request().requestId, "decline")}
            />
          </Show>
        )}
      </Show>
      <div class="att-dropzone agent-composer">
        <Show when={a.menu() && a.menu() !== "actions" && a.menu() !== "attach"}>
          <button class="agent-menu-dismiss" aria-label="Close agent menu" tabindex="-1" onClick={closeMenu} />
        </Show>
        <div class="agent-popover-anchor">
          <Show when={slashOpen() && (groups().length || a.prompt().length > 1)}>
            <SlashPopover groups={groups()} onSelect={pickSlash} onClose={() => setSlashClosedFor(a.prompt())} />
          </Show>
          <Show when={a.menu() === "model"}>
            <ModelPopover
              agentName={props.label}
              options={config()}
              agents={a.installed().map((entry) => ({ id: entry.id, name: a.registryName(entry.id) || entry.id, subtitle: entry.version, current: entry.id === a.agentId() }))}
              busy={a.pendingAction().startsWith("config:") || a.working() || a.running()}
              onSelect={(id, value) => void a.setConfig(id, value)}
              onSwitchAgent={(id) => a.connectInstalled(id)}
              onClose={closeMenu}
            />
          </Show>
          <Show when={a.menu() === "agents"}>
            <div class="sb-popover" role="dialog" aria-label="Agents">
              <Show when={isDesktop} fallback={<p class="sb-fine pad">Open span desktop to connect an ACP agent.</p>}>
                <div class="sb-eyebrow">Installed agents</div>
                <For each={a.installed()} fallback={<p class="sb-fine pad">No managed agents installed yet.</p>}>
                  {(entry) => (
                    <button class="sb-option" disabled={a.working()} onClick={() => a.connectInstalled(entry.id)}>
                      <BrandIcon id={entry.id} name={a.registryName(entry.id)} size={15} />
                      <span class="sb-option-text">
                        <span class="sb-option-name">{a.registryName(entry.id) || entry.id}</span>
                        <span class="sb-sub">{entry.version}</span>
                      </span>
                    </button>
                  )}
                </For>
                <div class="sb-rule-h" />
                <button
                  class="sb-option"
                  onClick={() => {
                    a.setMenu(null);
                    a.setView("connect");
                  }}
                >
                  <Icon name="Code1" size={15} />
                  <span class="sb-option-text">
                    <span class="sb-option-name">Registry and custom command</span>
                  </span>
                  <Icon name="arrow-right4" size={11} />
                </button>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={a.menu() === "attach"}>
          <AttachMenu agentName={props.label} capabilities={a.caps()} handlers={attachHandlers()} disabledReasons={attachReasons()} onClose={() => a.setMenu(null)} returnFocus={() => plus} />
        </Show>
        <Show when={a.selection() || a.contextPaths().length}>
          <ul class="att-chips agent-contexts" aria-label="Editor context">
            <Show when={a.selection()}>
              {(selected) => (
                <li class="att-chip agent-context-live" title={selected().path}>
                  <span class="att-chip-open">
                    <FileIcon path={selected().path} />
                    <span class="att-chip-name">{leaf(selected().path)} · selection</span>
                  </span>
                  <button type="button" class="att-chip-remove" aria-label="Remove selected code from context" onClick={a.hideSelection}>
                    <Icon name="CloseCircle" size={11} />
                  </button>
                </li>
              )}
            </Show>
            <For each={a.contextPaths()}>
              {(path) => (
                <li class="att-chip" title={path}>
                  <span class="att-chip-open">
                    <FileIcon path={path} />
                    <span class="att-chip-name">{leaf(path)}</span>
                  </span>
                  <button type="button" class="att-chip-remove" aria-label={`Remove ${path} from context`} onClick={() => a.removeContextPath(path)}>
                    <Icon name="CloseCircle" size={11} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <AttachmentTray items={a.attachments()} capabilities={a.caps()} onOpen={(item) => item.status !== "loading" && a.setViewing(item.id)} onRemove={a.removeAttachment} onEmpty={() => input?.focus()} />
        <Show when={reportable().length}>
          <p class="agent-blocked" role="status">
            {reportable().length === 1 ? `${reportable()[0].item.name} cannot be sent: ${reportable()[0].reason}` : `${reportable().length} attachments cannot be sent to ${props.label}.`} Remove{" "}
            {reportable().length === 1 ? "it" : "them"} to send.
          </p>
        </Show>
        <label class="sb-visually-hidden" for="agent-prompt">
          Message to agent
        </label>
        <textarea
          id="agent-prompt"
          ref={(element) => {
            input = element;
            a.setInput(element);
          }}
          class="agent-input"
          rows="2"
          value={a.prompt()}
          placeholder={a.running() ? "Steer the agent, or press Tab to queue…" : a.connected() ? `Ask ${props.label}…` : "Connect an agent to start"}
          spellcheck={false}
          onInput={(event) => {
            noteTyping();
            a.setPrompt(event.currentTarget.value);
          }}
          onPaste={a.intake.onPaste}
          onKeyDown={(event) => {
            if (event.defaultPrevented) return;
            noteTyping(event);
            if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing && dockOpen()) {
              // An open dock is answered from the keyboard by moving into it. Tab does not queue while one is open.
              event.preventDefault();
              focusDock(footer?.querySelector<HTMLElement>(".sb-dock") ?? undefined);
              return;
            }
            a.recallPrompt(event);
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              if (event.altKey) toggle("attach");
              // While a turn runs Enter steers (cancel, then send next) and Tab queues. Idle Enter just sends.
              else if (a.running()) void a.steer();
              else void a.send();
            } else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing && a.running() && hasPayload()) {
              event.preventDefault();
              void a.send();
            }
          }}
        />
        <div class="agent-composer-toolbar" role="toolbar" aria-label="Agent prompt options">
          <button
            ref={plus}
            class="agent-tool-button"
            title={unavailable ?? "Attach files and context"}
            aria-label={unavailable ? `Attach files and context, unavailable: ${unavailable}` : "Attach files and context"}
            aria-haspopup="menu"
            aria-expanded={a.menu() === "attach"}
            disabled={Boolean(unavailable)}
            onClick={() => toggle("attach")}
          >
            <Icon name="Add" size={16} />
          </button>
          <input ref={uploadInput} class="att-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={pickFiles} />
          <input ref={imageInput} class="att-file-input" type="file" multiple accept="image/*" tabIndex={-1} aria-hidden="true" onChange={pickFiles} />
          <button
            class="agent-tool-button agent-model-button"
            aria-label={a.connected() ? `Agent and model: ${props.label}, ${modelLabel()}` : "Select agent"}
            title={a.connected() ? "Agent and model" : "Select agent"}
            aria-haspopup="dialog"
            aria-expanded={a.menu() === "model" || a.menu() === "agents"}
            onClick={() => toggle(a.connected() ? "model" : "agents")}
          >
            <BrandIcon id={props.brand.id} name={props.brand.name} size={15} />
            <span class="agent-model-name">{a.connected() ? modelLabel() : "No agent"}</span>
            <Show when={a.connected() && level()}>
              {(current) => (
                <span class="agent-level" aria-hidden="true">
                  <For each={Array.from({ length: current().count }, (_, index) => index)}>
                    {(index) => <span classList={{ on: index < current().index }} style={{ height: `${Math.round(30 + (70 * (index + 1)) / current().count)}%` }} />}
                  </For>
                </span>
              )}
            </Show>
            <Icon name="arrow-down4" size={10} />
          </button>
          <Show when={a.connected() && mode()}>
            {(option) => (
              <button class="agent-tool-button agent-mode-button" aria-label={`${option().name}: ${currentChoice(option())?.name ?? option().currentValue}`} aria-haspopup="dialog" onClick={() => toggle("model")}>
                <span class="agent-model-name">{currentChoice(option())?.name ?? option().currentValue}</span>
                <Icon name="arrow-down4" size={10} />
              </button>
            )}
          </Show>
          <span class="agent-toolbar-spacer" />
          <Show when={a.connected() && usage()}>
            <UsageRing used={usage()!.used} size={usage()!.size} cost={usage()!.cost} warnAt={BANNER_AT} />
          </Show>
          <Show when={a.connected() && !usage() && a.state().turnUsage}>
            <span class="sb-sub nowrap agent-turn-tokens" title="Tokens the agent reported for the last turn. It did not report a context size.">
              {a.state().turnUsage!.tokens.toLocaleString()} tokens last turn
            </span>
          </Show>
          <button
            class="agent-send"
            aria-label={a.running() ? "Queue follow-up" : "Send prompt"}
            title={
              !a.connected()
                ? "Connect an agent to send"
                : a.blocked().length
                  ? "Remove the attachments this agent cannot take"
                  : a.running()
                    ? "Queue for after this turn · Tab"
                    : "Send · Enter"
            }
            disabled={!a.canSend()}
            onClick={() => void a.send()}
          >
            <Icon name="u-send" size={16} />
          </button>
          <Show when={a.running()}>
            <button class="agent-send stop" aria-label="Stop agent" disabled={a.state().stopRequested} title={a.state().stopRequested ? "Waiting for cancellation" : "Stop · Esc"} onClick={() => void a.stop()}>
              <Icon name="Stop" size={15} />
            </button>
          </Show>
        </div>
        <AttachmentNotices intake={a.intake} />
      </div>
      <div class="agent-composer-hint">
        <span class="sb-ellipsis">{isDesktop ? (a.connected() ? a.state().statusMessage : "Connect an ACP agent to begin") : "Browser preview · agent unavailable"}</span>
      </div>
      <Show when={a.connected()}>
        <ComposerHints mode={hintMode()} hints={hints()} />
      </Show>
    </footer>
  );
}
