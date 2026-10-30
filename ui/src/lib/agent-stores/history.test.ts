import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { agentListSessions: vi.fn(), agentListAllSessions: vi.fn() },
  sessionMetaList: vi.fn(),
  sessionMetaUpdate: vi.fn(),
}));
vi.mock("../client", () => ({ isDesktop: true, api: mocks.api, sessionMetaList: mocks.sessionMetaList, sessionMetaUpdate: mocks.sessionMetaUpdate }));

import { setShowSubagentSessions } from "../subagent-sessions";
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

  it("hides health check sessions but keeps chats whose titles only look alike", async () => {
    mocks.api.agentListSessions.mockResolvedValue([
      { sessionId: "h1", title: "Health check. Reply with exactly one word: OK" },
      { sessionId: "h2", title: "Health check. Reply with exactly one word..." },
      { sessionId: "h3", title: "  Health check. Reply with exactly one word\u2026" },
      { sessionId: "ci", title: "Health check of the CI pipeline" },
      { sessionId: "two", title: "Health check. Reply with exactly two words: ALL GOOD" },
      { sessionId: "plain", title: "Health check" },
      { sessionId: "renamed", title: "Health check response" },
      { sessionId: "renamed2", title: "health check response request." },
      { sessionId: "endpoint", title: "Health check endpoint" },
      { sessionId: "k8s", title: "Health checks for k8s" },
      { sessionId: "untitled", title: null },
    ]);
    mocks.sessionMetaList.mockResolvedValue([]);
    const { history, dispose } = held();
    history.setSessionScope("workspace");
    await history.loadSessions(() => true);
    const listed = history.sessions().map((entry) => entry.sessionId);
    // Titles an agent regenerated for an old health session ("Health check response") are hidden too; near misses stay.
    expect(listed).toEqual(["ci", "two", "endpoint", "k8s", "untitled"]);
    // Resuming the last chat only picks a session History lists (agent-controller restoreLastSession), so a health
    // session saved by an earlier version is never resumed.
    expect(listed.some((id) => ["h1", "h2", "h3", "plain", "renamed", "renamed2"].includes(id))).toBe(false);
    dispose();
  });

  it("hides native subagent sessions unless the preference shows them, and nests them under their parent", async () => {
    mocks.api.agentListSessions.mockResolvedValue([
      { sessionId: "parent", title: "Draw a car" },
      { sessionId: "child", title: "Generate BMW M2 PNG image", nativeSubagent: true, parentSessionId: "parent" },
      { sessionId: "orphan", title: "Child session - 2026-10-29T10:00:00.000Z", nativeSubagent: true, parentSessionId: null },
      { sessionId: "lookalike", title: "Child session notes", nativeSubagent: false },
    ]);
    mocks.sessionMetaList.mockResolvedValue([]);
    setShowSubagentSessions(false);
    const { history, dispose } = held();
    history.setSessionScope("workspace");
    await history.loadSessions(() => true);
    expect(history.sessions().map((entry) => entry.sessionId)).toEqual(["parent", "lookalike"]);
    expect(history.subagentsFor("parent").map((entry) => entry.sessionId)).toEqual(["child"]);
    expect(history.subagentsFor("lookalike")).toEqual([]);
    expect(history.subagentCount()).toBe(2);
    expect(history.isSubagent("child")).toBe(true);
    expect(history.isSubagent("parent")).toBe(false);
    setShowSubagentSessions(true);
    expect(history.sessions().map((entry) => entry.sessionId)).toEqual(["parent", "child", "orphan", "lookalike"]);
    setShowSubagentSessions(false);
    dispose();
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
