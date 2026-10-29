import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { agentListSessions: vi.fn(), agentListAllSessions: vi.fn() },
  sessionMetaList: vi.fn(),
  sessionMetaUpdate: vi.fn(),
}));
vi.mock("../client", () => ({ isDesktop: true, api: mocks.api, sessionMetaList: mocks.sessionMetaList, sessionMetaUpdate: mocks.sessionMetaUpdate }));

import { agentHistory } from "./history";

const held = () => createRoot((dispose) => ({ history: agentHistory.use(), dispose }));
const meta = (agentId: string, sessionId: string, title?: string) => ({ agentId, sessionId, titleOverride: title ?? null }) as never;

describe("agent history store", () => {
  it("lists sessions for the scope and shares them with every holder", async () => {
    mocks.api.agentListSessions.mockResolvedValue([{ sessionId: "s1" }]);
    mocks.api.agentListAllSessions.mockResolvedValue([{ sessionId: "s1" }, { sessionId: "s2" }]);
    mocks.sessionMetaList.mockResolvedValue([meta("codex", "s1", "First")]);
    const sidebar = held();
    const page = held();
    expect(page.history).toBe(sidebar.history);
    await sidebar.history.loadSessions(() => true);
    expect(page.history.sessions().map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(page.history.metaOf("codex", "s1")?.titleOverride).toBe("First");
    expect(page.history.metaOf(undefined, "s1")).toBeUndefined();
    page.history.setSessionScope("all");
    await page.history.loadSessions(() => true);
    expect(sidebar.history.sessions()).toHaveLength(2);
    sidebar.dispose();
    page.dispose();
    const next = held();
    expect(next.history.sessions()).toEqual([]);
    next.dispose();
  });

  it("drops answers for a caller that is no longer current", async () => {
    mocks.api.agentListSessions.mockResolvedValue([{ sessionId: "late" }]);
    mocks.sessionMetaList.mockResolvedValue([meta("codex", "late")]);
    mocks.sessionMetaUpdate.mockResolvedValue(meta("codex", "late", "Saved"));
    const { history, dispose } = held();
    await history.loadSessions(() => false);
    await history.recordSessionMeta({ agentId: "codex", sessionId: "late" } as never, () => false);
    expect(history.sessions()).toEqual([]);
    expect(history.sessionMeta()).toEqual([]);
    expect(history.sessionsBusy()).toBe(true);
    dispose();
  });

  it("keeps one record per agent and session, newest first", async () => {
    mocks.sessionMetaUpdate.mockResolvedValueOnce(meta("codex", "a", "One")).mockResolvedValueOnce(meta("codex", "a", "Two"));
    const { history, dispose } = held();
    await history.recordSessionMeta({ agentId: "codex", sessionId: "a" } as never, () => true);
    history.keepSaved(meta("claude", "a", "Other agent"));
    await history.recordSessionMeta({ agentId: "codex", sessionId: "a" } as never, () => true);
    expect(history.sessionMeta().map((entry) => `${entry.agentId}:${entry.titleOverride}`)).toEqual(["codex:Two", "claude:Other agent"]);
    dispose();
  });
});
