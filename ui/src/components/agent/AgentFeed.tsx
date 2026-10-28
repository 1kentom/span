import { For, Match, Show, Switch, createMemo } from "solid-js";
import { AgentMarkdown } from "../AgentMarkdown";
import { MessageAttachments } from "../attachments";
import type { AgentController } from "../../lib/agent-controller";
import type { FeedItem } from "../../lib/agent-session";
import { buildBlocks, changedFiles, noticeView, stopView, toStep, workChildren, workSummary, type Block } from "../../lib/agent-view";
import { decisionView, taskNote } from "../../lib/agent-delegation";
import { EditsBypassNote, ErrorCard, Notice, StopCard } from "./Banners";
import { DecisionCard } from "./DecisionCard";
import { DelegationCard } from "./DelegationCard";
import { ChangesCard, WorkGroup } from "./WorkGroup";

const sameKeys = (previous: string[], next: string[]) => previous.length === next.length && previous.every((key, index) => key === next[index]);

function FeedEntry(props: { agent: AgentController; item: () => FeedItem; last: () => boolean }) {
  const a = props.agent;
  const item = props.item;
  const message = () => item() as Extract<FeedItem, { text: string }>;
  const openFile = (path: string) => void a.openInEditor(path);
  return (
    <Switch>
      <Match when={item().kind === "user"}>
        <div class="agent-message user" data-feed-id={item().id} classList={{ steered: Boolean((item() as Extract<FeedItem, { kind: "user" }>).steered) }}>
          <Show when={(item() as Extract<FeedItem, { kind: "user" }>).steered}>
            <div class="agent-steered-label">Steered</div>
          </Show>
          {message().text}
          <MessageAttachments items={(item() as Extract<FeedItem, { kind: "user" }>).attachments ?? []} onOpen={(attachment) => a.setViewing(attachment.id)} />
        </div>
      </Match>
      <Match when={item().kind === "text" || item().kind === "thought"}>
        <div class={`agent-message ${item().kind}`} aria-busy={a.running() && props.last() ? "true" : undefined}>
          <Show when={item().kind === "thought"}>
            <div class="agent-message-label">Thinking</div>
          </Show>
          <AgentMarkdown
            text={message().text}
            workspaceRoot={a.props.workspacePath || ""}
            streaming={a.running() && props.last()}
            onOpenFile={openFile}
            onOpenExternal={a.props.onOpenExternal}
          />
        </div>
      </Match>
      <Match when={item().kind === "note"}>
        <Notice text={message().text} />
      </Match>
      <Match when={item().kind === "notice"}>
        {(() => {
          const notice = () => item() as Extract<FeedItem, { kind: "notice" }>;
          const view = () => noticeView(notice());
          return (
            <Show
              when={notice().severity === "warning" || notice().severity === "error"}
              fallback={<Notice text={view().description ? `${view().title} · ${view().description}` : view().title} />}
            >
              <ErrorCard level={notice().severity === "error" ? "error" : "warn"} title={view().title} text={view().description} actions={[]} />
            </Show>
          );
        })()}
      </Match>
      <Match when={item().kind === "compaction"}>
        {(() => {
          const compaction = () => item() as Extract<FeedItem, { kind: "compaction" }>;
          return (
            <Switch fallback={<Notice text={compaction().status === "cancelled" ? "Compaction cancelled" : "Compacting context"} />}>
              <Match when={compaction().status === "failed"}>
                <ErrorCard level="warn" title="Context compaction failed" text={compaction().error} actions={[]} />
              </Match>
              <Match when={compaction().status === "completed"}>
                <Notice text="Context compacted" />
                <Show when={compaction().summary}>
                  <details class="agent-summary">
                    <summary>Summary the agent kept</summary>
                    <AgentMarkdown text={compaction().summary} workspaceRoot={a.props.workspacePath || ""} onOpenFile={openFile} onOpenExternal={a.props.onOpenExternal} />
                  </details>
                </Show>
              </Match>
            </Switch>
          );
        })()}
      </Match>
      <Match when={item().kind === "decision"}>
        {(() => {
          const view = () => decisionView((item() as Extract<FeedItem, { kind: "decision" }>).decision, a.agentLabel());
          return <DecisionCard by={view().by} chosen={view().chosen} why={view().why} alternatives={view().alternatives} />;
        })()}
      </Match>
      <Match when={item().kind === "delegation"}>
        {(() => {
          const task = () => (item() as Extract<FeedItem, { kind: "delegation" }>).task;
          return <DelegationCard agent={task().agentName ?? "Delegated agent"} status={task().status} note={taskNote(task())} waiting={a.childPermissions().some((entry) => entry.child.sessionId === task().child.sessionId)} />;
        })()}
      </Match>
      <Match when={item().kind === "stop"}>
        {(() => {
          const reason = () => (item() as Extract<FeedItem, { kind: "stop" }>).reason;
          const stop = () => stopView(reason(), (item() as Extract<FeedItem, { kind: "stop" }>).hint)!;
          return (
            <Show when={props.last() && !a.running() && a.connected()} fallback={<Notice text={`Stopped: ${stop().title.toLowerCase()}`} />}>
              <StopCard title={stop().title} code={reason()} text={stop().text} onContinue={() => a.sendText("Continue")} />
            </Show>
          );
        })()}
      </Match>
    </Switch>
  );
}

function Work(props: { agent: AgentController; block: () => Extract<Block, { type: "work" }> }) {
  const a = props.agent;
  const steps = createMemo(() => props.block().tools.map((tool) => toStep(tool, workChildren(a.feed(), tool), a.props.workspacePath, (path, line) => void a.openInEditor(path, line), (id) => a.setViewing(id))));
  const summary = createMemo(() => workSummary(steps()));
  const bypass = () => Boolean(a.state().agent?.features.editsBypassReview) && steps().some((step) => step.kind === "edit" && !step.internal);
  return (
    <>
      <WorkGroup headline={summary().headline} counts={summary().counts} steps={steps()} />
      <Show when={bypass()}><EditsBypassNote agent={a.agentLabel()} /></Show>
    </>
  );
}

function Changes(props: { agent: AgentController; block: () => Extract<Block, { type: "changes" }> }) {
  const a = props.agent;
  const files = createMemo(() => changedFiles(props.block().proposals));
  const proposalFor = (id: string) => props.block().proposals.find((item) => item.proposal.id === id)?.proposal;
  const pending = () => files().filter((file) => file.state === "pending");
  const act = (ids: string[], accept: boolean) => {
    if (!a.pendingAction()) void a.reviewMany(ids, accept);
  };
  // Proposal hunks carry character offsets, not lines, so a changes-card row opens the file without a line.
  const openPath = (path: string) => void a.openInEditor(path, undefined, a.props.onReviewInEditor ?? a.props.onOpenFile);
  const note = () =>
    files().some((file) => file.state === "accepted")
      ? "Accepted edits are in the editor buffer. Use Save to write them to disk."
      : pending().length
        ? "Accepting changes the editor buffer. Saving is a separate step."
        : "Rejected proposals did not change any file.";
  return (
    <div class="agent-changes">
      <ChangesCard
        headline={files().length === 1 ? "1 proposed edit" : `${files().length} proposed edits`}
        files={files()}
        stateText={pending().length ? "Review required" : "Reviewed"}
        onReview={a.props.onReviewInEditor && pending().length ? () => openPath(proposalFor(pending()[0].path)!.path) : undefined}
        onAcceptAll={() => act(pending().map((file) => file.path), true)}
        onRejectAll={() => act(pending().map((file) => file.path), false)}
        onAccept={(id) => act([id], true)}
        onReject={(id) => act([id], false)}
        onOpen={(id) => {
          const proposal = proposalFor(id);
          if (proposal) openPath(proposal.path);
        }}
      />
      <Show when={a.state().agent?.features.editsBypassReview}><EditsBypassNote agent={a.agentLabel()} /></Show>
      <p class="sb-fine agent-unsaved-note">{note()}</p>
    </div>
  );
}

/** The conversation: messages, notices, work groups and per-turn changes, built from the session feed. */
export function AgentFeed(props: { agent: AgentController; ref?: (element: HTMLDivElement) => void }) {
  const a = props.agent;
  const blocks = createMemo(() => buildBlocks(a.feed()));
  const byKey = createMemo(() => new Map(blocks().map((block) => [block.key, block])));
  const keys = createMemo(() => blocks().map((block) => block.key), [], { equals: sameKeys });
  const lastKey = () => keys()[keys().length - 1];
  return (
    // Not a live region: streaming markdown re-renders constantly. The composer announces turn start and end and new
    // requests; the streaming message is aria-busy until the turn completes.
    <div class="agent-feed" ref={props.ref}>
      <For each={keys()}>
        {(key) => {
          const block = () => byKey().get(key);
          const last = () => lastKey() === key;
          return (
            <Show when={block()}>
              <Switch>
                <Match when={block()!.type === "item"}>
                  <FeedEntry agent={a} item={() => (block() as Extract<Block, { type: "item" }>).item} last={last} />
                </Match>
                <Match when={block()!.type === "work"}>
                  <Work agent={a} block={() => block() as Extract<Block, { type: "work" }>} />
                </Match>
                <Match when={block()!.type === "changes"}>
                  <Changes agent={a} block={() => block() as Extract<Block, { type: "changes" }>} />
                </Match>
              </Switch>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
