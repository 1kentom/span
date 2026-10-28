// UI-only memory of the chat that was open last in a workspace, so reopening the app can pick it up again.
export type LastSession = { agentId: string; sessionId: string };

const KEY = "span.agent.lastSession";

function readAll(): Record<string, LastSession> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function readLastSession(workspace: string): LastSession | undefined {
  const found = readAll()[workspace];
  return found && typeof found.agentId === "string" && typeof found.sessionId === "string" ? found : undefined;
}

export function writeLastSession(workspace: string, value: LastSession | undefined) {
  const all = readAll();
  if (value) all[workspace] = value;
  else delete all[workspace];
  try { window.localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage can be unavailable */ }
}

// UI-only list of agent ids most recently used first, across workspaces. Warm start (ADR 0009) starts these first.
const RECENT_KEY = "span.agent.recent";
const RECENT_LIMIT = 8;

export function readRecentAgents(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function noteAgentUsed(id: string) {
  const next = [id, ...readRecentAgents().filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage can be unavailable */ }
}
