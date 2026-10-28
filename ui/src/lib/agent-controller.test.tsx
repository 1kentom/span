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
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentElicitation: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      openExternal: vi.fn(async () => undefined),
      openBuffer: vi.fn(),
      saveAttachment: vi.fn(),
    },
  };
});
vi.mock("./client", () => ({ isDesktop: true, api: mocks.api }));

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
