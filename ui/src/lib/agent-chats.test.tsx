// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures, SessionRuntimeState_Serialize as SessionRuntimeState, SessionStates_Serialize as SessionStates } from "../bindings";
import { mount } from "../components/agent/test-utils";
import { createAgentController, type AgentController } from "./agent-controller";
import { BACKGROUND_FEED_LIMIT, attentionSessions, evictions, isBusyPromptError, newAttention, reduceBackground, rowStatus, type ChatSnapshot } from "./agent-chats";
import { initialAgentState } from "./agent-session";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  const stateListeners: ((states: SessionStates) => void)[] = [];
  return {
    listeners,
    stateListeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    publish: (states: SessionStates) => stateListeners.forEach((listener) => listener(states)),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      onAgentSessionStates: vi.fn(async (listener: (states: SessionStates) => void) => {
        stateListeners.push(listener);
        return () => undefined;
      }),
      agentSessionStates: vi.fn(async (): Promise<SessionStates> => ({ connectionId: "connection-1", sessions: [] })),
      agentInstalled: vi.fn(async () => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(),
      agentCancel: vi.fn(async (): Promise<void> => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<{ sessionId: string; title: string | null; updatedAt: string | null }[]> => []),
      openBuffer: vi.fn(),
      agentNewSession: vi.fn(async () => "s-new"),
      agentResumeSession: vi.fn(async (id: string) => id),
      agentPermission: vi.fn(async () => undefined),
      agentCloseSession: vi.fn(async () => undefined),
    },
  };
});
vi.mock("./client", () => ({
  isDesktop: true,
  api: mocks.api,
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(),
  agentChildPermission: vi.fn(),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
}));

const features: AgentFeatures = { loadSession: true, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: true, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const runtime = (sessionId: string, patch: Partial<SessionRuntimeState> = {}): SessionRuntimeState => ({ connectionId: "connection-1", sessionId, origin: "user", state: "idle", queued: 0, startedAtMs: null, currentTool: null, ...patch });
const texts = (a: AgentController) => a.feed().flatMap((item) => ("text" in item ? [item.text] : []));

async function connected(agentFeatures: AgentFeatures = features) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features: agentFeatures, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return null;
  });
  await tick();
  controller.connectCustom("codex-acp");
  await tick();
  await tick();
  return controller;
}

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.stateListeners.splice(0);
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.api.agentPrompt.mockReset();
  mocks.api.agentConnect.mockReset();
  mocks.api.agentSessionStates.mockResolvedValue({ connectionId: "connection-1", sessions: [] });
});

describe("per-chat state in the controller", () => {
  it("switching to the session list and back keeps the running turn and the queue", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("second");
    await a.send();
    a.setView("history");
    a.setView("session");
    expect(a.running()).toBe(true);
    expect(a.queue().map((entry) => entry.text)).toEqual(["second"]);
  });

  it("keeps a Send now and its tag with the chat it was picked in", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    for (const text of ["first", "q1", "q2"]) {
      a.setPrompt(text);
      await a.send();
    }
    // Send now on q2 goes out once the running turn is cancelled, tagged in this chat's feed.
    a.sendQueuedNow(a.queue()[1].id);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    const tagged = a.feed().find((item) => item.kind === "user" && item.text === "q2")!;
    expect([...a.sentNowIds()]).toEqual([tagged.id]);
    // A Send now still waiting for its turn boundary is dropped when the chat is left.
    a.sendQueuedNow(a.queue()[0].id);
    expect(a.queueSending()).toBe(a.queue()[0].id);
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "running", startedAtMs: 1000 })] });
    await a.newChat();
    expect(a.queueSending()).toBeUndefined();
    // The new chat's feed ids start again, so a tag kept by id would land on its messages.
    for (const text of ["n1", "n2", "n3", "n4"]) {
      a.setPrompt(text);
      await a.send();
    }
    expect(a.sentNowIds().size).toBe(0);
    // Its queue can be reordered: nothing from the other chat holds the order.
    a.reorderQueue(0, 2);
    expect(a.queue().map((entry) => entry.text)).toEqual(["n3", "n4", "n2"]);
  });

  it("a chat left running keeps working in the background and comes back with its feed, running flag, queue and draft", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("build it");
    await a.send();
    a.setPrompt("then test");
    await a.send();
    a.setPrompt("half typed");
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "running", startedAtMs: 1000, currentTool: "mvn test" })] });
    await a.newChat();
    expect(a.state().sessionId).toBe("s-new");
    expect(a.running()).toBe(false);
    expect(a.prompt()).toBe("");
    expect(a.queue()).toEqual([]);
    // Output of the chat left running keeps arriving and is kept, not shown here.
    mocks.emit({ kind: "text", sessionId: "s1", text: "BUILD SUCCESS" });
    expect(texts(a)).not.toContain("BUILD SUCCESS");
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "running", startedAtMs: 1000 }), runtime("s-new")] });
    await a.resumeChat("s1");
    expect(a.state().sessionId).toBe("s1");
    expect(texts(a)).toContain("build it");
    expect(texts(a)).toContain("BUILD SUCCESS");
    expect(a.running()).toBe(true);
    expect(a.queue().map((entry) => entry.text)).toEqual(["then test"]);
    expect(a.prompt()).toBe("half typed");
  });

  it("a session Span does not hold resets the view and loads through the resume path", async () => {
    const a = await connected();
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1")] });
    await a.resumeChat("old");
    expect(mocks.api.agentResumeSession).toHaveBeenCalledWith("old");
    expect(a.state().sessionId).toBe("old");
    expect(a.running()).toBe(false);
    expect(a.feed()).toEqual([]);
    expect(a.rowStatus("old")).toBeUndefined();
  });

  it("recovers from a typed busy error: marks the chat running, keeps the text and offers steer or queue, with no error card", async () => {
    mocks.api.agentPrompt.mockRejectedValueOnce(Object.assign(new Error("A prompt is already running in this session"), { prompt: { kind: "busy", message: "A prompt is already running in this session", state: runtime("s1", { state: "running", startedAtMs: 5 }) } }));
    const a = await connected();
    a.setPrompt("are you done?");
    await a.send();
    await tick();
    expect(a.state().failure).toBeUndefined();
    expect(a.running()).toBe(true);
    expect(a.prompt()).toBe("are you done?");
    expect(a.busyNotice()).toBe(true);
    expect(texts(a)).not.toContain("are you done?");
  });

  it("counts background chats that need the user and announces only a new attention state", async () => {
    const a = await connected();
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1"), runtime("s2", { state: "running", startedAtMs: 1 })] });
    expect(a.attentionCount()).toBe(0);
    expect(a.attentionAnnouncement()).toBe("");
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1"), runtime("s2", { state: "waitingForApproval", startedAtMs: 1 })] });
    expect(a.attentionCount()).toBe(1);
    expect(a.attentionAnnouncement()).toContain("waiting for your approval");
    const first = a.attentionAnnouncement();
    // The same state published again (a timer tick on the backend side, a queue change) is not announced again.
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1"), runtime("s2", { state: "waitingForApproval", startedAtMs: 1, queued: 1 })] });
    expect(a.attentionAnnouncement()).toBe(first);
    // The open chat never counts: its dock is already on screen.
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "waitingForAnswer" })] });
    expect(a.attentionCount()).toBe(0);
    // Another connection's states are ignored.
    mocks.publish({ connectionId: "connection-9", sessions: [runtime("x", { connectionId: "connection-9", state: "waitingForApproval" })] });
    expect(a.attentionCount()).toBe(0);
  });

  it("clears background chats when the agent disconnects", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("long job");
    await a.send();
    await a.newChat();
    expect(a.chatCount()).toBe(1);
    await a.disconnect();
    expect(a.chatCount()).toBe(0);
  });
});

describe("thread per chat in the controller", () => {
  const ask = (sessionId: string, requestId: string): AgentEvent => ({ kind: "permission", sessionId, requestId, toolCallId: "t", title: "Run tests", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] });
  const threadTexts = (state: { conversation: { feed: AgentController["feed"] extends () => infer F ? F : never } }) => state.conversation.feed.flatMap((item) => ("text" in item ? [item.text] : []));

  it("the open chat is the focused thread, keyed by connection and session", async () => {
    const a = await connected();
    expect(a.focusedThread().key).toEqual({ connectionId: "connection-1", sessionId: "s1" });
    a.setPrompt("draft");
    expect(a.focusedThread().state().draft).toBe("draft");
    expect(a.threadKeys()).toEqual([{ connectionId: "connection-1", sessionId: "s1" }]);
  });

  it("switching chats while a background thread streams: each thread gets only its own events, and coming back focuses the same thread", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("build it");
    await a.send();
    const first = a.focusedThread();
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "running", startedAtMs: 1 })] });
    await a.newChat();
    const second = a.focusedThread();
    expect(second).not.toBe(first);
    expect(second.key).toEqual({ connectionId: "connection-1", sessionId: "s-new" });
    // Interleaved streaming: the background chat and the open chat each keep their own text.
    mocks.emit({ kind: "text", sessionId: "s1", text: "background one" });
    mocks.emit({ kind: "text", sessionId: "s-new", text: "open one" });
    mocks.emit({ kind: "text", sessionId: "s1", text: "background two" });
    expect(threadTexts(first.state()).join("")).toContain("background onebackground two");
    expect(threadTexts(first.state()).join("")).not.toContain("open one");
    expect(texts(a).join("")).toContain("open one");
    expect(texts(a).join("")).not.toContain("background");
    expect(first.state().conversation.running).toBe(true);
    expect(a.running()).toBe(false);
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "running", startedAtMs: 1 }), runtime("s-new")] });
    await a.resumeChat("s1");
    // Nothing is copied: the chat comes back as the very thread that kept streaming.
    expect(a.focusedThread()).toBe(first);
    expect(texts(a).join("")).toContain("background two");
    expect(a.running()).toBe(true);
    expect(a.threadKeys()).toHaveLength(2);
  });

  it("a permission request on a background thread waits in that thread, not on the open chat's dock", async () => {
    const a = await connected();
    const first = a.focusedThread();
    await a.newChat();
    mocks.emit(ask("s1", "r-background"));
    expect(a.permission()).toBeUndefined();
    expect(first.state().conversation.feed.some((item) => item.kind === "permission" && item.event.requestId === "r-background")).toBe(true);
    mocks.publish({ connectionId: "connection-1", sessions: [runtime("s1", { state: "waitingForApproval" }), runtime("s-new")] });
    expect(a.attentionCount()).toBe(1);
    await a.resumeChat("s1");
    expect(a.permission()?.event.requestId).toBe("r-background");
    await a.answerPermission("r-background", "ok");
    expect(mocks.api.agentPermission).toHaveBeenCalledWith("r-background", "ok");
    expect(a.permission()).toBeUndefined();
  });

  it("closing a chat disposes its thread", async () => {
    const a = await connected({ ...features, canCloseSessions: true });
    const first = a.focusedThread();
    a.setPrompt("left behind");
    await a.closeChat("s1");
    expect(mocks.api.agentCloseSession).toHaveBeenCalledWith("s1");
    expect(a.state().sessionId).toBe("s-new");
    expect(a.threadKeys()).toEqual([{ connectionId: "connection-1", sessionId: "s-new" }]);
    // A disposed thread takes no more changes.
    first.update((state) => ({ ...state, draft: "late" }));
    expect(first.state().draft).toBe("left behind");
    expect(a.prompt()).toBe("");
  });

  it("disconnecting disposes every background thread", async () => {
    const a = await connected();
    const first = a.focusedThread();
    await a.newChat();
    expect(a.threadKeys()).toHaveLength(2);
    await a.disconnect();
    expect(a.threadKeys()).toHaveLength(1);
    first.update((state) => ({ ...state, draft: "late" }));
    expect(first.state().draft).toBe("");
  });
});

describe("chat store and row state", () => {
  const snapshot = (): ChatSnapshot => ({ conversation: { ...initialAgentState(true), sessionId: "s1" }, draft: "", attachments: [], queue: [], queueHeld: false, pinned: true, turnStart: 0, touchedAt: 0 });

  it("applies background events to the chat they belong to and caps its feed", () => {
    let chat = snapshot();
    for (let index = 0; index < BACKGROUND_FEED_LIMIT + 50; index++) chat = reduceBackground(chat, { kind: "notice", sessionId: "s1", severity: "info", title: `n${index}` } as AgentEvent);
    expect(chat.conversation.feed.length).toBe(BACKGROUND_FEED_LIMIT);
    chat = reduceBackground(chat, { kind: "complete", sessionId: "s1", stopReason: "end_turn" } as AgentEvent);
    expect(chat.conversation.running).toBe(false);
  });

  it("evicts the oldest idle chats first and never one that is still working", () => {
    const chats: [string, ChatSnapshot][] = [["a", { ...snapshot(), touchedAt: 1 }], ["b", { ...snapshot(), touchedAt: 2 }], ["c", { ...snapshot(), touchedAt: 3 }]];
    expect(evictions(chats, 2, (key) => key === "a")).toEqual(["b"]);
  });

  it("describes each backend state, and nothing for a session Span does not hold", () => {
    expect(rowStatus(undefined, { now: 0 })).toBeUndefined();
    expect(rowStatus(runtime("s", { state: "running", startedAtMs: 0 }), { now: 42_000 })).toMatchObject({ kind: "running", label: "Running 0:42", attention: false });
    expect(rowStatus(runtime("s", { state: "waitingForApproval" }), { now: 0 })).toMatchObject({ kind: "approval", label: "Waiting for your approval", attention: true });
    expect(rowStatus(runtime("s", { state: "waitingForAnswer" }), { now: 0 })).toMatchObject({ kind: "answer", label: "Waiting for your answer", attention: true });
    expect(rowStatus(runtime("s", { state: "running", startedAtMs: 0, queued: 2 }), { now: 1000 })?.label).toBe("Running 0:01 · Queued 2");
    expect(rowStatus(runtime("s"), { now: 0 })).toMatchObject({ kind: "idle", label: "Idle" });
  });

  it("finds attention sessions and only new ones", () => {
    const before: SessionStates = { connectionId: "c", sessions: [runtime("a", { state: "waitingForApproval" })] };
    const after: SessionStates = { connectionId: "c", sessions: [runtime("a", { state: "waitingForApproval" }), runtime("b", { state: "waitingForAnswer" }), runtime("d", { state: "waitingForApproval", origin: "delegated" })] };
    expect(attentionSessions(after, "a").map((s) => s.sessionId)).toEqual(["b"]);
    expect(newAttention(before, after, undefined).map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("recognises the typed busy error and nothing else", () => {
    expect(isBusyPromptError(Object.assign(new Error("x"), { prompt: { kind: "busy", message: "x", state: null } }))).toBe(true);
    expect(isBusyPromptError({ kind: "busy", message: "x", state: null })).toBe(true);
    expect(isBusyPromptError(new Error("A prompt is already running in this session"))).toBe(false);
    expect(isBusyPromptError({ kind: "failed", message: "x" })).toBe(false);
  });
});
