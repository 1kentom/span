// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import type { FeedItem } from "../../lib/agent-session";
import { AgentFeed } from "./AgentFeed";
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
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]) => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentNewSession: vi.fn(async () => "s2"),
      agentReview: vi.fn(async (_id: string, _accept: boolean, _revision: number) => ({ path: "/w/src/b.ts", text: "", revision: 2 })),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
      openBuffer: vi.fn(),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const features: AgentFeatures = { loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
const userIds = (a: AgentController) => a.feed().flatMap((item) => (item.kind === "user" ? [item.id] : []));
const complete = (session: string) => ({ kind: "complete", sessionId: session, stopReason: "end_turn" }) as unknown as AgentEvent;
const proposal = (id: string, path: string) => ({ kind: "proposal", sessionId: "s1", proposal: { id, path, hunks: [], baseRevision: 1 } }) as unknown as AgentEvent;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockClear();
  mocks.api.agentNewSession.mockReset();
  mocks.api.agentNewSession.mockResolvedValue("s2");
  mocks.api.agentReview.mockClear();
  mocks.api.agentInstalled.mockResolvedValue([agent("codex")]);
});

/** Codex in session s1 with two exchanges. The second turn proposed b.ts; `review` decides what happened to it. */
async function twoTurns(review: "accepted" | "pending" = "accepted") {
  let a!: AgentController;
  const host = mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <AgentFeed agent={a} />;
  });
  await tick();
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" } as AgentEvent);
    return "s1";
  });
  a.connectInstalled("codex");
  await tick();
  mocks.emit(
    { kind: "user", sessionId: "s1", text: "first ask" } as AgentEvent,
    { kind: "text", sessionId: "s1", text: "first answer" } as AgentEvent,
    { kind: "user", sessionId: "s1", text: "second ask" } as AgentEvent,
    { kind: "text", sessionId: "s1", text: "second answer" } as AgentEvent,
    proposal("p1", "/w/src/b.ts"),
  );
  await tick();
  if (review === "accepted") {
    await a.review(a.state().feed.find((item): item is Extract<FeedItem, { kind: "proposal" }> => item.kind === "proposal")!.proposal, true);
    mocks.api.agentReview.mockClear();
  }
  return { a, host };
}

describe("editing an earlier message", () => {
  it("puts the text in the composer and, on send, starts a new session that carries only the turns before it", async () => {
    const { a } = await twoTurns();
    a.setPrompt("my draft");
    const [, second] = userIds(a);
    a.editFrom(second);
    expect(a.prompt()).toBe("second ask");
    expect(a.rewind()?.mode).toBe("edit");

    a.setPrompt("second ask, but shorter");
    a.send();
    await tick();
    await tick();

    expect(mocks.api.agentNewSession).toHaveBeenCalledTimes(1);
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    const sent = mocks.api.agentPrompt.mock.calls[0][0];
    expect(sent.startsWith("[Context from an earlier session with Codex. Span started a new session from an earlier message")).toBe(true);
    expect(sent).toContain("User: first ask");
    expect(sent).toContain("Agent: first answer");
    expect(sent).not.toContain("second answer");
    expect(sent.endsWith("\n\nsecond ask, but shorter")).toBe(true);

    expect(a.feed().map((item) => item.kind)).toEqual(["user", "text", "branch", "user"]);
    const last = a.feed()[3];
    expect(last.kind === "user" && last.text).toBe("second ask, but shorter");
    expect(last.kind === "user" && last.context).toBe(sent.slice(0, -"\n\nsecond ask, but shorter".length));
    expect(a.rewind()).toBeUndefined();
  });

  it("gives the earlier draft back on cancel and sends nothing", async () => {
    const { a } = await twoTurns();
    a.setPrompt("my draft");
    a.editFrom(userIds(a)[1]);
    a.cancelRewind();
    expect(a.prompt()).toBe("my draft");
    expect(a.rewind()).toBeUndefined();
    expect(mocks.api.agentNewSession).not.toHaveBeenCalled();
  });

  it("keeps the chat, the edited text and the edit mode when the new session cannot start", async () => {
    const { a } = await twoTurns();
    const before = a.feed().map((item) => item.kind);
    a.editFrom(userIds(a)[1]);
    a.setPrompt("try again");
    mocks.api.agentNewSession.mockRejectedValueOnce(new Error("no more sessions"));
    a.send();
    await tick();
    await tick();
    expect(a.state().sessionId).toBe("s1");
    expect(a.feed().map((item) => item.kind)).toEqual(before);
    expect(a.prompt()).toBe("try again");
    expect(a.rewind()?.mode).toBe("edit");
    expect(a.state().failure?.message).toContain("no more sessions");
    expect(mocks.api.agentPrompt).not.toHaveBeenCalled();
  });

  it("will not start a new session while an edit waits for review", async () => {
    const { a } = await twoTurns("pending");
    a.editFrom(userIds(a)[1]);
    expect(a.branchBlock()).toBe("1 edit waits for review. Accept or reject it before starting a new session.");
    expect(a.canSend()).toBe(false);
    a.send();
    await tick();
    expect(mocks.api.agentNewSession).not.toHaveBeenCalled();
  });
});

describe("resend and fork", () => {
  it("resends the message unchanged in a new session with the earlier turns as context", async () => {
    const { a } = await twoTurns();
    a.resendFrom(userIds(a)[1]);
    await tick();
    await tick();
    expect(mocks.api.agentNewSession).toHaveBeenCalledTimes(1);
    const sent = mocks.api.agentPrompt.mock.calls[0][0];
    expect(sent).toContain("User: first ask");
    expect(sent.endsWith("\n\nsecond ask")).toBe(true);
    const branch = a.feed().find((item) => item.kind === "branch");
    expect(branch?.kind === "branch" && branch.mode).toBe("resend");
  });

  it("forks after the message's turn, sends nothing yet, and carries that turn with the next prompt", async () => {
    const { a } = await twoTurns();
    a.setPrompt("keep typing");
    a.forkFrom(userIds(a)[0]);
    await tick();
    await tick();
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.api.agentPrompt).not.toHaveBeenCalled();
    expect(a.prompt()).toBe("keep typing");
    expect(a.feed().map((item) => item.kind)).toEqual(["user", "text", "branch"]);

    a.send();
    await tick();
    const sent = mocks.api.agentPrompt.mock.calls[0][0];
    expect(sent.startsWith("[Context from an earlier session with Codex. Span forked the chat into a new session")).toBe(true);
    expect(sent).toContain("Agent: first answer");
    expect(sent).not.toContain("second ask");
    expect(sent.endsWith("\n\nkeep typing")).toBe(true);

    mocks.emit(complete("s2"));
    await tick();
    a.setPrompt("next");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toBe("next");
  });
});

describe("restoring files to a message", () => {
  it("lists files changed after the message and reverts only edits still waiting for review", async () => {
    const { a } = await twoTurns("pending");
    mocks.emit(proposal("p2", "/w/src/c.ts"));
    await tick();
    await a.review(a.state().feed.flatMap((item) => (item.kind === "proposal" && item.proposal.id === "p2" ? [item.proposal] : []))[0], true);
    mocks.api.agentReview.mockClear();

    a.restoreTo(userIds(a)[1]);
    expect(a.rewind()?.mode).toBe("restore");
    expect(a.rewindFiles()).toEqual([
      { path: "/w/src/b.ts", label: "src/b.ts", pending: ["p1"], applied: false },
      { path: "/w/src/c.ts", label: "src/c.ts", pending: [], applied: true },
    ]);
    await a.revertFiles();
    expect(mocks.api.agentReview).toHaveBeenCalledTimes(1);
    expect(mocks.api.agentReview).toHaveBeenCalledWith("p1", false, 1);
    expect(mocks.api.agentNewSession).not.toHaveBeenCalled();
    expect(a.state().sessionId).toBe("s1");
    expect(a.feed().filter((item) => item.kind === "user")).toHaveLength(2);
  });

  it("keeps files by accepting the pending edits", async () => {
    const { a } = await twoTurns("pending");
    a.restoreTo(userIds(a)[0]);
    await a.keepFiles();
    expect(mocks.api.agentReview).toHaveBeenCalledWith("p1", true, 1);
    expect(a.rewind()).toBeUndefined();
  });
});
