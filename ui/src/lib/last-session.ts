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
