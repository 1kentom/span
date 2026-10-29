// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { AgentFeed } from "./AgentFeed";
import { mount, text } from "./test-utils";

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
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]) => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
      agentSessionStates: vi.fn(async (): Promise<{ connectionId: string | null; sessions: unknown[] }> => ({ connectionId: "c1", sessions: [] })),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
/** The next agentConnect starts `title` and opens `session`. */
const willConnect = (title: string, session: string) =>
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: title.toLowerCase(), agentTitle: title, agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: session } as AgentEvent);
    return session;
  });

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockClear();
  mocks.api.agentDisconnect.mockClear();
  mocks.api.agentSetConfig.mockClear();
  mocks.api.agentSessionStates.mockReset();
  mocks.api.agentSessionStates.mockImplementation(async () => ({ connectionId: "c1", sessions: [] }));
  mocks.api.agentInstalled.mockResolvedValue([agent("codex"), agent("claude")]);
});

/** A controller connected to Codex in session s1 with one exchange and one edit in the feed, mounted with its feed. */
async function chatWithCodex() {
  let a!: AgentController;
  const host = mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <AgentFeed agent={a} />;
  });
  await tick();
  willConnect("Codex", "s1");
  a.connectInstalled("codex");
  await tick();
  mocks.emit(
    { kind: "user", sessionId: "s1", text: "rename the helper" } as AgentEvent,
    { kind: "text", sessionId: "s1", text: "Renamed it in src/util.ts" } as AgentEvent,
    { kind: "proposal", sessionId: "s1", proposal: { id: "p1", path: "/w/src/util.ts", hunks: [], baseRevision: 1 } } as unknown as AgentEvent,
  );
  await tick();
  return { a, host };
}

describe("switching agent in an open chat", () => {
  it("keeps the feed, marks the switch, and sends the carried context with the first prompt only", async () => {
    const { a, host } = await chatWithCodex();
    a.setPrompt("half written");
    willConnect("Claude", "s2");
    a.connectInstalled("claude");
    await tick();
    await tick();

    // agent_connect closes the old agent itself, only after the new one connected (issue #87).
    expect(mocks.api.agentDisconnect).not.toHaveBeenCalled();
    expect(a.state().sessionId).toBe("s2");
    expect(a.prompt()).toBe("half written");
    const kinds = a.feed().map((item) => item.kind);
    expect(kinds.slice(0, 2)).toEqual(["user", "text"]);
    expect(kinds[kinds.length - 1]).toBe("handoff");
    const divider = host.querySelector(".agent-handoff");
    expect(divider?.getAttribute("aria-label")).toBe("Switched from Codex to claude. Context carried over: recent turns. Tool state, agent memory and permissions do not carry over; the new agent starts a new session.");
    expect(text(host)).toContain("rename the helper");

    a.setPrompt("now add a test");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    const first = mocks.api.agentPrompt.mock.calls[0][0];
    expect(first.startsWith("[Context from an earlier session with Codex.")).toBe(true);
    expect(first).toContain("User: rename the helper");
    expect(first).toContain("Agent: Renamed it in src/util.ts");
    expect(first).toContain("Files changed:\n- src/util.ts");
    expect(first.endsWith("\n\nnow add a test")).toBe(true);

    // The switch reads as the two agent avatars with a chevron between, one left-aligned line, limits in the tooltip.
    expect(divider?.querySelector(".agent-handoff-from")).not.toBeNull();
    expect(divider?.querySelector(".agent-handoff-to")).not.toBeNull();
    expect(text(divider?.querySelector(".agent-handoff-text"))).toBe("Switched to claude");
    expect(divider?.getAttribute("title")).toContain("do not carry over");
    // The carried context is sent but never drawn: the bubble shows only what the user typed.
    expect(host.querySelector(".agent-context-sent")).toBeNull();
    expect(host.querySelector(".agent-message.user pre")).toBeNull();
    const lastUser = a.feed().filter((item) => item.kind === "user").pop()!;
    expect(lastUser.kind === "user" && lastUser.text).toBe("now add a test");

    mocks.emit({ kind: "complete", sessionId: "s2", stopReason: "end_turn" } as unknown as AgentEvent);
    await tick();
    a.setPrompt("and run it");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toBe("and run it");
    expect(host.querySelector(".agent-context-sent")).toBeNull();
  });

  it("keeps the old feed, the draft and shows the error when the new agent fails to connect", async () => {
    const { a } = await chatWithCodex();
    const before = a.feed().map((item) => item.kind);
    a.setPrompt("keep me");
    mocks.api.agentConnect.mockRejectedValueOnce(new Error("claude: command not found"));
    a.connectInstalled("claude");
    await tick();
    await tick();

    expect(a.feed().map((item) => item.kind)).toEqual(before);
    expect(a.prompt()).toBe("keep me");
    expect(a.state().failure?.message).toBe("claude: command not found");
    expect(a.connecting()).toBeUndefined();
    expect(a.feed().some((item) => item.kind === "handoff")).toBe(false);
    // The backend kept the old connection, so the chat stays on it and can go on.
    expect(mocks.api.agentDisconnect).not.toHaveBeenCalled();
    expect(a.state().sessionId).toBe("s1");
    expect(a.agentName()).toBe("codex");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentPrompt.mock.calls[0][0]).toBe("keep me");
  });

  it("does not go back to the old session when the backend no longer holds its connection", async () => {
    const { a } = await chatWithCodex();
    mocks.api.agentSessionStates.mockImplementation(async () => ({ connectionId: null, sessions: [] }));
    mocks.api.agentConnect.mockRejectedValueOnce(new Error("claude: command not found"));
    a.connectInstalled("claude");
    await tick();
    await tick();

    expect(a.state().failure?.message).toBe("claude: command not found");
    expect(a.state().sessionId).toBeUndefined();
  });

  it("starts empty with no carried context when the chat had no messages", async () => {
    let a!: AgentController;
    mount(() => {
      a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return <AgentFeed agent={a} />;
    });
    await tick();
    willConnect("Codex", "s1");
    a.connectInstalled("codex");
    await tick();
    willConnect("Claude", "s2");
    a.connectInstalled("claude");
    await tick();
    await tick();
    expect(a.feed()).toEqual([]);
    a.setPrompt("hello");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt.mock.calls[0][0]).toBe("hello");
  });

  it("leaves a model change on the same session untouched", async () => {
    const { a } = await chatWithCodex();
    mocks.emit({ kind: "config", sessionId: "s1", options: [{ id: "model", name: "Model", category: "model", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] } as unknown as AgentEvent);
    await tick();
    await a.setConfig("model", "b");
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "b");
    expect(mocks.api.agentDisconnect).not.toHaveBeenCalled();
    expect(a.state().sessionId).toBe("s1");
    expect(a.feed().some((item) => item.kind === "handoff")).toBe(false);
  });
});
