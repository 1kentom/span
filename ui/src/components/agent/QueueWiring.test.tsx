// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController, type AgentPanelProps } from "../../lib/agent-controller";
import { AgentComposer } from "./AgentComposer";
import { AgentFeed } from "./AgentFeed";
import { key, mount, text } from "./test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async () => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn(() => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentPermission: vi.fn(async (..._args: unknown[]) => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async () => []),
    agentAuthenticateWith: vi.fn(async () => "s-auth"),
    agentChildPermission: vi.fn(async (..._args: unknown[]) => undefined),
    agentCancelTask: vi.fn(async (..._args: unknown[]) => undefined),
    agentDelegationStatus: vi.fn(async () => ({ enabled: true, available: true, reason: null, lead: null, attached: true, tasks: [], decisions: [] })),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: mocks.agentAuthenticateWith, agentChildPermission: mocks.agentChildPermission, agentCancelTask: mocks.agentCancelTask, agentDelegationStatus: mocks.agentDelegationStatus }));

const features = (): AgentFeatures => ({ loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(props: Partial<AgentPanelProps> = {}) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: features(), authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1, ...props });
    return (
      <>
        <AgentFeed agent={controller} />
        <AgentComposer agent={controller} brand={{ id: "a", name: "Agent" }} label="Agent" />
      </>
    );
  });
  await tick();
  controller.connectCustom("agent");
  await tick();
  return { a: controller, host };
}
async function queued(a: AgentController, ...messages: string[]) {
  a.setPrompt("running");
  await a.send();
  for (const message of messages) {
    a.setPrompt(message);
    await a.send();
  }
}

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentCancel.mockClear();
  mocks.api.agentPrompt.mockClear();
});

describe("reorderQueue", () => {
  it("moves a message and keeps every id and text", async () => {
    const { a } = await setup();
    await queued(a, "one", "two", "three");
    const before = a.queue();
    a.reorderQueue(0, 2);
    expect(a.queue().map((entry) => entry.text)).toEqual(["two", "three", "one"]);
    expect(a.queue().map((entry) => entry.id)).toEqual([before[1].id, before[2].id, before[0].id]);
    expect(a.queue()[2]).toBe(before[0]);
    a.reorderQueue(2, 2);
    a.reorderQueue(-1, 1);
    a.reorderQueue(0, 9);
    expect(a.queue().map((entry) => entry.text)).toEqual(["two", "three", "one"]);
  });
  it("sends in the new order when the turn ends", async () => {
    const { a } = await setup();
    await queued(a, "one", "two");
    a.reorderQueue(1, 0);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenLastCalledWith("two\n\none", []);
  });
  it("is ignored while a message is being sent now", async () => {
    const { a } = await setup();
    await queued(a, "one", "two", "three");
    a.sendQueuedNow(a.queue()[2].id);
    await tick();
    expect(a.queueSending()).toBe(a.queue()[2].id);
    a.reorderQueue(0, 1);
    expect(a.queue().map((entry) => entry.text)).toEqual(["one", "two", "three"]);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    expect(a.queueSending()).toBeUndefined();
    expect(a.queue().map((entry) => entry.text)).toEqual(["one", "two"]);
  });
});

describe("queue in the composer", () => {
  it("shows the design header and reorders from the keyboard end to end", async () => {
    const { a, host } = await setup();
    await queued(a, "one", "two");
    expect(text(host.querySelector(".sb-queue-head"))).toContain("Queued · 2");
    expect(text(host.querySelector(".sb-queue-head"))).toContain("Sends when the agent finishes");
    key("ArrowDown", { altKey: true }, host.querySelector("[aria-label^='Reorder queued message 1']")!);
    expect(a.queue().map((entry) => entry.text)).toEqual(["two", "one"]);
    expect(text(host.querySelector(".sb-visually-hidden[aria-live='polite']"))).toBe("Moved to position 2 of 2");
  });
  it("ArrowUp in an empty composer edits the last queued message", async () => {
    const { a, host } = await setup();
    await queued(a, "one", "two");
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    key("ArrowUp", {}, area);
    await tick();
    expect(host.querySelector<HTMLInputElement>(".sb-queue input")!.value).toBe("two");
  });
  it("ArrowUp still recalls earlier prompts when nothing is queued, and not over a typed draft", async () => {
    const { a, host } = await setup();
    a.setPrompt("earlier");
    await a.send();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" });
    await tick();
    const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
    key("ArrowUp", {}, area);
    expect(a.prompt()).toBe("earlier");
    expect(host.querySelector(".sb-queue input")).toBeNull();
  });
});

describe("feed tags", () => {
  it("tags a steered message with Steered and what it means", async () => {
    const { a, host } = await setup();
    a.setPrompt("first");
    await a.send();
    a.setPrompt("change course");
    void a.steer();
    await tick();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    const tag = host.querySelector(".agent-steer-tag")!;
    expect(text(tag)).toBe("Steered · read after the current step");
    expect(tag.querySelector(".icon")).not.toBeNull();
    expect(tag.closest(".agent-message")!.textContent).toContain("change course");
  });
  it("tags a message sent with Send now", async () => {
    const { a, host } = await setup();
    await queued(a, "later", "urgent");
    a.sendQueuedNow(a.queue()[1].id);
    await tick();
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "cancelled" });
    await tick();
    const tag = host.querySelector(".agent-steer-tag")!;
    expect(text(tag)).toBe("Sent now · interrupted the current step");
    expect(tag.closest(".agent-message")!.textContent).toContain("urgent");
    expect(host.querySelectorAll(".agent-steer-tag")).toHaveLength(1);
  });
});
