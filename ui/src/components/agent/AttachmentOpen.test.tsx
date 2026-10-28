// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import type { Attachment } from "../../lib/attachments";
import type { AttachmentTabView } from "../attachments";
import { AgentFeed } from "./AgentFeed";
import { AgentComposer } from "./AgentComposer";
import { mount } from "./test-utils";
import AgentPanel from "../AgentPanel";

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
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentSetConfig: vi.fn(async () => undefined),
      writeClipboard: vi.fn(async () => undefined),
      saveAttachment: vi.fn(async (dir: string, fileName: string) => ({ path: `${dir}/${fileName}` })),
    },
  };
});
vi.mock("../../lib/client", () => ({
  isDesktop: true,
  api: mocks.api,
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => "s1"),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
}));

const features: AgentFeatures = { loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const png = (): File => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", { type: "image/png" });
const userEvent = { kind: "user", sessionId: "s1", text: "see this", attachments: [{ kind: "image", name: "chart.png", uri: null, mimeType: "image/png" }] } as AgentEvent;

beforeEach(() => {
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.saveAttachment.mockClear();
});

async function connect(a: AgentController) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  a.connectCustom("agent");
  await tick();
}

async function withAgent(view: (a: AgentController) => any) {
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return view(controller);
  });
  await tick();
  await connect(controller);
  return { a: controller, host };
}

describe("opening attachments", () => {
  it("opens the modal viewer from a feed chip when no workbench opener is registered", async () => {
    const { a, host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    mocks.emit(userEvent);
    await tick();
    (host.querySelector(".agent-message.user .att-chip-open, .agent-message.user .att-tile-open") as HTMLElement).click();
    expect(a.viewingItem()?.name).toBe("chart.png");
  });
  it("hands a feed chip to the registered opener instead of the modal", async () => {
    const { a, host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    const opened: Attachment[] = [];
    a.setAttachmentOpener((item) => opened.push(item));
    mocks.emit(userEvent);
    await tick();
    (host.querySelector(".agent-message.user .att-chip-open, .agent-message.user .att-tile-open") as HTMLElement).click();
    expect(opened.map((item) => item.name)).toEqual(["chart.png"]);
    expect(a.viewing()).toBeUndefined();
  });
  it("hands a composer tile to the registered opener", async () => {
    const { a, host } = await withAgent((agent) => <AgentComposer agent={agent} brand={{ id: "gemini", name: "Gemini" } as never} label="Gemini" />);
    const opened: Attachment[] = [];
    a.setAttachmentOpener((item) => opened.push(item));
    await a.intake.addFiles([png()], "picked");
    await tick();
    (host.querySelector(".att-tile-open") as HTMLElement).click();
    expect(opened.map((item) => item.name)).toEqual(["shot.png"]);
    expect(a.viewing()).toBeUndefined();
  });
});

describe("agent panel with a workbench", () => {
  it("opens a feed attachment as a live tab view and never as a dialog", async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    mocks.api.agentInstalled.mockResolvedValueOnce([{ id: "codex-acp", version: "2.3.0", launch: { command: "/bin/codex", args: [], env: {} } }] as never);
    mocks.api.agentRegistry.mockResolvedValueOnce([{ id: "codex-acp", name: "codex-acp", version: "1.0.0", description: "ACP", repository: null, icon: null, package: null, installable: true }] as never);
    mocks.api.agentConnect.mockResolvedValueOnce("s1");
    const views: AttachmentTabView[] = [];
    const host = mount(() => <AgentPanel workspacePath="/w" workspaceGeneration={1} onOpenAttachment={(view) => views.push(view)} />);
    await tick(); await tick();
    // An installed curated agent has one row, under Found on this computer.
    const codex = host.querySelector<HTMLButtonElement>("[aria-label='Connect codex-acp']");
    if (!codex) return expect.fail("the installed Codex row is missing");
    codex.click();
    await tick();
    mocks.emit({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] }, { kind: "session", sessionId: "s1" } as AgentEvent);
    await tick();
    mocks.emit(userEvent);
    await tick();
    (host.querySelector(".agent-message.user .att-chip-open, .agent-message.user .att-tile-open") as HTMLElement).click();
    await tick();
    expect(views).toHaveLength(1);
    expect(views[0].item.name).toBe("chart.png");
    expect(views[0].onRemove).toBeUndefined();
    expect(typeof views[0].onSaveToWorkspace).toBe("function");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
