// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { AgentEvent, InstalledAgent } from "../bindings";
import { AgentPanel } from "./AgentPanel";

const mocks = vi.hoisted(() => ({
  onEvent: vi.fn(),
  connect: vi.fn(),
  writeClipboard: vi.fn(async (_text: string) => undefined),
}));
vi.mock("../lib/client", () => ({
  isDesktop: true,
  api: {
    agentInstalled: vi.fn(async () => [{ id: "codex-acp", version: "2.3.0", launch: { command: "/x/node", args: [], env: {} } } satisfies InstalledAgent]),
    agentRegistry: vi.fn(async () => []),
    agentRemove: vi.fn(async () => undefined),
    agentConnect: mocks.connect,
    agentDisconnect: vi.fn(async () => undefined),
    agentInstall: vi.fn(),
    onAgentEvent: mocks.onEvent,
    agentPrompt: vi.fn(async () => undefined),
    agentCancel: vi.fn(async () => undefined),
    agentSetConfig: vi.fn(async () => undefined),
    agentListSessions: vi.fn(async () => []),
    agentResumeSession: vi.fn(),
    agentNewSession: vi.fn(),
    writeClipboard: mocks.writeClipboard,
  },
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
}));

const features = { loadSession: true, image: false, audio: false, embeddedContext: false, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false };
const disposers: (() => void)[] = [];
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); };
const listener = () => mocks.onEvent.mock.calls[0][0] as (event: AgentEvent) => void;

async function connected(props: { onOpenFile?: (path: string, line?: number) => void; onReviewInEditor?: (path: string, line?: number) => void }) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(() => <AgentPanel workspacePath="/workspace/one" {...props} />, root));
  await flush();
  root.querySelector<HTMLButtonElement>('[aria-label="Connect codex-acp"]')!.click();
  await flush();
  listener()({ kind: "ready", agentName: "codex", agentTitle: "Codex", agentVersion: "1", features, authMethods: [] } as AgentEvent);
  await flush();
  return root;
}
const proposal = (id: string, path: string) => ({ kind: "proposal", sessionId: "session-1", proposal: { id, path, baseRevision: 0, hunks: [{ id: `${id}h`, from: 0, to: 0, before: "", after: "x" }] } }) as AgentEvent;
const row = (root: HTMLElement, name: string) => [...root.querySelectorAll<HTMLButtonElement>("button.sb-change-name")].find((button) => button.textContent === name)!;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.onEvent.mockResolvedValue(() => undefined);
  mocks.connect.mockResolvedValue("session-1");
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

describe("open files from the changes card (#56)", () => {
  it("opens the proposal's workspace file in the review opener when its row is clicked", async () => {
    const onReviewInEditor = vi.fn();
    const onOpenFile = vi.fn();
    const root = await connected({ onReviewInEditor, onOpenFile });
    listener()(proposal("p1", "src/file.ts"));
    await flush();
    row(root, "file.ts").click();
    expect(onReviewInEditor).toHaveBeenCalledWith("src/file.ts", undefined);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(root.querySelector(".sb-toast-name")?.textContent).toBe("file.ts");
  });

  it("refuses a path outside the workspace with a clear note and a Copy path action", async () => {
    const onReviewInEditor = vi.fn();
    const root = await connected({ onReviewInEditor });
    listener()(proposal("p2", "/etc/hosts"));
    await flush();
    row(root, "hosts").click();
    await flush();
    expect(onReviewInEditor).not.toHaveBeenCalled();
    const note = root.querySelector(".sb-refusal")!;
    expect(note.textContent).toContain("Outside this workspace, so it cannot be opened here");
    expect(note.querySelector(".sb-refusal-path")?.textContent).toBe("/etc/hosts");
    const copy = [...note.querySelectorAll("button")].find((button) => button.textContent === "Copy path")!;
    copy.click();
    await flush();
    expect(mocks.writeClipboard).toHaveBeenCalledWith("/etc/hosts");
    expect(note.textContent).toContain("Copied");
    note.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
    await flush();
    expect(root.querySelector(".sb-refusal")).toBeNull();
  });

  it("refuses a traversal out of the workspace the same way", async () => {
    const onReviewInEditor = vi.fn();
    const root = await connected({ onReviewInEditor });
    listener()(proposal("p3", "../other/secret.ts"));
    await flush();
    row(root, "secret.ts").click();
    await flush();
    expect(onReviewInEditor).not.toHaveBeenCalled();
    expect(root.querySelector(".sb-refusal")?.textContent).toContain("Outside this workspace");
  });
});
