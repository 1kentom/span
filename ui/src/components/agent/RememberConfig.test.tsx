// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { readLastConfig, writeLastConfig } from "../../lib/last-config";
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
      agentNewSession: vi.fn(),
      agentResumeSession: vi.fn(async (id: string) => id),
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]): Promise<unknown> => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      openBuffer: vi.fn(),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async (): Promise<unknown[]> => []),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentSetPermissionMode: vi.fn(async (_mode: string) => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const choices = (values: string[]) => [{ name: "", choices: values.map((value) => ({ value, name: value, description: null })) }];
const model = (current: string) => ({ id: "model", name: "Model", description: null, category: "model", currentValue: current, groups: choices(["gpt", "luna"]) });
const configEvent = (session: string, current = "gpt") => ({ kind: "config", sessionId: session, options: [model(current)] }) as unknown as AgentEvent;
const opened = (session: string) => ({ kind: "session", sessionId: session }) as AgentEvent;

function start(): AgentController {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  return a;
}
/** Connects codex so a session with a model option is ready. */
async function connected(a: AgentController) {
  await tick();
  a.connectInstalled("codex");
  await tick();
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentConnect.mockImplementation(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, opened("s1"), configEvent("s1"));
    return "s1";
  });
  mocks.api.agentNewSession.mockReset();
  mocks.api.agentNewSession.mockImplementation(async () => {
    mocks.emit(opened("s2"), configEvent("s2"));
    return "s2";
  });
  mocks.api.agentResumeSession.mockClear();
  mocks.api.agentPrompt.mockReset();
  mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
  mocks.api.agentSetConfig.mockReset();
  mocks.api.agentSetConfig.mockImplementation(async () => undefined);
  mocks.api.agentInstalled.mockResolvedValue([{ id: "codex", version: "1", launch: { command: "codex", args: ["acp"], env: {} } }]);
});

describe("remembered config", () => {
  it("applies the saved model once when a fresh session of that agent starts", async () => {
    writeLastConfig("codex", "model", "luna");
    await connected(start());
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });

  it("applies it again to a new chat", async () => {
    const a = start();
    await connected(a);
    writeLastConfig("codex", "model", "luna");
    await a.newChat();
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });

  it("leaves a resumed session alone", async () => {
    const a = start();
    await connected(a);
    writeLastConfig("codex", "model", "luna");
    mocks.api.agentResumeSession.mockImplementationOnce(async (id: string) => {
      mocks.emit(opened(id), configEvent(id));
      return id;
    });
    await a.resumeChat("old");
    await tick();
    expect(mocks.api.agentResumeSession).toHaveBeenCalled();
    expect(mocks.api.agentSetConfig).not.toHaveBeenCalled();
  });

  it("saves a user change only after the agent accepted it", async () => {
    const a = start();
    await connected(a);
    await a.setConfig("model", "luna");
    expect(readLastConfig("codex")).toEqual({ model: "luna" });
    mocks.api.agentSetConfig.mockRejectedValueOnce(new Error("no"));
    await a.setConfig("model", "gpt");
    expect(readLastConfig("codex")).toEqual({ model: "luna" });
  });

  it("does not save changes the agent makes itself", async () => {
    const a = start();
    await connected(a);
    mocks.emit(configEvent("s1", "luna"));
    await tick();
    expect(readLastConfig("codex")).toEqual({});
  });

  it("stays silent when restoring fails", async () => {
    mocks.api.agentSetConfig.mockRejectedValue(new Error("refused"));
    writeLastConfig("codex", "model", "luna");
    const a = start();
    await connected(a);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(a.state().failure).toBeUndefined();
    expect(a.state().status).toBe("ready");
  });

  // Owner decision kept (remembered config restores everything, bypass modes too): since ADR 0015 it comes back as
  // the Span mode Full, set through the permission mode command, never through the raw mode option.
  it("restores a remembered mode that skips approval", async () => {
    writeLastConfig("codex", "mode", "agent-full-access");
    mocks.api.agentSetPermissionMode.mockClear();
    mocks.api.agentConnect.mockImplementation(async () => {
      const mode = { id: "mode", name: "Mode", description: null, category: "mode", currentValue: "agent", groups: choices(["agent", "agent-full-access"]) };
      mocks.emit(
        { kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] },
        opened("s1"),
        { kind: "config", sessionId: "s1", options: [mode] } as unknown as AgentEvent,
        { kind: "permissionMode", sessionId: "s1", mode: "ask", supported: ["ask", "acceptEdits", "plan", "auto", "full"], child: false, managed: ["mode"] },
      );
      return "s1";
    });
    await connected(start());
    await tick();
    expect(mocks.api.agentSetPermissionMode).toHaveBeenCalledWith("full");
    expect(mocks.api.agentSetConfig).not.toHaveBeenCalledWith("mode", "agent-full-access");
  });

  it("starts a new thread in the Span mode this agent last ran in", async () => {
    writeLastConfig("codex", "span.permissionMode", "plan");
    mocks.api.agentSetPermissionMode.mockClear();
    mocks.api.agentConnect.mockImplementation(async () => {
      mocks.emit(
        { kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] },
        opened("s1"),
        { kind: "permissionMode", sessionId: "s1", mode: "ask", supported: ["ask", "acceptEdits", "plan", "auto", "full"], child: false, managed: ["mode"] },
      );
      return "s1";
    });
    await connected(start());
    await tick();
    expect(mocks.api.agentSetPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("stores nothing for an agent without a known id", async () => {
    const a = start();
    await tick();
    mocks.api.agentInstalled.mockResolvedValue([]);
    a.connectCustom("mycli --acp");
    await tick();
    await a.setConfig("model", "luna");
    expect(window.localStorage.getItem("span.agent.lastConfig")).toBeNull();
  });

  it("applies the remembered options when a chat with messages switches agent", async () => {
    mocks.api.agentInstalled.mockResolvedValue([
      { id: "codex", version: "1", launch: { command: "codex", args: ["acp"], env: {} } },
      { id: "opencode", version: "1", launch: { command: "opencode", args: ["acp"], env: {} } },
    ]);
    const a = start();
    await connected(a);
    mocks.emit({ kind: "user", sessionId: "s1", text: "earlier ask" } as AgentEvent, { kind: "text", sessionId: "s1", text: "earlier answer" } as AgentEvent);
    await tick();
    writeLastConfig("opencode", "model", "luna");
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "opencode", agentTitle: "OpenCode", agentVersion: "1", features, authMethods: [] }, opened("s3"), configEvent("s3"));
      return "s3";
    });
    a.connectInstalled("opencode");
    await tick();
    expect(a.feed().some((item) => item.kind === "user")).toBe(true);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });

  it("lets a change the user makes during the restore win and holds sending until it settles", async () => {
    writeLastConfig("codex", "model", "luna");
    writeLastConfig("codex", "effort", "high");
    let release!: () => void;
    mocks.api.agentSetConfig.mockImplementationOnce(() => new Promise<undefined>((resolve) => (release = () => resolve(undefined))));
    mocks.api.agentConnect.mockImplementation(async () => {
      const effort = { id: "effort", name: "Effort", description: null, category: "thought_level", currentValue: "low", groups: choices(["low", "medium", "high"]) };
      mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, opened("s1"), { kind: "config", sessionId: "s1", options: [model("gpt"), effort] } as unknown as AgentEvent);
      return "s1";
    });
    const a = start();
    await connected(a);
    expect(mocks.api.agentSetConfig).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentSetConfig).toHaveBeenLastCalledWith("model", "luna");
    a.setPrompt("hello");
    expect(a.canSend()).toBe(false);
    const picked = a.setConfig("effort", "medium");
    release();
    await picked;
    await tick();
    expect(mocks.api.agentSetConfig.mock.calls).toEqual([["model", "luna"], ["effort", "medium"]]);
    expect(readLastConfig("codex").effort).toBe("medium");
    expect(a.canSend()).toBe(true);
  });
});

describe("edit, resend and fork keep the source session's options", () => {
  /** Codex in s1 on the luna model (the agent's own change, so nothing is remembered) with one sent turn. */
  async function sentTurn(a: AgentController) {
    await connected(a);
    mocks.emit(configEvent("s1", "luna"));
    await tick();
    mocks.api.agentPrompt.mockImplementationOnce(async () => undefined);
    a.setPrompt("ask");
    a.intake.addPastedText("pasted line\n".repeat(40));
    a.send();
    await tick();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" } as unknown as AgentEvent);
    await tick();
    mocks.api.agentSetConfig.mockClear();
  }
  const userId = (a: AgentController) => a.feed().find((item) => item.kind === "user")!.id;

  it("resends with the attachments and on the source model, set before the prompt goes out", async () => {
    const a = start();
    await sentTurn(a);
    const [, firstAttachments] = mocks.api.agentPrompt.mock.calls[0];
    expect(firstAttachments).toHaveLength(1);
    a.resendFrom(userId(a));
    await tick();
    await tick();
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    const [resent, resentAttachments] = mocks.api.agentPrompt.mock.calls[1];
    expect(resent.endsWith("ask")).toBe(true);
    expect(resentAttachments).toEqual(firstAttachments);
    expect(mocks.api.agentSetConfig.mock.invocationCallOrder[0]).toBeLessThan(mocks.api.agentPrompt.mock.invocationCallOrder[1]);
  });

  it("edits on the source model", async () => {
    const a = start();
    await sentTurn(a);
    a.editFrom(userId(a));
    a.setPrompt("ask again");
    a.send();
    await tick();
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
    expect(mocks.api.agentSetConfig.mock.invocationCallOrder[0]).toBeLessThan(mocks.api.agentPrompt.mock.invocationCallOrder[1]);
  });

  it("forks on the source model", async () => {
    const a = start();
    await sentTurn(a);
    a.forkFrom(userId(a));
    await tick();
    await tick();
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "luna");
  });
});

