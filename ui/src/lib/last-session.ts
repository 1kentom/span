// UI-only memory of the chat that was open last in a workspace, so reopening the app can pick it up again.
import { isRecord, readStored, recordOf, stringArray, writeStored } from "./stored";

export type LastSession = { agentId: string; sessionId: string };

const KEY = "span.agent.lastSession";

const lastSession = (value: unknown): LastSession | undefined =>
  isRecord(value) && typeof value.agentId === "string" && typeof value.sessionId === "string" ? { agentId: value.agentId, sessionId: value.sessionId } : undefined;

const readAll = (): Record<string, LastSession> => readStored(KEY, recordOf(lastSession), {});

export function readLastSession(workspace: string): LastSession | undefined {
  return readAll()[workspace];
}

export function writeLastSession(workspace: string, value: LastSession | undefined) {
  const all = readAll();
  if (value) all[workspace] = value;
  else delete all[workspace];
  writeStored(KEY, all);
}

// UI-only list of agent ids most recently used first, across workspaces. Warm start (ADR 0009) starts these first.
const RECENT_KEY = "span.agent.recent";
const RECENT_LIMIT = 8;

export function readRecentAgents(): string[] {
  return readStored(RECENT_KEY, stringArray, []);
}

export function noteAgentUsed(id: string) {
  const next = [id, ...readRecentAgents().filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
  writeStored(RECENT_KEY, next);
}
