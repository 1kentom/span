import { For, Match, Show, Switch, createMemo, createUniqueId } from "solid-js";
import type { AgentController } from "../../lib/agent-controller";
import type { FeedItem } from "../../lib/agent-session";
import type { Attachment } from "../../lib/attachments";
import { changedFiles } from "../../lib/agent-view";
import { liveStateText, liveTone, type LiveAgent } from "../../lib/live-agents";
import { ChangesCard } from "../agent/WorkGroup";
import { AttachmentIcon, tileMeta } from "../attachments";
import { BrandIcon } from "../BrandIcon";
import { Icon } from "../Icon";

export type SideTab = "changes" | "agents" | "files";
export const SIDE_TABS: { id: SideTab; label: string; icon: string }[] = [
  { id: "changes", label: "Changes", icon: "Code1" },
  { id: "agents", label: "Agents", icon: "collaborators" },
  { id: "files", label: "Files", icon: "Folder2" },
];

type ProposalItem = Extract<FeedItem, { kind: "proposal" }>;

/** The thread's files: sent attachments, newest message first, then what waits in the composer. One entry per id. */
export function sessionFiles(feed: readonly FeedItem[], composer: readonly Attachment[]): { item: Attachment; where: "sent" | "composer" }[] {
  const seen = new Set<string>();
  const found: { item: Attachment; where: "sent" | "composer" }[] = [];
  for (const entry of [...feed].reverse()) {
    if (entry.kind !== "user") continue;
    for (const item of entry.attachments ?? []) if (!seen.has(item.id)) (seen.add(item.id), found.push({ item, where: "sent" }));
  }
  for (const item of composer) if (!seen.has(item.id)) (seen.add(item.id), found.push({ item, where: "composer" }));
  return found;
}

function Empty(props: { title: string; text: string }) {
  return (
    <div class="ap-empty">
      <span class="ap-empty-title">{props.title}</span>
      <span class="ap-empty-text">{props.text}</span>
    </div>
  );
}

function ChangesTab(props: { agent: AgentController; onOpenFile: (path: string) => void }) {
  const a = props.agent;
  const proposals = createMemo(() => a.feed().filter((item): item is ProposalItem => item.kind === "proposal"));
  const files = createMemo(() => changedFiles(proposals()));
  const pending = () => files().filter((file) => file.state === "pending");
  const pathOf = (id: string) => proposals().find((item) => item.proposal.id === id)?.proposal.path;
  const act = (ids: string[], accept: boolean) => {
    if (!a.pendingAction()) void a.reviewMany(ids, accept);
  };
  return (
    <Show when={files().length} fallback={<Empty title="No changes yet" text="Edits the agent proposes in this thread show up here for review." />}>
      <div class="ap-tab-scroll ap-tab-pad">
        <ChangesCard
          headline={files().length === 1 ? "1 proposed edit" : `${files().length} proposed edits`}
          files={files()}
          stateText={pending().length ? "Review required" : "Reviewed"}
          onAcceptAll={() => act(pending().map((file) => file.path), true)}
          onRejectAll={() => act(pending().map((file) => file.path), false)}
          onAccept={(id) => act([id], true)}
          onReject={(id) => act([id], false)}
          onOpen={(id) => {
            const path = pathOf(id);
            if (path) props.onOpenFile(path);
          }}
        />
        <p class="ap-fine">Accepting changes the editor buffer. Saving is a separate step.</p>
      </div>
    </Show>
  );
}

function AgentNode(props: { agent: LiveAgent; child: boolean; last: boolean; showHealth: boolean; onOpen?: () => void; onStop?: () => void }) {
  const tone = () => liveTone(props.agent, props.showHealth);
  return (
    <li class="ap-node" classList={{ child: props.child, last: props.last }} data-tone={tone()}>
      <div class="ap-node-head">
        <span class="ap-node-face">
          <BrandIcon id={props.agent.id} name={props.agent.name} size={props.child ? 16 : 20} />
        </span>
        <span class="ap-node-name">{props.agent.name}</span>
        <span class="ap-node-role">{props.agent.lead ? "Lead" : "Delegated"}</span>
        <span class="ap-pill" data-tone={tone()}>{liveStateText(props.agent, props.showHealth)}</span>
      </div>
      <Show when={props.agent.detail}>
        <div class="ap-node-detail">{props.agent.detail}</div>
      </Show>
      <Show when={props.onOpen || props.onStop}>
        <div class="ap-node-actions">
          <Show when={props.onOpen}>
            <button type="button" class="ap-btn small" onClick={() => props.onOpen?.()}>
              Show task
            </button>
          </Show>
          <Show when={props.onStop}>
            <button type="button" class="ap-btn small ghost" onClick={() => props.onStop?.()}>
              Stop
            </button>
          </Show>
        </div>
      </Show>
    </li>
  );
}

function AgentsTab(props: { agent: AgentController; onShowTask: (taskId: string) => void }) {
  const a = props.agent;
  const crew = createMemo(() => a.liveAgents());
  const lead = () => crew().find((entry) => entry.lead);
  const delegates = () => crew().filter((entry) => !entry.lead);
  const busy = () => a.running() || delegates().some((entry) => entry.state === "Working" || entry.state === "Starting" || entry.state === "Waiting for you");
  const summary = () => {
    const working = crew().filter((entry) => entry.state === "Working").length;
    const waiting = crew().filter((entry) => entry.state === "Waiting for you").length;
    return [working ? `${working} working` : "", waiting ? `${waiting} waiting for you` : ""].filter(Boolean).join(", ") || "Nothing running";
  };
  return (
    <Show when={crew().length && a.state().sessionId} fallback={<Empty title="No agents yet" text="Agents appear here once the session starts." />}>
      <div class="ap-tab-scroll ap-tab-pad">
        <div class="ap-tree-head">
          <span class="ap-tree-title">{crew().length === 1 ? "1 agent" : `${crew().length} agents`}</span>
          <span class="ap-tree-sub">{summary()}</span>
          <Show when={busy()}>
            <button type="button" class="ap-btn small ghost" title="Stopping the lead cancels every task it started" onClick={() => void a.stop()}>
              Stop all
            </button>
          </Show>
        </div>
        <ul class="ap-tree" aria-label="Agents in this session">
          <Show when={lead()}>{(entry) => <AgentNode agent={entry()} child={false} last={!delegates().length} showHealth={a.healthOn()} onStop={a.running() ? () => void a.stop() : undefined} />}</Show>
          <For each={delegates()}>
            {(entry, index) => (
              <AgentNode
                agent={entry}
                child
                last={index() === delegates().length - 1}
                showHealth={a.healthOn()}
                onOpen={entry.taskId ? () => props.onShowTask(entry.taskId!) : undefined}
                onStop={entry.taskId && (entry.state === "Working" || entry.state === "Starting") ? () => void a.cancelTask(entry.taskId!) : undefined}
              />
            )}
          </For>
        </ul>
        <ul class="ap-rules">
          <li><Icon name="Check" size={12} />Delegated agents cannot delegate further.</li>
          <li><Icon name="Check" size={12} />Their permission requests come to you, never to the lead.</li>
          <li><Icon name="Check" size={12} />Stopping the lead cancels every task it started.</li>
        </ul>
      </div>
    </Show>
  );
}

function FilesTab(props: { agent: AgentController }) {
  const a = props.agent;
  const files = createMemo(() => sessionFiles(a.feed(), a.attachments()));
  return (
    <Show when={files().length} fallback={<Empty title="No files in this session" text="Drop files on the composer to attach them. Images and files you send stay listed here." />}>
      <ul class="ap-tab-scroll ap-files" aria-label="Files in this session">
        <For each={files()}>
          {(entry) => (
            <li>
              <button type="button" class="ap-file" onClick={() => a.openAttachment(entry.item)} aria-label={`${entry.item.name}, ${entry.where === "sent" ? "sent" : "in the composer"}. Open preview`}>
                <AttachmentIcon kind={entry.item.kind} size={15} />
                <span class="ap-file-text">
                  <span class="ap-file-name">{entry.item.name}</span>
                  <span class="ap-file-source">{entry.where === "sent" ? "Sent in this thread" : "In the composer"}</span>
                </span>
                <span class="ap-file-meta">{tileMeta(entry.item)}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/**
 * The Agents page side panel: Changes (the thread's proposals and review state), Agents (the lead and its
 * delegates, from live-agents.ts) and Files (the thread's attachments). Tabs follow the ARIA tabs pattern.
 */
export function SidePanel(props: { agent: AgentController; tab: SideTab; onTab: (tab: SideTab) => void; onClose: () => void; onOpenFile: (path: string) => void; onShowTask: (taskId: string) => void }) {
  const a = props.agent;
  const ids = { tabs: createUniqueId(), panel: createUniqueId() };
  let list: HTMLDivElement | undefined;
  const counts = createMemo<Record<SideTab, number>>(() => ({
    changes: a.feed().filter((item) => item.kind === "proposal").length,
    agents: a.state().sessionId ? a.liveAgents().length : 0,
    files: sessionFiles(a.feed(), a.attachments()).length,
  }));
  const move = (event: KeyboardEvent) => {
    const order = SIDE_TABS.map((tab) => tab.id);
    const at = order.indexOf(props.tab);
    const next = event.key === "ArrowRight" ? order[(at + 1) % order.length] : event.key === "ArrowLeft" ? order[(at - 1 + order.length) % order.length] : event.key === "Home" ? order[0] : event.key === "End" ? order[order.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    props.onTab(next);
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
  };
  return (
    <section class="ap-side" aria-label="Side panel">
      <div class="ap-side-head">
        <div ref={list} class="ap-tabs" role="tablist" aria-label="Side panel" id={ids.tabs} onKeyDown={move}>
          <For each={SIDE_TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="ap-tab"
                data-tab={tab.id}
                id={`${ids.tabs}-${tab.id}`}
                aria-selected={props.tab === tab.id}
                aria-controls={ids.panel}
                tabIndex={props.tab === tab.id ? 0 : -1}
                onClick={() => props.onTab(tab.id)}
              >
                <Icon name={tab.icon} size={13} />
                {tab.label}
                <Show when={counts()[tab.id]}>
                  <span class="ap-count">{counts()[tab.id]}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <span class="ap-grow" />
        <button type="button" class="ap-icon-btn" aria-label="Hide side panel" title="Hide side panel" onClick={() => props.onClose()}>
          <Icon name="panel-right" size={15} />
        </button>
      </div>
      <div class="ap-side-body" role="tabpanel" id={ids.panel} aria-labelledby={`${ids.tabs}-${props.tab}`}>
        <Switch>
          <Match when={props.tab === "changes"}>
            <ChangesTab agent={a} onOpenFile={props.onOpenFile} />
          </Match>
          <Match when={props.tab === "agents"}>
            <AgentsTab agent={a} onShowTask={props.onShowTask} />
          </Match>
          <Match when={props.tab === "files"}>
            <FilesTab agent={a} />
          </Match>
        </Switch>
      </div>
    </section>
  );
}
