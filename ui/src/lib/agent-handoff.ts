import type { FeedItem } from "./agent-session";
import { toolLocations, workspaceRelative } from "./agent-view";

/**
 * Provider handoff (issue #87, recent context mode). An ACP session is bound to one agent process, so switching agent
 * starts a new session. Span keeps the feed on screen and sends the last few messages and the changed files as part
 * of the first prompt of the new session. The user sees exactly what was sent. Nothing here is a protocol fork.
 */

/** Messages carried over by default: the last N user and assistant messages. */
export const HANDOFF_TURNS = 6;
/** Longest text kept from one message. Longer messages are cut with a marker. */
export const HANDOFF_MESSAGE_LIMIT = 1200;
/** Most changed files listed. */
export const HANDOFF_FILE_LIMIT = 30;
/** What the new agent does not get. Shown in the divider so the switch is never presented as a full transfer. */
export const HANDOFF_LIMITS = "Tool state, agent memory and permissions do not carry over; the new agent starts a new session.";

export type HandoffTurn = { role: "user" | "assistant"; text: string };

/** The divider shown in the feed after a successful switch: a short title and the honest note under it. */
export function handoffDivider(from: string, to: string, carried: boolean): { title: string; note: string; text: string } {
  const title = `Switched from ${from} to ${to}.`;
  const note = `Context carried over: ${carried ? "recent turns" : "none"}. ${HANDOFF_LIMITS}`;
  return { title, note, text: `${title} ${note}` };
}

/** User and assistant messages in feed order. Consecutive assistant text blocks form one message; thoughts are skipped. */
export function feedTurns(feed: readonly FeedItem[]): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  for (const item of feed) {
    if (item.kind === "user") {
      if (item.text.trim()) turns.push({ role: "user", text: item.text.trim() });
      continue;
    }
    if (item.kind !== "text") continue;
    const last = turns[turns.length - 1];
    if (last?.role === "assistant") last.text = `${last.text}${item.text}`;
    else turns.push({ role: "assistant", text: item.text });
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() })).filter((turn) => turn.text);
}

const EDIT_KINDS = ["edit", "delete", "move"];

/** Workspace files the conversation changed: proposals that were not rejected, and edit tool calls that did not fail. */
export function feedChangedFiles(feed: readonly FeedItem[], root?: string): string[] {
  const seen = new Set<string>();
  const add = (path: string | undefined) => {
    if (!path?.trim()) return;
    seen.add(workspaceRelative(root, path) ?? path);
  };
  for (const item of feed) {
    if (item.kind === "proposal" && item.resolution !== "rejected") add(item.proposal.path);
    if (item.kind === "tool" && EDIT_KINDS.includes(item.event.toolKind ?? "") && item.event.status !== "failed") {
      for (const diff of item.event.diffs ?? []) add(diff.path);
      const typed = item.event.locations ?? [];
      for (const location of typed.length ? typed : toolLocations(item.event.contentJson)) add(location.path);
    }
  }
  return [...seen];
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit).trimEnd()} [cut]` : text);

/** Why the context was carried, in the header of the block, when no other reason is given. */
export const HANDOFF_SWITCH_REASON = "Span carried it over when the user switched agents.";

/**
 * The compact block sent ahead of the first prompt in the new session, or undefined when there is nothing to carry.
 * `turns` is the number of user and assistant messages kept, newest last. `reason` replaces the agent switch sentence
 * in the header, for a new session started from an earlier message of the same chat.
 */
export function buildHandoff(feed: readonly FeedItem[], options: { from: string; turns?: number; root?: string; reason?: string }): string | undefined {
  const keep = Math.max(0, options.turns ?? HANDOFF_TURNS);
  const turns = keep ? feedTurns(feed).slice(-keep) : [];
  const files = feedChangedFiles(feed, options.root);
  if (!turns.length && !files.length) return undefined;
  const lines = [`[Context from an earlier session with ${options.from}. ${options.reason ?? HANDOFF_SWITCH_REASON} Tool state, memory and permissions from that session are not available.]`];
  if (turns.length) {
    lines.push("", `Recent messages (last ${turns.length}):`);
    for (const turn of turns) lines.push(`${turn.role === "user" ? "User" : "Agent"}: ${clip(turn.text, HANDOFF_MESSAGE_LIMIT)}`);
  }
  if (files.length) {
    lines.push("", "Files changed:");
    for (const file of files.slice(0, HANDOFF_FILE_LIMIT)) lines.push(`- ${file}`);
    if (files.length > HANDOFF_FILE_LIMIT) lines.push(`- and ${files.length - HANDOFF_FILE_LIMIT} more`);
  }
  lines.push("[End of carried context]");
  return lines.join("\n");
}

/** The feed kept across a switch. Permission requests of the old session can no longer be answered, so they close. */
export const carryFeed = (feed: readonly FeedItem[]): FeedItem[] => feed.map((item) => (item.kind === "permission" && !item.resolved ? { ...item, resolved: true } : item));

/** The prompt text for the first message of the new session: the handoff block, then the user's own message. */
export const withHandoff = (handoff: string, message: string) => `${handoff}\n\n${message}`;
