// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures, PromptAttachment } from "../../bindings";
import { createAgentController, type AgentController, type AgentPanelProps } from "../../lib/agent-controller";
import type { UploadRecorder } from "../../lib/uploads-desktop";
import { AgentComposer } from "./AgentComposer";
import { mount } from "./test-utils";

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
      agentPrompt: vi.fn(async (..._args: unknown[]) => undefined),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentNewSession: vi.fn(async () => "s2"),
      agentSetConfig: vi.fn(async () => undefined),
      listDirectory: vi.fn(async (_path: string) => [] as { path: string; name: string; isDir: boolean }[]),
      openBuffer: vi.fn(),
    },
  };
});
vi.mock("../../lib/client", () => ({
  isDesktop: true,
  api: mocks.api,
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
  sessionMetaList: vi.fn(async () => []),
  sessionMetaUpdate: vi.fn(async () => undefined),
  sessionMetaSetTitle: vi.fn(async () => undefined),
}));

const features = (patch: Partial<AgentFeatures> = {}): AgentFeatures => ({ loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false, ...patch });
const tick = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function recorder() {
  const calls: { name: string; source: Record<string, unknown>; at: number }[] = [];
  let order = 0;
  const uploads: UploadRecorder & { calls: typeof calls; paths: string[] } = {
    calls,
    paths: [],
    add: vi.fn(async (name: string, _data: string, source) => { calls.push({ name, source: source as Record<string, unknown>, at: ++order }); return { id: `u${calls.length}` }; }),
    copyPath: vi.fn(async (id: string) => { const path = `/Users/me/Library/Application Support/span/uploads/k/open/${id}/x.bin`; uploads.paths.push(path); return path; }),
  };
  return uploads;
}

async function composer(agentFeatures = features(), props: Partial<AgentPanelProps> = {}) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "a", agentTitle: "Agent", agentVersion: "1", features: agentFeatures, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1, ...props });
    return <AgentComposer agent={controller} brand={{ id: "a", name: "Agent" }} label="Agent" />;
  });
  await tick();
  controller.connectCustom("agent");
  await tick();
  return { a: controller, host };
}
const openMenu = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[aria-label^='Attach files and context']")!.click();
const menuItem = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.querySelector(".att-menu-label")?.textContent === name)!;
const binary = (name = "data.bin") => new File([new Uint8Array([0, 1, 2, 3, 250])], name, { type: "application/octet-stream" });
const sentAttachments = (call = 0) => mocks.api.agentPrompt.mock.calls[call]?.[1] as PromptAttachment[];

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockClear();
  mocks.api.agentNewSession.mockClear();
  mocks.api.listDirectory.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("recording sent attachments in the uploads store", () => {
  it("records each sent attachment once, with session, agent, message and origin", async () => {
    const uploads = recorder();
    const { a } = await composer(features(), { uploads });
    await a.intake.addFiles([new File(["notes"], "notes.md", { type: "text/markdown" })], "dropped");
    a.setPrompt("read this");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    expect(uploads.add).toHaveBeenCalledTimes(1);
    expect(uploads.calls[0].name).toBe("notes.md");
    expect(uploads.calls[0].source).toMatchObject({ sessionId: "s1", origin: "dropped" });
    expect(typeof uploads.calls[0].source.messageId).toBe("string");
    // The sent message's attachment now carries its upload id, so a resend does not record it again.
    const sent = a.feed().find((item) => item.kind === "user");
    expect(sent?.kind === "user" && sent.attachments?.[0].uploadId).toBe("u1");
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn" } as AgentEvent);
    await tick();
    a.resendFrom(sent!.id);
    await tick(8);
    expect(uploads.add).toHaveBeenCalledTimes(1);
  });

  it("never records workspace files or selections, which already live in the workspace", async () => {
    const uploads = recorder();
    const { a } = await composer(features(), { uploads, activePath: "src/a.ts" });
    a.intake.addItems([{ id: "w1", kind: "file", name: "a.ts", mime: "text/plain", size: 0, source: "workspace-file", path: "src/a.ts", status: "ready" }]);
    a.setPrompt("x");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    expect(uploads.add).not.toHaveBeenCalled();
  });

  it("records nothing without the uploads store (browser preview or tests without it)", async () => {
    const { a } = await composer();
    await a.intake.addFiles([new File(["n"], "n.txt", { type: "text/plain" })], "picked");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    expect(a.caps()?.storeLinks).toBeUndefined();
  });
});

describe("sent as link", () => {
  it("saves content the agent cannot take to the uploads store first, then links to the stored copy", async () => {
    const uploads = recorder();
    const { a, host } = await composer(features({ embeddedContext: false }), { uploads });
    await a.intake.addFiles([binary()], "picked");
    expect(host.querySelector(".att-tile")?.getAttribute("data-state")).toBe("link");
    expect(host.querySelector(".att-tile-meta")?.textContent).toBe("Sent as link");
    expect(host.querySelector(".att-tile")?.getAttribute("title")).toContain("The agent must be able to read that file.");
    expect(a.blocked()).toEqual([]);
    a.send();
    await tick();
    expect(uploads.add).toHaveBeenCalledTimes(1);
    expect(uploads.copyPath).toHaveBeenCalledWith("u1");
    const add = (uploads.add as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(add).toBeLessThan(mocks.api.agentPrompt.mock.invocationCallOrder[0]);
    const [link] = sentAttachments();
    expect(link).toMatchObject({ kind: "resourceLink", name: "data.bin" });
    expect(link.uri).toBe(`file://${uploads.paths[0].split("/").map(encodeURIComponent).join("/")}`);
    // Recorded once: the save for the link counts as the recording.
    expect(uploads.add).toHaveBeenCalledTimes(1);
  });

  it("blocks the send with the reason when the save fails, and keeps the attachment", async () => {
    const uploads = recorder();
    (uploads.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Uploads are full (512 MiB)"));
    const { a, host } = await composer(features({ embeddedContext: false }), { uploads });
    await a.intake.addFiles([binary()], "picked");
    a.send();
    await tick();
    expect(mocks.api.agentPrompt).not.toHaveBeenCalled();
    expect(host.querySelector(".att-notices")?.textContent).toContain("Could not save it to Uploads for the link: Uploads are full (512 MiB)");
    expect(a.attachments()).toHaveLength(1);
  });

  it("still refuses binary content without the uploads store", async () => {
    const { a } = await composer(features({ embeddedContext: false }));
    await a.intake.addFiles([binary()], "picked");
    expect(a.blocked()[0]?.reason).toContain("cannot receive binary files");
  });
});

describe("attach menu: paste screenshot, folder and earlier session", () => {
  it("offers Paste screenshot and Earlier session, and Folder only with the folder picker", async () => {
    const { host } = await composer(features(), { pickFolder: async () => null });
    openMenu(host);
    expect(menuItem(host, "Paste screenshot")).toBeTruthy();
    expect(menuItem(host, "Folder").getAttribute("aria-disabled")).toBeNull();
    expect(menuItem(host, "Earlier session").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem(host, "Earlier session").textContent).toContain("No earlier chat open");
  });

  it("pastes a clipboard image from the click", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])], { type: "image/png" });
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", clipboard: { read: async () => [{ types: ["image/png"], getType: async () => png }] } });
    const { a, host } = await composer();
    openMenu(host);
    menuItem(host, "Paste screenshot").click();
    await tick();
    expect(a.attachments().map((item) => [item.name, item.kind, item.source])).toEqual([["Screenshot.png", "image", "pasted"]]);
  });

  it("falls back to the paste shortcut when the clipboard cannot be read, and says so", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel", clipboard: { read: async () => { throw new Error("NotAllowedError"); } } });
    const { a, host } = await composer();
    openMenu(host);
    menuItem(host, "Paste screenshot").click();
    await tick();
    expect(a.attachments()).toHaveLength(0);
    expect(host.querySelector(".att-notices")?.textContent).toContain("press Cmd+V");
  });

  it("attaches a workspace folder as a bounded outline plus a folder link, with its file count", async () => {
    mocks.api.listDirectory.mockImplementation(async (path: string) =>
      path === "ui"
        ? [{ path: "ui/src", name: "src", isDir: true }, { path: "ui/node_modules", name: "node_modules", isDir: true }, { path: "ui/a.ts", name: "a.ts", isDir: false }]
        : path === "ui/src" ? [{ path: "ui/src/b.ts", name: "b.ts", isDir: false }] : [],
    );
    const pickFolder = vi.fn(async () => "/w/ui");
    const { a, host } = await composer(features(), { pickFolder });
    openMenu(host);
    menuItem(host, "Folder").click();
    await tick();
    expect(pickFolder).toHaveBeenCalledWith("/w");
    const [folder] = a.attachments();
    expect(folder).toMatchObject({ kind: "folder", name: "ui", path: "ui", folder: { files: 2, truncated: false } });
    expect(folder.text).toContain("src/b.ts");
    expect(folder.text).not.toContain("node_modules");
    expect(folder.text).not.toContain("/w/");
    expect(mocks.api.listDirectory).not.toHaveBeenCalledWith("ui/node_modules");
    expect(host.querySelector(".att-tile-meta")?.textContent).toBe("2 files");
    a.send();
    await tick();
    expect(sentAttachments().map((item) => [item.kind, item.uri])).toEqual([["resource", "file:///w/ui"], ["resourceLink", "file:///w/ui"]]);
  });

  it("refuses a folder outside the workspace with the reason", async () => {
    const { a, host } = await composer(features(), { pickFolder: async () => "/elsewhere/secrets" });
    openMenu(host);
    menuItem(host, "Folder").click();
    await tick();
    expect(a.attachments()).toHaveLength(0);
    expect(host.querySelector(".att-notices")?.textContent).toContain("secrets: Outside this workspace, so it cannot be attached.");
  });

  it("attaches an earlier chat as a Markdown transcript with absolute paths redacted", async () => {
    const { a, host } = await composer();
    a.setPrompt("look at /w/src/a.ts and /Users/me/secret/plan.md");
    a.send();
    await tick();
    mocks.emit({ kind: "text", sessionId: "s1", text: "Done." } as AgentEvent, { kind: "complete", sessionId: "s1", stopReason: "end_turn" } as AgentEvent);
    await tick();
    a.newChat();
    await tick(8);
    expect(a.state().sessionId).toBe("s2");
    openMenu(host);
    const item = menuItem(host, "Earlier session");
    expect(item.getAttribute("aria-disabled")).toBeNull();
    item.click();
    await tick();
    const picker = host.querySelector("[aria-label='Attach an earlier session']")!;
    picker.querySelector<HTMLButtonElement>("[role=menuitem]")!.click();
    await tick();
    const [transcript] = a.attachments();
    expect(transcript.mime).toBe("text/markdown");
    expect(transcript.text).toContain("## You");
    expect(transcript.text).toContain("## Agent\n\nDone.");
    expect(transcript.text).toContain("./src/a.ts");
    expect(transcript.text).not.toContain("/Users/me");
    expect(transcript.text).toContain("…/plan.md");
  });
});
