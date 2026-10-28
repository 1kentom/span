// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../bindings";
import { mount } from "../components/agent/test-utils";
import { createAgentController, type AgentController, type AgentPanelProps } from "./agent-controller";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      agentInstalled: vi.fn(async () => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentAuthenticate: vi.fn(),
      agentPrompt: vi.fn(),
      agentCancel: vi.fn(async (): Promise<void> => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentElicitation: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<{ sessionId: string; title: string | null; updatedAt: string | null }[]> => []),
      openExternal: vi.fn(async () => undefined),
      openBuffer: vi.fn(),
      saveAttachment: vi.fn(),
      agentNewSession: vi.fn(async () => "s-new"),
      agentResumeSession: vi.fn(async (id: string) => id),
      agentDeleteSession: vi.fn(async () => undefined),
      agentCloseSession: vi.fn(async () => undefined),
      agentSetConfig: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    agentAuthenticateWith: vi.fn(async (_method: string, _credential: unknown): Promise<string> => "s-auth"),
    agentChildPermission: vi.fn(async (_connectionId: string, _sessionId: string, _requestId: string, _optionId: string | null): Promise<void> => undefined),
    agentDelegationStatus: vi.fn(async (): Promise<unknown> => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] })),
  };
});
vi.mock("./client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: mocks.agentAuthenticateWith, agentChildPermission: mocks.agentChildPermission, agentDelegationStatus: mocks.agentDelegationStatus }));

const features = (patch: Partial<AgentFeatures> = {}): AgentFeatures => ({ loadSession: false, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(props: Partial<AgentPanelProps> = {}) {
  let controller!: AgentController;
  mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1, ...props });
    return null;
  });
  return controller;
}
/** Connects through the real controller path, emitting what the backend emits during agent_connect. */
async function connected(agentFeatures = features(), props: Partial<AgentPanelProps> = {}) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: agentFeatures, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  const a = setup(props);
  await tick();
  a.connectCustom("agent --acp");
  await tick();
  return a;
}
const file = (name: string, type: string, body: BlobPart) => new File([body], name, { type });

beforeEach(() => {
  mocks.listeners.splice(0);
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.api.agentPrompt.mockReset();
  mocks.api.agentConnect.mockReset();
});

describe("agent controller", () => {
  it("connects with the parsed custom command and ends on a ready session", async () => {
    const a = await connected();
    expect(mocks.api.agentConnect).toHaveBeenCalledWith({ command: "agent", args: ["--acp"], env: {} }, "/w");
    expect(a.connected()).toBe(true);
    expect(a.connecting()).toBeUndefined();
    expect(a.state().agent?.title).toBe("Agent");
  });

  it("keys sign-in off authRequired when agent_connect returns an empty session, then authenticates", async () => {
    const methods = [{ id: "login", name: "Log in", description: null, kind: "agent", supported: true }];
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "a", agentTitle: null, agentVersion: null, features: features(), authMethods: methods }, { kind: "authRequired", message: "Authentication required", authMethods: methods });
      return "";
    });
    mocks.api.agentAuthenticate.mockResolvedValueOnce("s9");
    const a = setup();
    await tick();
    a.connectCustom("agent");
    await tick();
    expect(a.state().auth?.methods).toEqual(methods);
    expect(a.connected()).toBe(false);
    await a.authenticate("login");
    expect(mocks.api.agentAuthenticate).toHaveBeenCalledWith("login");
    expect(a.state().sessionId).toBe("s9");
    expect(a.state().auth).toBeUndefined();
    expect(a.connected()).toBe(true);
  });

  it("records a missing executable as a connect failure", async () => {
    mocks.api.agentConnect.mockRejectedValueOnce(new Error("Executable was not found: nope"));
    const a = setup();
    await tick();
    a.connectCustom("nope");
    await tick();
    expect(a.state().failure).toMatchObject({ phase: "connect", message: "Executable was not found: nope" });
    expect(a.connecting()?.failed).toBe(true);
  });

  it("blocks Send for attachments the agent cannot take and sends the rest as prompt attachments", async () => {
    mocks.api.agentPrompt.mockResolvedValue(undefined);
    const a = await connected(features({ image: false, embeddedContext: true }));
    await a.intake.addFiles([file("shot.png", "image/png", new Uint8Array([1, 2, 3]))], "picked");
    a.setPrompt("look");
    expect(a.blocked().map((entry) => entry.reason)).toEqual(["This agent does not accept images."]);
    expect(a.canSend()).toBe(false);
    a.removeAttachment(a.attachments()[0]);
    await a.intake.addFiles([file("notes.md", "text/markdown", "# hi")], "picked");
    expect(a.canSend()).toBe(true);
    await a.send();
    expect(mocks.api.agentPrompt).toHaveBeenCalledWith("look", [{ kind: "resource", uri: "attachment:notes.md", mimeType: "text/markdown", text: "# hi", blob: null }]);
    expect(a.attachments()).toEqual([]);
    expect(a.feed()[0]).toMatchObject({ kind: "user", text: "look", attachments: [{ name: "notes.md" }] });
  });

  it("saves an attachment into the workspace and turns it into a workspace file", async () => {
    const onFilesChanged = vi.fn();
    mocks.api.saveAttachment.mockResolvedValueOnce({ path: "assets/notes-1.txt", size: 2, renamed: true });
    const a = setup({ onFilesChanged });
    await a.intake.addFiles([file("notes.txt", "text/plain", "hi")], "pasted");
    const item = a.attachments()[0];
    await a.saveAttachment(item);
    expect(mocks.api.saveAttachment).toHaveBeenCalledWith("assets", "notes.txt", btoa("hi"));
    expect(a.attachments()[0]).toMatchObject({ id: item.id, source: "workspace-file", path: "assets/notes-1.txt", name: "notes-1.txt" });
    expect(onFilesChanged).toHaveBeenCalledTimes(1);
  });

  it("queues follow-ups while a turn runs and drains them together when it completes", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    expect(a.running()).toBe(true);
    a.setPrompt("second");
    await a.send();
    a.setPrompt("third");
    await a.send();
    expect(a.queue().map((entry) => entry.text)).toEqual(["second", "third"]);
    a.editQueued(a.queue()[1].id, "third, edited");
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("second\n\nthird, edited", []);
    expect(a.queue()).toEqual([]);
  });

  it("Send now stops the turn and sends only the chosen queued message next", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("later");
    await a.send();
    a.setPrompt("urgent");
    await a.send();
    a.sendQueuedNow(a.queue()[1].id);
    await tick();
    expect(mocks.api.agentCancel).toHaveBeenCalled();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("urgent", []);
    expect(a.queue().map((entry) => entry.text)).toEqual(["later"]);
  });

  it("Continue after a stop reason sends a normal prompt", async () => {
    mocks.api.agentPrompt.mockResolvedValue(undefined);
    const a = await connected();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "max_tokens" });
    expect(a.feed().at(-1)).toMatchObject({ kind: "stop", reason: "max_tokens" });
    a.sendText("Continue");
    expect(mocks.api.agentPrompt).toHaveBeenCalledWith("Continue", []);
  });

  it("opens a URL elicitation only on consent, then accepts it", async () => {
    const a = await connected();
    mocks.emit({ kind: "elicitation", requestId: "e1", sessionId: "s1", toolCallId: null, mode: "url", message: "Sign in", schemaJson: null, url: "https://example.com/x", elicitationId: "x" });
    expect(mocks.api.openExternal).not.toHaveBeenCalled();
    await a.openElicitationUrl("e1", "https://example.com/x");
    expect(mocks.api.openExternal).toHaveBeenCalledWith("https://example.com/x");
    expect(mocks.api.agentElicitation).toHaveBeenCalledWith("e1", "accept", null);
  });

  it("walks a form elicitation one field at a time and submits typed JSON", async () => {
    const a = await connected();
    mocks.emit({
      kind: "elicitation",
      requestId: "e2",
      sessionId: "s1",
      toolCallId: null,
      mode: "form",
      message: "Details",
      schemaJson: JSON.stringify({ properties: { env: { type: "string", enum: ["dev", "prod"] }, count: { type: "integer" } } }),
      url: null,
      elicitationId: null,
    });
    await a.answerForm({ optionId: "prod" });
    expect(a.form()?.index).toBe(1);
    await a.answerForm({ text: "x" });
    expect(a.form()?.error).toBe("count must be a number.");
    await a.answerForm({ text: "4" });
    expect(mocks.api.agentElicitation).toHaveBeenCalledWith("e2", "accept", JSON.stringify({ env: "prod", count: 4 }));
  });
});

const tool = (toolCallId: string, locations: unknown): AgentEvent => ({ kind: "tool", sessionId: "s1", toolCallId, title: "Read", status: "in_progress", toolKind: "read", parentToolCallId: null, contentJson: JSON.stringify({ locations }) });
const deferred = <T = void,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe("steer", () => {
  it("sends the steer message only after the cancel resolved and the turn ended, labelled Steered", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    const cancel = deferred();
    mocks.api.agentCancel.mockImplementationOnce(() => cancel.promise);
    a.setPrompt("change course");
    await a.steer();
    expect(mocks.api.agentCancel).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    // The turn ends before the cancel call resolved: still no prompt.
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    cancel.resolve();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("change course", []);
    expect(mocks.api.agentCancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.api.agentPrompt.mock.invocationCallOrder[1]);
    expect(a.feed().filter((item) => item.kind === "user").at(-1)).toMatchObject({ text: "change course", steered: true });
    expect(a.feed().filter((item) => item.kind === "user")[0]).not.toHaveProperty("steered");
  });

  it("also waits for the turn to end when the cancel resolves first", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("next");
    await a.steer();
    await tick();
    expect(mocks.api.agentCancel).toHaveBeenCalled();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("next", []);
  });

  it("queues the message instead when the cancel fails, and Tab style send queues without cancelling", async () => {
    mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("later");
    await a.send();
    expect(mocks.api.agentCancel).not.toHaveBeenCalled();
    expect(a.queue().map((entry) => entry.text)).toEqual(["later"]);
    mocks.api.agentCancel.mockRejectedValueOnce(new Error("no turn"));
    a.setPrompt("now");
    await a.steer();
    await tick();
    expect(a.queue().map((entry) => entry.text)).toEqual(["now", "later"]);
    expect(a.state().failure?.message).toContain("no turn");
  });
});

describe("history delete and close", () => {
  const rows = [{ sessionId: "s1", title: "Current", updatedAt: null }, { sessionId: "s2", title: "Old", updatedAt: null }];
  async function withHistory(patch: Partial<AgentFeatures> = {}) {
    mocks.api.agentListSessions.mockResolvedValue(rows);
    const a = await connected(features({ canListSessions: true, canDeleteSessions: true, canCloseSessions: true, ...patch }));
    mocks.emit({ kind: "capabilities", canLoadSession: true, canListSessions: true });
    await a.loadSessions();
    return a;
  }

  it("deletes another session and refreshes the list without touching the active one", async () => {
    const a = await withHistory();
    mocks.api.agentListSessions.mockClear();
    mocks.api.agentListSessions.mockResolvedValue([rows[0]]);
    await a.deleteChat("s2");
    await tick();
    expect(mocks.api.agentDeleteSession).toHaveBeenCalledWith("s2");
    expect(mocks.api.agentNewSession).not.toHaveBeenCalled();
    expect(a.state().sessionId).toBe("s1");
    expect(mocks.api.agentListSessions).toHaveBeenCalled();
    expect(a.sessions().map((row) => row.sessionId)).toEqual(["s1"]);
  });

  it("starts a new session at once after deleting the active one", async () => {
    const a = await withHistory();
    mocks.api.agentNewSession.mockResolvedValueOnce("s-fresh");
    mocks.api.agentListSessions.mockResolvedValue([{ sessionId: "s-fresh", title: "New", updatedAt: null }, rows[1]]);
    await a.deleteChat("s1");
    await tick();
    expect(mocks.api.agentDeleteSession).toHaveBeenCalledWith("s1");
    expect(mocks.api.agentNewSession).toHaveBeenCalledTimes(1);
    expect(a.state().sessionId).toBe("s-fresh");
    expect(a.connected()).toBe(true);
    expect(a.view()).toBe("session");
    expect(a.sessions().some((row) => row.sessionId === "s1")).toBe(false);
  });

  it("keeps the history view when the active session is deleted from it", async () => {
    const a = await withHistory();
    a.setView("history");
    await a.deleteChat("s1");
    await tick();
    expect(a.view()).toBe("history");
    expect(a.state().sessionId).toBe("s-new");
  });

  it("closes only the active session and then starts a new one", async () => {
    const a = await withHistory();
    await a.closeChat("s2");
    expect(mocks.api.agentCloseSession).not.toHaveBeenCalled();
    await a.closeChat("s1");
    await tick();
    expect(mocks.api.agentCloseSession).toHaveBeenCalledWith("s1");
    expect(mocks.api.agentNewSession).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the agent did not advertise the capability, and reports a failed delete", async () => {
    const a = await withHistory({ canDeleteSessions: false, canCloseSessions: false });
    await a.deleteChat("s2");
    await a.closeChat("s1");
    expect(mocks.api.agentDeleteSession).not.toHaveBeenCalled();
    expect(mocks.api.agentCloseSession).not.toHaveBeenCalled();
    const b = await withHistory();
    mocks.api.agentDeleteSession.mockRejectedValueOnce(new Error("denied"));
    await b.deleteChat("s2");
    expect(b.sessionsError()).toContain("denied");
    expect(b.sessions().some((row) => row.sessionId === "s2")).toBe(true);
  });
});

describe("follow and the editor toast", () => {
  it("opens only locations inside the workspace root, at their line, and only while following", async () => {
    const onOpenFile = vi.fn();
    const a = await connected(features(), { onOpenFile });
    mocks.emit(tool("t0", [{ path: "/w/off.ts", line: 1 }]));
    expect(onOpenFile).not.toHaveBeenCalled();
    a.toggleFollow();
    expect(a.following()).toBe(true);
    mocks.emit(tool("t1", [{ path: "/etc/passwd", line: 1 }]));
    mocks.emit(tool("t2", [{ path: "/w/../secret.txt" }]));
    mocks.emit(tool("t3", [{ path: "/wx/a.ts" }]));
    mocks.emit(tool("t4", [{ path: "../outside.ts" }]));
    mocks.emit(tool("t5", [{ path: "file:///w/a.ts" }]));
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(a.toast()).toBeUndefined();
    mocks.emit(tool("t6", [{ path: "/etc/passwd" }, { path: "/w/src/a.ts", line: 12 }]));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", 12);
    expect(a.toast()).toBe("a.ts");
    mocks.emit(tool("t6", [{ path: "/w/src/a.ts", line: 12 }]));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    mocks.emit(tool("t7", [{ path: "b.ts" }]));
    expect(onOpenFile).toHaveBeenLastCalledWith("b.ts", undefined);
    a.toggleFollow();
    mocks.emit(tool("t8", [{ path: "/w/c.ts" }]));
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });

  it("raises the toast for chip and tool-target opens, and not for refused paths", async () => {
    const onOpenFile = vi.fn();
    const onReviewInEditor = vi.fn();
    const a = await connected(features(), { onOpenFile, onReviewInEditor });
    expect(a.openInEditor("/outside/x.ts")).toBe(false);
    expect(a.toast()).toBeUndefined();
    expect(a.openInEditor("assets/shot.png")).toBe(true);
    expect(onOpenFile).toHaveBeenCalledWith("assets/shot.png", undefined);
    expect(a.toast()).toBe("shot.png");
    a.clearToast();
    expect(a.toast()).toBeUndefined();
    expect(a.openInEditor("/w/src/main.rs", 7, onReviewInEditor)).toBe(true);
    expect(onReviewInEditor).toHaveBeenCalledWith("src/main.rs", 7);
    expect(a.toast()).toBe("main.rs");
  });
});

describe("loading attachments", () => {
  it("shows loading placeholders while bytes are read and removes them before the real item lands", async () => {
    const a = await connected();
    const seen: string[][] = [];
    const run = a.intake.addFiles([file("notes.md", "text/markdown", "# hi")], "picked");
    seen.push(a.attachments().map((item) => item.status));
    await run;
    seen.push(a.attachments().map((item) => item.status));
    expect(seen).toEqual([["loading"], ["ready"]]);
  });
});

describe("delegated child permissions", () => {
  const child = { connectionId: "c1", sessionId: "child-1" };
  const ask = (sessionId: string, requestId: string): AgentEvent => ({ kind: "permission", sessionId, requestId, toolCallId: "t", title: "Run tests", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] });

  it("offers a child request only after a delegated card names that session, labelled with the agent", async () => {
    const a = await connected();
    mocks.emit(ask("child-1", "r1"), ask("stranger", "r2"));
    expect(a.childPermission()).toBeUndefined();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead: { connectionId: "c1", sessionId: "s1" }, child, taskId: "k1", agentName: "Codex" } });
    expect(a.childPermission()?.agentName).toBe("Codex");
    expect(a.childPermissions().map((entry) => entry.event.requestId)).toEqual(["r1"]);
    expect(a.permission()).toBeUndefined();
  });

  it("answers through agentChildPermission with the connection and session ids, then clears the request", async () => {
    const a = await connected();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead: { connectionId: "c1", sessionId: "s1" }, child, taskId: "k1", agentName: "Codex" } }, ask("child-1", "r1"));
    await a.answerChildPermission(a.childPermission()!, "ok");
    expect(mocks.agentChildPermission).toHaveBeenCalledWith("c1", "child-1", "r1", "ok");
    expect(a.childPermission()).toBeUndefined();
  });

  it("keeps the request open and reports the failure when the answer is refused", async () => {
    const a = await connected();
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead: { connectionId: "c1", sessionId: "s1" }, child, taskId: "k1", agentName: "Codex" } }, ask("child-1", "r1"));
    mocks.agentChildPermission.mockRejectedValueOnce(new Error("Not a delegated session"));
    await a.answerChildPermission(a.childPermission()!, "ok");
    expect(a.childPermission()).toBeDefined();
    expect(a.state().failure?.message).toContain("Codex");
  });

  it("adds failure detail from the status command when a task finishes", async () => {
    const a = await connected();
    mocks.agentDelegationStatus.mockResolvedValueOnce({ enabled: true, available: true, reason: null, lead: { connectionId: "c1", sessionId: "s1" }, attached: true, decisions: [], tasks: [{ taskId: "k1", lead: { connectionId: "c1", sessionId: "s1" }, child, agentName: "Codex", status: "failed", stopReason: null, reason: "timeout", detail: "No reply in 30 minutes" }] });
    mocks.emit({ kind: "delegation", event: { kind: "delegated", lead: { connectionId: "c1", sessionId: "s1" }, child, taskId: "k1", agentName: "Codex" } }, { kind: "delegation", event: { kind: "taskFinished", lead: { connectionId: "c1", sessionId: "s1" }, child, taskId: "k1", status: "failed", reason: "timeout" } });
    await tick();
    const card = a.feed().find((item) => item.kind === "delegation");
    expect(card?.kind === "delegation" && card.task.detail).toBe("No reply in 30 minutes");
  });
});

/** A prompt call the test settles by hand, standing in for the backend's session/prompt round trip. */
function controllablePrompts() {
  const calls: { message: string; resolve: () => void; reject: (cause: Error) => void }[] = [];
  mocks.api.agentPrompt.mockImplementation(
    (message: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ message, resolve, reject });
      }),
  );
  return calls;
}
const sent = () => mocks.api.agentPrompt.mock.calls.map((call) => call[0] as string);
/** Reconnects through the real controller path, as the Reconnect button does. */
function reconnectWith(a: AgentController) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s2" });
    return "s2";
  });
  a.reconnect();
  return tick();
}

describe("steer recovery", () => {
  it("normal path: sends the steer once after the cancelled turn completes, and never again", async () => {
    const calls = controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("change course");
    await a.steer();
    await tick();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    calls[0].resolve();
    await tick();
    expect(sent()).toEqual(["first", "change course"]);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    calls[1].resolve();
    await tick();
    expect(sent()).toEqual(["first", "change course"]);
    expect(a.prompt()).toBe("");
  });

  it("connection killed by the Stop deadline: the steer returns to the composer, not the cancelled turn's text, and never fires later", async () => {
    const calls = controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("change course");
    await a.steer();
    await tick();
    // The cancel was sent, but the agent never ended the turn, so the backend killed the connection.
    mocks.emit({ kind: "status", state: "disconnected", message: "Agent stopped responding to cancel" });
    calls[0].reject(new Error("The agent connection closed"));
    await tick();
    expect(a.prompt()).toBe("change course");
    expect(a.queue()).toEqual([]);
    expect(sent()).toEqual(["first"]);
    await reconnectWith(a);
    a.setPrompt("unrelated");
    await a.send();
    mocks.emit({ kind: "complete", sessionId: "s2", stopReason: "end_turn" });
    calls[1].resolve();
    await tick();
    expect(sent()).toEqual(["first", "unrelated"]);
  });

  it("JSON-RPC error on the cancelled prompt: the steer is restored and a later unrelated turn does not send it", async () => {
    const calls = controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("change course");
    await a.steer();
    await tick();
    calls[0].reject(new Error("JSON-RPC error -32603: Internal error"));
    await tick();
    expect(a.running()).toBe(false);
    expect(a.prompt()).toBe("change course");
    expect(sent()).toEqual(["first"]);
    a.setPrompt("next");
    await a.send();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    calls[1].resolve();
    await tick();
    expect(sent()).toEqual(["first", "next"]);
  });

  it("an error event while steering puts the steer at the front of the queue when the composer holds a draft", async () => {
    controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("queued");
    await a.send();
    a.setPrompt("change course");
    await a.steer();
    await tick();
    a.setPrompt("my draft");
    mocks.emit({ kind: "error", message: "session/prompt failed" });
    await tick();
    expect(a.prompt()).toBe("my draft");
    expect(a.queue().map((entry) => entry.text)).toEqual(["change course", "queued"]);
    expect(sent()).toEqual(["first"]);
  });

  it("a message sent after the steered turn ended but before the cancel resolved waits behind the steer", async () => {
    const calls = controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    const cancel = deferred();
    mocks.api.agentCancel.mockImplementationOnce(() => cancel.promise);
    a.setPrompt("change course");
    await a.steer();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    calls[0].resolve();
    await tick();
    a.setPrompt("other");
    await a.send();
    cancel.resolve();
    await tick();
    expect(sent()).toEqual(["first", "change course"]);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    calls[1].resolve();
    await tick();
    expect(sent()).toEqual(["first", "change course", "other"]);
  });
});

describe("queued messages after errors and reconnects", () => {
  it("does not auto-send after an error, keeps the queue visible and sends it on Send queued", async () => {
    const calls = controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("second");
    await a.send();
    mocks.emit({ kind: "error", message: "rate limited" });
    calls[0].reject(new Error("rate limited"));
    await tick();
    expect(a.running()).toBe(false);
    expect(sent()).toEqual(["first"]);
    expect(a.queue().map((entry) => entry.text)).toEqual(["second"]);
    expect(a.queueHeld()).toBe(true);
    a.sendQueued();
    await tick();
    expect(sent()).toEqual(["first", "second"]);
    expect(a.queue()).toEqual([]);
    expect(a.queueHeld()).toBe(false);
  });

  it("keeps queued messages across a reconnect and a new chat, held until the user sends them", async () => {
    controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("second");
    await a.send();
    mocks.emit({ kind: "status", state: "disconnected", message: "exited" });
    await tick();
    await reconnectWith(a);
    expect(a.connected()).toBe(true);
    expect(a.queue().map((entry) => entry.text)).toEqual(["second"]);
    await a.newChat();
    expect(a.queue().map((entry) => entry.text)).toEqual(["second"]);
    expect(a.queueHeld()).toBe(true);
    expect(sent()).toEqual(["first"]);
  });

  it("separates new text from the attachments when an attachment-only queued message is edited", async () => {
    controllablePrompts();
    const a = await connected();
    a.setPrompt("first");
    await a.send();
    await a.intake.addFiles([file("notes.md", "text/markdown", "# hi")], "picked");
    await a.send();
    const entry = a.queue()[0];
    expect(entry.text).toBe("");
    a.editQueued(entry.id, "look at this");
    expect(a.queue()[0].text).toBe("look at this");
    expect(a.queue()[0].message).toBe(`look at this\n\n${entry.message}`);
  });
});

describe("follow mode and delegated children", () => {
  it("follows only tool calls of the current session, not a delegated child's", async () => {
    const onOpenFile = vi.fn();
    const a = await connected(features(), { onOpenFile });
    a.toggleFollow();
    mocks.emit({ ...tool("c1", [{ path: "/w/child.ts", line: 3 }]), sessionId: "child-1" } as AgentEvent);
    expect(onOpenFile).not.toHaveBeenCalled();
    mocks.emit(tool("l1", [{ path: "/w/lead.ts", line: 4 }]));
    expect(onOpenFile).toHaveBeenCalledWith("lead.ts", 4);
  });
});

describe("saving attachments with names other systems reject", () => {
  it("sanitises every character core rejects, and shows the name the file was saved under", async () => {
    mocks.api.saveAttachment.mockImplementation(async (_dir: string, name: string) => ({ path: `assets/${name}`, size: 2, renamed: false }));
    const a = setup();
    await a.intake.addFiles([file("a?b*c.png", "image/png", new Uint8Array([1, 2]))], "pasted");
    await a.saveAttachment(a.attachments()[0]);
    expect(mocks.api.saveAttachment).toHaveBeenLastCalledWith("assets", "a-b-c.png", expect.any(String));
    expect(a.attachments()[0].name).toBe("a-b-c.png");
  });
});
