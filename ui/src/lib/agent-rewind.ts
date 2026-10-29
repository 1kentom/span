import type { FeedItem } from "./agent-session";
import { toolLocations, workspaceRelative } from "./agent-view";

/**
 * Message actions on a user message: edit, resend, fork, and restore files to that point. ACP has no way to rewind a
 * session, so edit, resend and fork start a new session and send the earlier turns as context with its first prompt
 * (see agent-handoff.ts). Restoring files only uses the proposal review flow: an edit still waiting for review can be
 * rejected, an edit already applied cannot be undone here.
 */
export type BranchMode = "edit" | "resend" | "fork";

/** A workspace file changed after a message. `pending` are proposal ids still waiting for review. */
export type RewindFile = { path: string; label: string; pending: string[]; applied: boolean };

/**
 * End index (exclusive) of the feed carried into the new session. Edit and resend keep everything before the message;
 * fork keeps the message and its replies up to the next user message. Undefined when `itemId` is not a user message.
 */
export function branchCut(feed: readonly FeedItem[], itemId: number, mode: BranchMode): number | undefined {
  const index = feed.findIndex((item) => item.id === itemId);
  if (index < 0 || feed[index].kind !== "user") return undefined;
  if (mode !== "fork") return index;
  const next = feed.findIndex((item, position) => position > index && item.kind === "user");
  return next < 0 ? feed.length : next;
}

const EDIT_KINDS = ["edit", "delete", "move"];

/**
 * Files changed from the message's own turn onward. A path with proposals takes its state from them only (the edit
 * tool call that produced a proposal is the same change); rejected proposals changed nothing. A path with no
 * proposal but a successful edit tool call was written by the agent directly, so it counts as applied.
 */
export function changesAfter(feed: readonly FeedItem[], itemId: number, root?: string): RewindFile[] {
  const start = feed.findIndex((item) => item.id === itemId);
  if (start < 0) return [];
  const files = new Map<string, { path: string; proposals: boolean; pending: string[]; accepted: boolean; tool: boolean }>();
  const entry = (path: string) => {
    const key = workspaceRelative(root, path) ?? path;
    let file = files.get(key);
    if (!file) files.set(key, (file = { path, proposals: false, pending: [], accepted: false, tool: false }));
    return file;
  };
  for (const item of feed.slice(start + 1)) {
    if (item.kind === "proposal") {
      const file = entry(item.proposal.path);
      file.proposals = true;
      if (!item.resolution) file.pending.push(item.proposal.id);
      if (item.resolution === "accepted") file.accepted = true;
    }
    if (item.kind === "tool" && EDIT_KINDS.includes(item.event.toolKind ?? "") && item.event.status !== "failed") {
      const typed = item.event.locations ?? [];
      const paths = [...(item.event.diffs ?? []).map((diff) => diff.path), ...(typed.length ? typed : toolLocations(item.event.contentJson)).map((location) => location.path)];
      for (const path of paths) if (path?.trim()) entry(path).tool = true;
    }
  }
  return [...files.entries()].flatMap(([label, file]) => {
    const applied = file.proposals ? file.accepted : file.tool;
    return file.pending.length || applied ? [{ path: file.path, label, pending: file.pending, applied }] : [];
  });
}

/** The reason sentence for the carried context header. */
export function branchReason(mode: BranchMode): string {
  const action = mode === "fork" ? "forked the chat into a new session" : "started a new session from an earlier message";
  return `Span ${action} because ACP cannot rewind a session. Later messages of that session are not included.`;
}

const BRANCH_TITLE: Record<BranchMode, string> = {
  edit: "Edited an earlier message in a new session.",
  resend: "Resent an earlier message in a new session.",
  fork: "Forked into a new session.",
};

/** The divider shown where the new session starts: a title and the honest note under it. */
export function branchDivider(mode: BranchMode, carried: boolean): { title: string; note: string; text: string } {
  const title = BRANCH_TITLE[mode];
  const context = carried ? "Earlier turns go to the agent as context with the next message." : "No earlier turns to carry.";
  const note = `ACP cannot rewind a session, so this is a new one. ${context} Tool state and permissions do not carry over. The original chat is left as it was.`;
  return { title, note, text: `${title} ${note}` };
}

/** Text of the "Context sent" card on the first message of a branched session. */
export const BRANCH_CONTEXT_NOTE = " · earlier turns of this chat";
