// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { readLastConfig } from "../../lib/last-config";
import { mount } from "./test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async (): Promise<unknown[]> => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]): Promise<unknown> => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentNewSession: vi.fn(),
      agentResumeSession: vi.fn(),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
      openBuffer: vi.fn(),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
const model = { id: "model", name: "Model", description: null, category: "model", currentValue: "a", groups: [{ name: "", choices: [{ value: "a", name: "A", description: null }, { value: "b", name: "B", description: null }] }] };
const authRequired = { kind: "authRequired", message: "Authentication required", authMethods: [], hint: "runOpencodeAuthLogin" } as unknown as AgentEvent;
const complete = (session: string) => ({ kind: "complete", sessionId: session, stopReason: "end_turn" }) as unknown as AgentEvent;
const userItems = (a: AgentController) => a.feed().filter((item) => item.kind === "user");
/** The next agentConnect starts `title` and opens `session` with a model option. */
const willConnect = (title: string, session: string) =>
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit(
      { kind: "ready", agentName: title.toLowerCase(), agentTitle: title, agentVersion: "1", features, authMethods: [] },
      { kind: "session", sessionId: session } as AgentEvent,
      { kind: "config", sessionId: session, options: [model] } as unknown as AgentEvent,
    );
    return session;
  });
/** The next prompt is refused the way the backend refuses it: authRequired first, then the rejected call. */
const willRefuse = () =>
  mocks.api.agentPrompt.mockImplementationOnce(async () => {
    mocks.emit(authRequired);
    throw { kind: "failed", message: "Authentication required" };
  });

function start(): AgentController {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  return a;
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockReset();
  mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
  mocks.api.agentSetConfig.mockClear();
  mocks.api.agentResumeSession.mockReset();
  mocks.api.agentInstalled.mockResolvedValue([agent("opencode"), agent("codex")]);
});

describe("retry with another model after a refused prompt", () => {
  it("does not offer a resend when the sign-in card comes from a failed resume", async () => {
    const a = start();
    await tick();
    willConnect("OpenCode", "s1");
    a.connectInstalled("opencode");
    await tick();
    mocks.api.agentPrompt.mockImplementationOnce(async () => undefined);
    a.setPrompt("answered already");
    a.send();
    await tick();
    mocks.emit(complete("s1"));
    await tick();
    mocks.api.agentResumeSession.mockImplementationOnce(async () => {
      mocks.emit(authRequired);
      throw new Error("Authentication required");
    });
    await a.resumeChat("old");
    await tick();
    expect(a.state().auth).toBeDefined();
    expect(a.canRetryModel()).toBe(false);
    await a.retryWithModel("b");
    await tick();
    expect(mocks.api.agentSetConfig).not.toHaveBeenCalled();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
  });

  it("resends the refused turn with its attachments and carried context exactly once", async () => {
    const a = start();
    await tick();
    willConnect("OpenCode", "s1");
    a.connectInstalled("opencode");
    await tick();
    mocks.emit({ kind: "user", sessionId: "s1", text: "earlier ask" } as AgentEvent, { kind: "text", sessionId: "s1", text: "earlier answer" } as AgentEvent);
    await tick();
    willConnect("Codex", "s2");
    a.connectInstalled("codex");
    await tick();
    expect(a.state().sessionId).toBe("s2");

    willRefuse();
    a.setPrompt("hello there");
    a.intake.addPastedText("pasted line\n".repeat(40));
    expect(a.attachments()).toHaveLength(1);
    a.send();
    await tick();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    const [firstMessage, firstAttachments] = mocks.api.agentPrompt.mock.calls[0];
    expect(firstMessage).toContain("earlier answer");
    expect(firstAttachments).toHaveLength(1);
    // The failure gives the text back to the composer and the card offers the other model for this turn only.
    expect(a.prompt()).toBe("hello there");
    expect(a.canRetryModel()).toBe(true);

    await a.retryWithModel("b");
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "b");
    expect(a.state().auth).toBeUndefined();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    const [secondMessage, secondAttachments] = mocks.api.agentPrompt.mock.calls[1];
    expect(secondMessage).toBe(firstMessage);
    expect(secondAttachments).toEqual(firstAttachments);
    expect(a.prompt()).toBe("");
    expect(a.attachments()).toHaveLength(0);
    expect(userItems(a).filter((item) => item.kind === "user" && item.text === "hello there")).toHaveLength(1);
    expect(a.canRetryModel()).toBe(false);

    mocks.emit(complete("s2"));
    await tick();
    a.setPrompt("next");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt.mock.calls[2][0]).toBe("next");
  });

  it("remembers the model picked on the card", async () => {
    const a = start();
    await tick();
    willConnect("OpenCode", "s1");
    a.connectInstalled("opencode");
    await tick();
    willRefuse();
    a.setPrompt("hello");
    a.send();
    await tick();
    await tick();
    await a.retryWithModel("b");
    expect(readLastConfig("opencode")).toEqual({ model: "b" });
  });

  it("forgets the refused turn when a new chat starts", async () => {
    const a = start();
    await tick();
    willConnect("OpenCode", "s1");
    a.connectInstalled("opencode");
    await tick();
    willRefuse();
    a.setPrompt("hello");
    a.send();
    await tick();
    await tick();
    expect(a.canRetryModel()).toBe(true);
    mocks.api.agentNewSession.mockImplementationOnce(async () => "s9");
    await a.newChat();
    await tick();
    expect(a.canRetryModel()).toBe(false);
  });
});
