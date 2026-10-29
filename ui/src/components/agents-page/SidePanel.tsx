import { For, Match, Show, Switch, createMemo, createUniqueId } from "solid-js";
import type { AgentController } from "../../lib/agent-controller";
import type { FeedItem } from "../../lib/agent-session";
import type { Attachment } from "../../lib/attachments";
import { changedFiles, diffLines } from "../../lib/agent-view";
import { agentTree, compactTokens, type TreeNode } from "../../lib/agents-page-tree";
import type { DiffLine } from "../agent/types";
import { ChangesCard, DiffView } from "../agent/WorkGroup";
import { AttachmentIcon, tileMeta } from "../attachments";
import { BrandIcon } from "../BrandIcon";
import { FileIcon, Icon } from "../Icon";

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

/** Files the agents wrote in this thread: images a tool saved and the artifacts of delegated tasks, newest first, one per path. */
export function generatedFiles(feed: readonly FeedItem[]): { path: string; by: string }[] {
  const seen = new Set<string>();
  const found: { path: string; by: string }[] = [];
  for (const entry of [...feed].reverse()) {
    const paths = entry.kind === "tool" && entry.event.savedPath ? [{ path: entry.event.savedPath, by: "Saved by the lead" }] : entry.kind === "delegation" ? (entry.task.artifacts ?? []).map((artifact) => ({ path: artifact.path, by: `From ${entry.task.agentName || "a delegated agent"}` })) : [];
    for (const file of paths) if (!seen.has(file.path)) (seen.add(file.path), found.push(file));
  }
  return found;
}

/** A proposal's hunks as one unified diff. Hunk offsets are not line numbers, so the lines carry none. */
export function proposalDiff(item: ProposalItem): DiffLine[] {
  const trim = (text: string) => text.replace(/\n$/, "");
  return item.proposal.hunks.flatMap((hunk) => diffLines(trim(hunk.before), trim(hunk.after)).map((line) => ({ kind: line.kind, text: line.text })));
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
        <div class="ap-review" aria-label="Proposed changes">
          <For each={proposals()}>
            {(item) => (
              <div class="ap-review-file" data-state={item.resolution ?? "pending"}>
                <DiffView path={item.proposal.path} lines={proposalDiff(item)} onOpen={() => props.onOpenFile(item.proposal.path)} />
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

function TreeRow(props: { node: TreeNode; onOpen?: () => void; onStop?: () => void }) {
  const node = () => props.node;
  return (
    <li class="ap-node" classList={{ child: node().child, last: node().last, command: node().kind === "command" }} data-tone={node().tone} data-kind={node().kind}>
      <div class="ap-node-head">
        <Show
          when={node().kind === "agent"}
          fallback={
            <span class="ap-node-cmd" aria-hidden="true">
              <Icon name="u-terminal" size={11} />
            </span>
          }
        >
          <span class="ap-node-face">
            <BrandIcon id={node().id} name={node().name} size={node().child ? 16 : 20} />
            <Show when={node().live}>
              <span class="ap-node-live" data-tone={node().tone} aria-hidden="true" />
            </Show>
          </span>
        </Show>
        <span class="ap-node-name">{node().name}</span>
        <span class="ap-node-role">{node().role}</span>
        <span class="ap-pill" data-tone={node().tone}>
          <Show when={node().tone === "working" || node().tone === "running"}>
            <span class="ap-pill-spin" aria-hidden="true" />
          </Show>
          {node().state}
        </span>
      </div>
      <Show when={node().model || node().meta}>
        <div class="ap-node-line">
          <Show when={node().model}>
            <span class="ap-node-model">{node().model}</span>
          </Show>
          <Show when={node().meta}>
            <span class="ap-node-meta">{node().meta}</span>
          </Show>
        </div>
      </Show>
      <Show when={node().note}>
        <div class="ap-node-note" data-tone={node().tone}>
          <span class="ap-node-bullet" aria-hidden="true" />
          <span class="ap-node-note-text">{node().note}</span>
        </div>
      </Show>
      <Show when={node().budget}>
        {(budget) => (
          <div class="ap-node-budget">
            <span class="ap-node-bar" role="progressbar" aria-label="Token budget" aria-valuemin={0} aria-valuemax={budget().limit} aria-valuenow={budget().used}>
              <span style={{ width: `${Math.min(100, Math.round((budget().used / budget().limit) * 100))}%` }} />
            </span>
            <span class="ap-node-meta">{`${compactTokens(budget().used)} / ${compactTokens(budget().limit)} tokens`}</span>
          </div>
        )}
      </Show>
      <Show when={props.onOpen || props.onStop}>
        <div class="ap-node-actions">
          <Show when={props.onOpen}>
            <button type="button" class="ap-btn small" onClick={() => props.onOpen?.()}>
              {node().kind === "command" ? "Show output" : node().tone === "error" ? "Show task" : "Open session"}
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
  const tree = createMemo(() => (a.state().sessionId ? agentTree({ agents: a.liveAgents(), feed: a.feed(), showHealth: a.healthOn(), leadRunning: a.running() }) : undefined));
  const stopRow = (node: TreeNode) => {
    // The lead stops through "Stop all" in the header, which cancels every task it started (the design's rule).
    if (!node.canStop || !node.child) return undefined;
    return node.taskId ? () => void a.cancelTask(node.taskId!) : undefined;
  };
  const openRow = (node: TreeNode) => (node.taskId ? () => props.onShowTask(node.taskId!) : node.toolCallId ? () => a.followLatest() : undefined);
  return (
    <Show when={tree()?.nodes.length ? tree() : undefined} fallback={<Empty title="No agents yet" text="Agents appear here once the session starts." />}>
      {(current) => (
        <div class="ap-tab-scroll ap-tab-pad">
          <div class="ap-tree-head">
            <span class="ap-tree-title">{current().head}</span>
            <span class="ap-tree-sub">{current().sub}</span>
            <Show when={current().canStopAll}>
              <button type="button" class="ap-btn small" title="Stopping the lead cancels every task it started" onClick={() => void a.stop()}>
                Stop all
              </button>
            </Show>
          </div>
          <ul class="ap-tree" aria-label="Agents in this session">
            <For each={current().nodes}>{(node) => <TreeRow node={node} onOpen={openRow(node)} onStop={stopRow(node)} />}</For>
          </ul>
          <ul class="ap-rules">
            <li>
              <Icon name="Check" size={12} />
              Delegated agents can't delegate further (depth 1).
            </li>
            <li>
              <Icon name="Check" size={12} />
              Their permission requests come to you, never to the lead.
            </li>
            <li>
              <Icon name="Check" size={12} />
              Stopping the lead cancels every task it started.
            </li>
          </ul>
        </div>
      )}
    </Show>
  );
}

function FilesTab(props: { agent: AgentController }) {
  const a = props.agent;
  const files = createMemo(() => sessionFiles(a.feed(), a.attachments()));
  const generated = createMemo(() => generatedFiles(a.feed()));
  return (
    <Show when={files().length || generated().length} fallback={<Empty title="No files in this session" text="Drop files on the composer to attach them. Files you send and files the agents write stay listed here." />}>
      <div class="ap-tab-scroll">
        <Show when={files().length}>
          <h4 class="ap-files-head">Attached</h4>
          <ul class="ap-files" aria-label="Files in this session">
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
        <Show when={generated().length}>
          <h4 class="ap-files-head">Generated</h4>
          <ul class="ap-files" aria-label="Files the agents wrote">
            <For each={generated()}>
              {(entry) => (
                <li>
                  <button type="button" class="ap-file" onClick={() => void a.openInEditor(entry.path)} aria-label={`${entry.path}, ${entry.by}. Open in editor`}>
                    <FileIcon path={entry.path} />
                    <span class="ap-file-text">
                      <span class="ap-file-name">{entry.path.split("/").pop()}</span>
                      <span class="ap-file-source">{entry.by}</span>
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
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
    files: sessionFiles(a.feed(), a.attachments()).length + generatedFiles(a.feed()).length,
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
