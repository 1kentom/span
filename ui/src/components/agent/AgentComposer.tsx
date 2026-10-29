import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { FileIcon, Icon } from "../Icon";
import { AttachMenu, AttachmentNotices, AttachmentTray, SessionPicker, type AttachMenuItemId } from "../attachments";
import type { AgentController } from "../../lib/agent-controller";
import { ATTACH_UNAVAILABLE } from "../../lib/agent-controller";
import { composerHints } from "../../lib/agent-hints";
import { shouldFocusDock } from "../../lib/agent-dock-focus";
import { delegationLine, isFinished } from "../../lib/agent-delegation";
import { type FeedItem, type PermissionEvent } from "../../lib/agent-session";
import { isSlashQuery, leaf, permissionDetails, slashGroups, type SpanCommand } from "../../lib/agent-view";
import { agentLimit } from "../../lib/agent-errors";
import { api, isDesktop } from "../../lib/client";
import { URL_COPY, parseUrlRequest, type UrlRequestView } from "../../lib/agent-url-request";
import { ContextHint, ContextMeter, ContextPopover, createCompaction, createStaleTracker } from "./ContextMeter";
import { compactCommand, contextPercent, meterState, limitNote, showCompactHint, type LimitNote } from "../../lib/context-usage";
import type { DelegationTaskState } from "../../lib/agent-delegation";
import { AgentStatusBar } from "./AgentStatusBar";
import { PermissionDock, QuestionDock, RewindDock, UrlDock, focusDock } from "./Docks";
import { ToolActivityBar } from "./ToolActivityBar";
import { RUN_TEXT } from "../../lib/agent-hint-text";
import { createPickers } from "./ComposerPickers";
import { brandFromModelNames, brandIconFor } from "../../lib/brand-icons";
import { configViews, currentChoice } from "../../lib/agent-view";
import { PlanDrawer } from "./PlanDrawer";
import { LiveAgents } from "./LiveAgents";
import { QueuePanel } from "./QueuePanel";
import { SlashPopover } from "./SlashPopover";
import type { Brand, PlanItem, SlashItem } from "./types";

/** Everything below the conversation: banners, plan, queue, docks, the prompt box and its toolbar. */
export function AgentComposer(props: { agent: AgentController; brand: Brand; label: string }) {
  const a = props.agent;
  const modelNames = () => (configViews(a.state().config).find((option) => option.category === "model")?.choices ?? []).map((choice) => choice.name);
  /** The panel's brand, or the family its model list names when the agent identity is not resolved (no agent id yet). */
  const brand = (): Brand => (brandIconFor(props.brand) ? props.brand : brandFromModelNames(modelNames()) ?? props.brand);
  let input: HTMLTextAreaElement | undefined;
  let plus: HTMLButtonElement | undefined;
  let uploadInput!: HTMLInputElement;
  let imageInput!: HTMLInputElement;
  let footer: HTMLElement | undefined;
  const [slashClosedFor, setSlashClosedFor] = createSignal<string>();
  /** Focus is inside the open dock. The hints row lists dock keys only then. */
  const [dockFocused, setDockFocused] = createSignal(false);
  const [editLast, setEditLast] = createSignal(0);
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
  const dockOpen = () => Boolean(a.permission() || a.childPermission() || a.elicitation() || waitingStep());
  const urlView = createMemo(() => {
    const ask = a.elicitation();
    return parseUrlRequest(ask?.message, ask?.url);
  });
  /** The page the user opened. Held in this component only, so the code is gone when the step ends or the panel closes. */
  const [browserStep, setBrowserStep] = createSignal<{ requestId: string; url: string; view: UrlRequestView } | undefined>();
  onCleanup(() => setBrowserStep(undefined));
  const stepRecord = () => {
    const step = browserStep();
    return step ? a.state().feed.find((item): item is Extract<FeedItem, { kind: "signin" }> => item.kind === "signin" && item.requestId === step.requestId) : undefined;
  };
  const waitingStep = createMemo(() => {
    const step = browserStep();
    return step && !a.elicitation() && a.connected() && a.running() && stepRecord()?.status === "opened" ? step : undefined;
  });
  /** The single running bar: the browser wait comes from this component, everything else from the controller. */
  const toolBar = createMemo(() => a.toolBar(Boolean(waitingStep())));
  createEffect(() => {
    if (!browserStep()) return;
    const status = stepRecord()?.status;
    if (!stepRecord() || status === "completed" || status === "cancelled" || !a.connected() || !a.running()) setBrowserStep(undefined);
  });
  /** A URL request the app cannot open is declined at once. The feed already records why. */
  const declinedUrls = new Set<string>();
  createEffect(() => {
    const ask = a.elicitation();
    if (ask?.mode !== "url" || !urlView().rejection || declinedUrls.has(ask.requestId)) return;
    declinedUrls.add(ask.requestId);
    void a.respondElicitation(ask.requestId, "decline");
  });
  const usage = () => a.state().usage;
  const modelName = () => currentChoice(configViews(a.state().config).find((option) => option.category === "model"))?.name;
  const stale = createStaleTracker(usage, modelName);
  const turnFinished = () => !a.running() && a.state().feed.some((item) => item.kind === "user");
  const meter = () => meterState({ usage: usage(), turnFinished: turnFinished(), stale: stale() });
  const usagePct = () => (usage() ? contextPercent(usage()!.used, usage()!.size) : undefined);
  const compact = () => compactCommand(a.state().commands);
  const compaction = createCompaction({
    usage,
    running: a.running,
    failure: () => a.state().failure,
    compactions: () => a.state().feed.filter((item): item is Extract<FeedItem, { kind: "compaction" }> => item.kind === "compaction"),
    send: (command) => a.sendText(command),
  });
  const runCompact = () => {
    const command = compact();
    if (!command || !a.connected() || a.running()) return;
    compaction.start(command);
  };
  /** A clock for the reset countdown, ticking only while an agent limit event exists. */
  const [limitNow, setLimitNow] = createSignal(Date.now());
  const limit = (): LimitNote | undefined => limitNote(agentLimit(), a.agentId() ?? a.agentName(), limitNow());
  createEffect(() => {
    if (!agentLimit()) return;
    setLimitNow(Date.now());
    const timer = setInterval(() => setLimitNow(Date.now()), 15_000);
    onCleanup(() => clearInterval(timer));
  });
  const delegatedTasks = () => a.state().feed.flatMap((item): DelegationTaskState[] => (item.kind === "delegation" ? [item.task] : []));
  const showMeter = () => a.connected() && (Boolean(usage()) || meter() === "unreported" && !a.state().turnUsage || Boolean(compaction.run()) || Boolean(limit()));
  const hint = () => showCompactHint({ pct: usagePct(), canCompact: Boolean(compact()), dismissed: a.bannerDismissed(), running: a.running(), stale: stale(), compacting: Boolean(compaction.run()) });
  let meterButton: HTMLButtonElement | undefined;
  const closeUsage = () => {
    a.setMenu(null);
    meterButton?.focus();
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
  /** The Earlier session picker, opened from the attach menu. */
  const [sessionPick, setSessionPick] = createSignal(false);
  /**
   * Only items with a real handler are offered. Paste screenshot reads the clipboard from the click and falls back to
   * the paste shortcut; Folder needs the desktop folder picker; Earlier session lists the chats this window holds.
   */
  const attachHandlers = (): Partial<Record<AttachMenuItemId, () => void>> => ({
    upload: () => uploadInput.click(),
    image: () => imageInput.click(),
    screenshot: () => void a.pasteScreenshot(),
    file: a.addCurrentFile,
    selection: a.showSelection,
    ...(a.props.pickFolder ? { folder: () => void a.addFolder() } : {}),
    session: () => setSessionPick(true),
  });
  const attachReasons = (): Partial<Record<AttachMenuItemId, string>> => {
    const path = a.props.activePath;
    return {
      file: !path ? "No file is open" : a.contextPaths().includes(path) ? "Already added" : undefined,
      selection: !a.props.selectionContext?.text ? "Nothing is selected" : a.selection() ? "Already included" : undefined,
      folder: !a.props.workspacePath ? "No folder is open" : undefined,
      session: a.earlierChats().length ? undefined : "No earlier chat open",
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
  const toggle = (menu: "attach") => a.setMenu(a.menu() === menu ? null : menu);
  const pickers = createPickers(a, { get brand() { return brand(); }, get label() { return props.label; } }, () => input);


  /** Bring a delegation card into view and focus it, from the Live agents strip. */
  const openTaskCard = (taskId: string) => {
    const card = footer?.closest(".agent-panel")?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    if (!card) return;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    card.focus({ preventScroll: true });
  };

  /** Taller field, about 40 percent of the panel. Local view state only; Escape never touches it. */
  const [expanded, setExpanded] = createSignal(false);
  createEffect(() => {
    a.prompt();
    const tall = expanded();
    if (!input) return;
    if (tall) {
      const panel = input.closest<HTMLElement>(".agent-panel")?.clientHeight ?? 0;
      input.style.height = `${Math.max(120, Math.round(panel * 0.4))}px`;
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(178, Math.max(60, input.scrollHeight))}px`;
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
      <LiveAgents agents={a.liveAgents()} now={a.healthNow()} showHealth={a.healthOn()} onOpen={(agent) => agent.taskId && openTaskCard(agent.taskId)} />
      <Show when={a.connected()}>
        <ContextHint
          pct={usagePct()}
          run={compaction.run()}
          showHint={hint()}
          onCompact={runCompact}
          onDismiss={() => (compaction.run() ? compaction.clear() : a.setBannerDismissed(true))}
        />
      </Show>
      <Show when={plan().length}>
        <PlanDrawer items={plan()} />
      </Show>
      <Show when={a.queue().length}>
        <QueuePanel
          items={a.queue().map((entry) => ({ id: entry.id, text: entry.text || `${entry.items.length} attachment${entry.items.length === 1 ? "" : "s"}` }))}
          note={a.queueHeld() ? undefined : a.online() ? "Sends when the agent finishes" : "Sends when you're back online"}
          pendingId={a.queueSending()}
          editLastToken={editLast()}
          onEmptied={() => input?.focus()}
          onReorder={a.reorderQueue}
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
        <ToolActivityBar
          view={toolBar()}
          lines={a.runningStep()?.lines}
          hidden={a.runningStep()?.hidden}
          full={a.runningStep()?.full}
          still={a.runningStep()?.still}
        />
      </Show>
      <Show when={a.rewind()}>
        {(pick) => (
          <RewindDock
            mode={pick().mode}
            files={a.rewindFiles()}
            blockReason={a.branchBlock()}
            busy={Boolean(a.pendingAction())}
            onReview={(path) => void a.openInEditor(path, undefined, a.props.onReviewInEditor ?? a.props.onOpenFile)}
            onRevert={(ids) => void a.revertFiles(ids)}
            onKeep={() => void a.keepFiles()}
            onCancel={a.cancelRewind}
          />
        )}
      </Show>
      <Show when={leadRequest()} keyed>
        {(request) => (
          <PermissionDock
            title={request.event.title}
            brand={brand()}
            details={permissionView(request.event)}
            options={request.event.options}
            busy={Boolean(a.pendingAction())}
            autoFocus={dockFocusProps.autoFocus}
            onFocusChange={dockFocusProps.onFocusChange}
            onChoose={(optionId) => void a.answerPermission(request.event.requestId, optionId)}
            onCopy={(text) => api.writeClipboard(text)}
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
            onCopy={(text) => api.writeClipboard(text)}
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
                    asker={{ ...brand(), label: props.label }}
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
              title={urlView().title}
              text={`${urlView().text} ${URL_COPY.consent}`.trim()}
              brand={brand()}
              href={request().url ?? ""}
              code={urlView().code}
              autoFocus={dockFocusProps.autoFocus}
              onFocusChange={dockFocusProps.onFocusChange}
              onCopyCode={(code) => api.writeClipboard(code)}
              onOpen={() => {
                setBrowserStep({ requestId: request().requestId, url: request().url ?? "", view: urlView() });
                void a.openElicitationUrl(request().requestId, request().url ?? "");
              }}
              onCancel={() => void a.respondElicitation(request().requestId, "decline")}
            />
          </Show>
        )}
      </Show>
      <Show when={waitingStep()}>
        {(step) => (
          <UrlDock
            waiting
            title={step().view.title}
            text={step().view.text}
            brand={brand()}
            href={step().url}
            code={step().view.code}
            autoFocus={dockFocusProps.autoFocus}
            onFocusChange={dockFocusProps.onFocusChange}
            onCopyCode={(code) => api.writeClipboard(code)}
            onOpen={() => void api.openExternal(step().url).catch(() => undefined)}
            onCancel={() => setBrowserStep(undefined)}
          />
        )}
      </Show>
      <div class="att-dropzone agent-composer" classList={{ expanded: expanded() }}>
        <Show when={pickers.open()}>
          <button class="agent-menu-dismiss" aria-label="Close agent menu" tabindex="-1" onClick={pickers.close} />
        </Show>
        <Show when={a.menu() === "usage"}>
          <button class="agent-menu-dismiss" aria-label="Close usage details" tabindex="-1" onClick={closeUsage} />
        </Show>
        <div class="agent-popover-anchor">
          <Show when={slashOpen() && (groups().length || a.prompt().length > 1)}>
            <SlashPopover groups={groups()} onSelect={pickSlash} onClose={() => setSlashClosedFor(a.prompt())} />
          </Show>
          <pickers.Popovers />
          <Show when={a.menu() === "usage"}>
            <ContextPopover
              agent={{ id: a.agentId(), name: props.label }}
              state={meter()}
              usage={usage()}
              model={modelName()}
              limit={limit()}
              now={limitNow()}
              tasks={delegatedTasks()}
              compactCommand={compact()}
              busy={a.running()}
              run={compaction.run()}
              onCompact={runCompact}
              onClose={closeUsage}
            />
          </Show>
        </div>
        <Show when={a.menu() === "attach"}>
          <AttachMenu agentName={props.label} capabilities={a.caps()} handlers={attachHandlers()} disabledReasons={attachReasons()} onClose={() => a.setMenu(null)} returnFocus={() => plus} />
        </Show>
        <Show when={sessionPick()}>
          <SessionPicker sessions={a.earlierChats()} onPick={a.attachSession} onClose={() => setSessionPick(false)} returnFocus={() => plus} />
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
        <AttachmentTray items={a.attachments()} capabilities={a.caps()} onOpen={(item) => { if (item.status !== "loading") a.openAttachment(item); }} onRemove={a.removeAttachment} onEmpty={() => input?.focus()} />
        <Show when={reportable().length}>
          <p class="agent-blocked" role="status">
            {reportable().length === 1 ? `${reportable()[0].item.name} cannot be sent: ${reportable()[0].reason}` : `${reportable().length} attachments cannot be sent to ${props.label}.`} Remove{" "}
            {reportable().length === 1 ? "it" : "them"} to send.
          </p>
        </Show>
        <Show when={a.runHint()}>
          <div class="agent-run-hint">
            <span class="sb-flex">{RUN_TEXT.busy}</span>
            <Show when={a.busyNotice()}>
              <button type="button" class="sb-btn" disabled={!a.canSend()} onClick={() => void a.steer()}>
                Steer
              </button>
              <button type="button" class="sb-btn" disabled={!a.canSend()} onClick={() => void a.send()}>
                Queue
              </button>
            </Show>
          </div>
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
            // With messages queued, ArrowUp in an empty composer edits the last one instead of recalling a prompt.
            if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing && !a.prompt() && a.queue().length) {
              event.preventDefault();
              setEditLast((token) => token + 1);
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
          <pickers.Chips />
          <span class="agent-toolbar-spacer" />
          <Show when={showMeter()}>
            <ContextMeter
              state={meter()}
              usage={usage()}
              agent={props.label}
              expanded={a.menu() === "usage"}
              compacting={compaction.run()?.phase === "running"}
              onToggle={(button) => {
                meterButton = button;
                if (a.menu() === "usage") closeUsage();
                else a.setMenu("usage");
              }}
            />
          </Show>
          <Show when={a.connected() && !usage() && a.state().turnUsage}>
            <span class="sb-sub nowrap agent-turn-tokens" title="Tokens the agent reported for the last turn. It did not report a context size.">
              {a.state().turnUsage!.tokens.toLocaleString()} tokens last turn
            </span>
          </Show>
          {/* Expand, send and stop stay together. When the row is too short they move to a second line as one group. */}
          <span class="agent-toolbar-end">
          <button
            type="button"
            class="agent-tool-button agent-expand"
            aria-pressed={expanded()}
            aria-label={expanded() ? "Collapse composer" : "Expand composer"}
            title={expanded() ? "Collapse composer" : "Expand composer"}
            onClick={() => setExpanded(!expanded())}
          >
            <Icon name="Maximize4" size={14} />
          </button>
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
          </span>
        </div>
        <AttachmentNotices intake={a.intake} />
      </div>
      <AgentStatusBar
        text={isDesktop ? (a.connected() ? a.state().statusMessage : "Connect an ACP agent to begin") : "Browser preview · agent unavailable"}
        running={a.running()}
        input={{
          connecting: Boolean(a.connecting()),
          toolActive: Boolean(a.runningStep()),
          needsYou: dockOpen(),
          failed: a.state().status === "error",
        }}
        hints={{ mode: hintMode(), hints: a.connected() ? hints() : {} }}
        delegating={Boolean(a.state().sessionId && a.state().delegation.attached?.sessionId === a.state().sessionId)}
        delegationActive={a.feed().some((item) => item.kind === "delegation" && !isFinished(item.task.status))}
      />
    </footer>
  );
}
