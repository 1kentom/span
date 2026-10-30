// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures, AgentKeyedEvent_Serialize as AgentKeyedEvent } from "../../bindings";
import { mount } from "../../components/agent/test-utils";
import { createAgentController, type AgentController } from "../agent-controller";
import { reduceBackground, type ChatSnapshot } from "../agent-chats";
import { initialAgentState } from "../agent-session";
import { replayThread } from "./thread-events";
import { initialThreadState } from "./thread-state";

/**
 * Table-driven equivalence (ADR 0011 phase 2): recorded event sequences replayed into the thread reducer give the
 * same conversation as the sidebar controller's own event path, and as the background chat path of agent-chats.ts.
 */

const mocks = vi.hoisted(() => {
  const listeners: ((event: unknown) => void)[] = [];
  return {
    listeners,
    emit: (...events: unknown[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      agentInstalled: vi.fn(async () => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(async () => undefined),
      agentCancel: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    agentDelegationStatus: vi.fn(async (): Promise<unknown> => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] })),
  };
});
vi.mock("../client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentDelegationStatus: mocks.agentDelegationStatus, agentChildPermission: vi.fn(), agentSessions: {} }));

const features = (patch: Partial<AgentFeatures> = {}): AgentFeatures => ({ loadSession: false, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const KEY = { connectionId: "c1", sessionId: "s1" };
/** Events the backend sends without a session key (bindings.ts, `AgentKeyedEvent`). */
const CONNECTION_KINDS = new Set(["ready", "status", "log", "capabilities", "authRequired", "elicitationComplete"]);

/** The adapter fixtures list events as partial matchers. Fills the fields the reducers read, all on session s1. */
function complete(raw: Record<string, unknown>[]): AgentEvent[] {
  let request = 0;
  return raw.filter((event) => event.kind !== "_step").map((event) => {
    const base = { ...event, sessionId: "s1" } as Record<string, unknown>;
    switch (event.kind) {
      case "text":
      case "thought":
      case "user":
        return { text: "", ...base } as unknown as AgentEvent;
      case "notice":
        return { severity: "info", title: "", description: null, ...base } as unknown as AgentEvent;
      case "tool":
        return { toolCallId: "t0", title: null, status: null, toolKind: null, parentToolCallId: null, contentJson: "{}", ...base } as unknown as AgentEvent;
      case "permission":
        return { toolCallId: "t0", title: "", options: [], ...base, requestId: `r${++request}` } as unknown as AgentEvent;
      case "permissionResolved":
        return { ...base, requestId: `r${request}` } as unknown as AgentEvent;
      case "complete":
        return { usage: null, ...base } as unknown as AgentEvent;
      case "config":
        return { ...base, options: [] } as unknown as AgentEvent;
      case "ready":
        return { agentName: "a", agentTitle: "Agent", agentVersion: "1", authMethods: [], ...base, features: features() } as unknown as AgentEvent;
      case "authRequired":
        return { message: "", authMethods: [], ...base } as unknown as AgentEvent;
      case "error":
        return { message: "failed", ...base } as unknown as AgentEvent;
      default:
        return base as unknown as AgentEvent;
    }
  });
}

const fixtureRoot = join(import.meta.dirname, "../../../../crates/acp/tests/fixtures");
const recorded = readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((agent) => readdirSync(join(fixtureRoot, agent.name)).filter((name) => name.endsWith(".json")).map((name) => {
    const fixture = JSON.parse(readFileSync(join(fixtureRoot, agent.name, name), "utf8")) as { events?: Record<string, unknown>[] };
    return { name: `${agent.name}/${name.replace(/\.json$/, "")}`, events: complete(fixture.events ?? []) };
  }))
  .filter((entry) => entry.events.length);

const tool = (id: string, patch: Record<string, unknown> = {}) => ({ kind: "tool", sessionId: "s1", toolCallId: id, title: "Read", status: "pending", toolKind: "read", parentToolCallId: null, contentJson: "{}", ...patch }) as unknown as AgentEvent;
/** Hand-recorded sequences from the sidebar tests: streaming reveal, permission hold, delegation, stop reasons. */
const sequences: { name: string; events: AgentEvent[] }[] = [
  ...recorded,
  {
    name: "streaming text, thoughts and message ids",
    events: [
      { kind: "thought", sessionId: "s1", text: "think" },
      { kind: "thought", sessionId: "s1", text: " more" },
      { kind: "text", sessionId: "s1", text: "Hel", messageId: "m1" },
      { kind: "text", sessionId: "s1", text: "lo", messageId: "m1" },
      { kind: "text", sessionId: "s1", text: "Next", messageId: "m2" },
      { kind: "complete", sessionId: "s1", stopReason: "end_turn", usage: { totalTokens: 12 } },
    ] as AgentEvent[],
  },
  {
    name: "a tool held while its permission is open, then released",
    events: [
      tool("t1"),
      { kind: "permission", sessionId: "s1", requestId: "r1", toolCallId: "t1", title: "Edit", options: [] },
      tool("t1", { status: "in_progress" }),
      { kind: "permissionResolved", sessionId: "s1", requestId: "r1" },
      tool("t1", { status: "completed" }),
      { kind: "plan", sessionId: "s1", entries: [{ content: "step", priority: "high", status: "pending" }] },
      { kind: "usage", sessionId: "s1", used: 10, size: 100, costAmount: null, costCurrency: null },
      { kind: "complete", sessionId: "s1", stopReason: "max_tokens", usage: null },
    ] as AgentEvent[],
  },
  {
    name: "delegation cards and a child's permission",
    events: [
      { kind: "delegation", sessionId: "s1", event: { kind: "delegated", lead: KEY, taskId: "k1", child: { connectionId: "c1", sessionId: "child" }, agentName: "Helper" } },
      { kind: "permission", sessionId: "child", requestId: "cr1", toolCallId: "x", title: "Run", options: [] },
      { kind: "delegation", sessionId: "s1", event: { kind: "taskFinished", lead: KEY, taskId: "k1", child: { connectionId: "c1", sessionId: "child" }, status: "completed", reason: null } },
      { kind: "elicitation", sessionId: "s1", requestId: "e1", mode: "url", message: "Sign in", url: "https://example.com/login", schemaJson: null },
      { kind: "elicitationResolved", sessionId: "s1", requestId: "e1" },
      { kind: "complete", sessionId: "s1", stopReason: "cancelled", usage: null },
    ] as AgentEvent[],
  },
];

/** The keyed form of an event, as the backend's `AgentKeyedEvent` stream carries it. */
const keyedOf = (event: AgentEvent): AgentKeyedEvent => {
  const session = (event as { sessionId?: string }).sessionId;
  return { connectionId: "c1", agentName: "Agent", key: CONNECTION_KINDS.has(event.kind) ? null : { connectionId: "c1", sessionId: session ?? "s1" }, event } as AgentKeyedEvent;
};

async function controllerAfter(events: AgentEvent[]): Promise<AgentController> {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return null;
  });
  await tick();
  controller.connectCustom("agent --acp");
  await tick();
  mocks.emit(...events);
  return controller;
}

/** Replayed attachment chips take ids from one module counter, so two replays number them differently. */
const sameIds = <T,>(feed: T): T => JSON.parse(JSON.stringify(feed).replace(/"replay-\d+"/g, '"replay"'));
const conversationOf = (state: ReturnType<AgentController["state"]>) => ({
  feed: sameIds(state.feed),
  running: state.running,
  stopRequested: state.stopRequested,
  plan: state.plan,
  usage: state.usage,
  turnUsage: state.turnUsage,
  elicitations: state.elicitations,
  strayPermissions: state.strayPermissions,
  childRequests: state.childRequests,
  commands: state.commands,
  sessionTitle: state.sessionTitle,
  failure: state.failure,
  nextId: state.nextId,
});

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
});

describe("thread reducer replay", () => {
  it("has recorded sequences to replay", () => {
    expect(recorded.length).toBeGreaterThan(10);
  });

  it.each(sequences.map((entry) => [entry.name, entry.events] as const))("%s: same conversation as the sidebar controller path", async (_name, events) => {
    const controller = await controllerAfter(events);
    // The thread starts where the controller's connect left it: a ready session s1 with the agent's identity.
    const start = replayThread(initialThreadState(KEY), [keyedOf({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] } as AgentEvent)]).state;
    const thread = replayThread(start, events.map(keyedOf)).state;
    expect(conversationOf(thread.conversation)).toEqual(conversationOf(controller.state()));
  });

  it.each(sequences.map((entry) => [entry.name, entry.events] as const))("%s: same feed as the background chat path", (_name, events) => {
    const own = events.filter((event) => (event as { sessionId?: string }).sessionId === "s1" || CONNECTION_KINDS.has(event.kind));
    const chat: ChatSnapshot = { conversation: { ...initialAgentState(true), sessionId: "s1", status: "ready" }, draft: "", attachments: [], queue: [], queueHeld: false, pinned: true, turnStart: 0, touchedAt: 0 };
    const background = own.reduce(reduceBackground, chat).conversation;
    const thread = replayThread(initialThreadState(KEY), own.map(keyedOf)).state.conversation;
    expect(sameIds(thread.feed)).toEqual(sameIds(background.feed));
    expect(thread.running).toBe(background.running);
  });
});
