import { createSignal } from "solid-js";
import type { SessionSummary } from "../bindings";

/**
 * Native subagent sessions (ADR 0005, amendment of 2026-10-29): sessions an agent created with its OWN subagent tool,
 * which the agent's `session/list` returns beside the user's chats. The backend marks them (`nativeSubagent`, with
 * `parentSessionId` when the agent named the parent); History, the Agents page rail, recents, resume-last and the
 * counters read the filtered list, and the children stay reachable under their parent thread. They belong to the
 * agent, so Span never deletes them.
 */

const SHOW_KEY = "span.history.showSubagentSessions";

function readFlag(): boolean {
  try {
    return window.localStorage.getItem(SHOW_KEY) === "true";
  } catch {
    return false;
  }
}

const [show, setShow] = createSignal(readFlag());
/** The History preference "Show subagent sessions" (off by default): list native subagents as rows of their own. */
export const showSubagentSessions = show;
export function setShowSubagentSessions(value: boolean) {
  setShow(value);
  try {
    window.localStorage.setItem(SHOW_KEY, String(value));
  } catch {
    // Storage can be unavailable; the preference then lasts for this window only.
  }
}

type Listed = Pick<SessionSummary, "sessionId"> & { nativeSubagent?: boolean; parentSessionId?: string | null };

/** True for a session the agent created with its own subagent tool. */
export const isNativeSubagent = (session: Listed) => session.nativeSubagent === true;

/** The listed sessions History shows: native subagents only when the preference asks for them. */
export function visibleSessions<T extends Listed>(listed: readonly T[], showSubagents: boolean): T[] {
  return showSubagents ? [...listed] : listed.filter((session) => !isNativeSubagent(session));
}

/** The native subagents the agent listed under `parentId`. A child whose parent is unknown is never nested. */
export function subagentsOf<T extends Listed>(listed: readonly T[], parentId: string): T[] {
  return listed.filter((session) => isNativeSubagent(session) && session.parentSessionId === parentId);
}
