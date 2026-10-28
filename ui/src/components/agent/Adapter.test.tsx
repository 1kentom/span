// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController, type AgentPanelProps } from "../../lib/agent-controller";
import { AgentFeed } from "./AgentFeed";
import { AgentComposer } from "./AgentComposer";
import { AuthForm, parseGatewayUrl } from "./AuthForm";
import { ConnectScreen } from "./ConnectScreen";
import { PermissionDock } from "./Docks";
import { SignIn } from "./SignIn";
import { WorkGroup, groupInternal } from "./WorkGroup";
import type { PermissionDetails, StepView } from "./types";
import { mount, text } from "./test-utils";
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
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentPermission: vi.fn(async () => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
      writeClipboard: vi.fn(async () => undefined),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
    agentAuthenticateWith: vi.fn(async (_method: string, _credential: unknown): Promise<string> => "s1"),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: mocks.agentAuthenticateWith }));

const features = (patch: Partial<AgentFeatures> = {}): AgentFeatures => ({ loadSession: false, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: false, canCloseSessions: false, canDeleteSessions: false, ...patch });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (element: Element | null | undefined) => (element as HTMLElement).click();
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentSetConfig.mockClear();
  mocks.api.agentPermission.mockClear();
  mocks.agentAuthenticateWith.mockReset();
  mocks.agentAuthenticateWith.mockResolvedValue("s1");
  mocks.agentPresets.mockReset();
  mocks.agentPresets.mockResolvedValue([]);
});

/** Connects through the real controller path and mounts `view` with it. */
async function withAgent(view: (a: AgentController) => any, agentFeatures = features(), props: Partial<AgentPanelProps> = {}) {
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features: agentFeatures, authMethods: [] }, { kind: "session", sessionId: "s1" });
    return "s1";
  });
  let controller!: AgentController;
  const host = mount(() => {
    controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1, ...props });
    return view(controller);
  });
  await tick();
  controller.connectCustom("agent");
  await tick();
  return { a: controller, host };
}

const details = (patch: Partial<PermissionDetails> = {}): PermissionDetails => ({ locations: [], diffs: [], moreDiffs: 0, internal: false, ...patch });
const options = [
  { optionId: "ao", name: "Allow once", kind: "allow_once" },
  { optionId: "ro", name: "Reject", kind: "reject_once" },
  { optionId: "ra", name: "Reject always", kind: "reject_always" },
];

describe("PermissionDock details", () => {
  it("shows the diff preview, kind, locations and a bounded input, and opens through the callback", () => {
    const opened: string[] = [];
    const host = mount(() => (
      <PermissionDock
        title="Edit src/a.ts"
        options={options}
        onChoose={() => undefined}
        details={details({
          kind: "edit",
          diffs: [{ path: "src/a.ts", change: "modify", lines: [{ kind: "del", n: 1, text: "old" }, { kind: "add", n: 1, text: "new" }], onOpen: () => opened.push("diff") }],
          locations: [{ label: "src/a.ts", line: 3, onOpen: () => opened.push("loc") }, { label: "/etc/hosts" }],
          input: '{\n  "file_path": "src/a.ts"\n}',
        })}
      />
    ));
    expect(text(host.querySelector(".sb-kind"))).toBe("edit");
    expect(host.querySelector(".sb-dock-diff .sb-diff-line.add")?.textContent).toContain("new");
    expect(host.querySelector(".sb-dock-diff .sb-diff-line.del")?.textContent).toContain("old");
    const locations = host.querySelectorAll(".sb-dock-locs li");
    expect(locations).toHaveLength(2);
    expect(locations[0].querySelector("button")?.textContent).toBe("src/a.ts:3");
    expect(locations[1].querySelector("button")).toBeNull();
    click(locations[0].querySelector("button"));
    click(host.querySelector(".sb-diff-head button"));
    expect(opened).toEqual(["loc", "diff"]);
    expect(host.querySelector(".sb-dock-input pre")?.textContent).toContain("file_path");
    expect(host.querySelector(".sb-dock-input")?.hasAttribute("open")).toBe(false);
  });
  it("shows the command for execute", () => {
    const host = mount(() => <PermissionDock title="Run" options={options} onChoose={() => undefined} details={details({ kind: "execute", command: "rm -rf build" })} />);
    expect(text(host.querySelector(".sb-dock-command"))).toContain("rm -rf build");
  });
  it("does not offer reject_always", () => {
    const host = mount(() => <PermissionDock title="Run" options={options} onChoose={() => undefined} />);
    expect([...host.querySelectorAll(".sb-actions button")].map((button) => button.textContent?.replace(/[YN]$/, ""))).toEqual(["Allow once", "Reject"]);
  });
  it("collapses an internal request to one row, keeps it answerable, and expands on demand", () => {
    const chosen: string[] = [];
    const host = mount(() => (
      <PermissionDock title="resolve-prompt-1" options={options} onChoose={(id) => chosen.push(id)} details={details({ internal: true, kind: "read", command: "GEMINI.md", locations: [{ label: "GEMINI.md" }] })} />
    ));
    expect(host.querySelector(".sb-dock.internal")).not.toBeNull();
    expect(host.querySelector(".sb-dock-details")).toBeNull();
    expect(text(host)).toContain("Agent housekeeping");
    click(host.querySelector("button[aria-expanded]"));
    expect(host.querySelector(".sb-dock-details")?.textContent).toContain("GEMINI.md");
    click(host.querySelector(".sb-actions button"));
    expect(chosen).toEqual(["ao"]);
  });
  it("explains a possible second prompt in a tooltip and shows nothing otherwise", () => {
    const shown = mount(() => <PermissionDock title="Edit" options={options} onChoose={() => undefined} details={details({ doubleApproval: true })} />);
    expect(shown.querySelector(".sb-double")?.getAttribute("title")).toContain("second time");
    const quiet = mount(() => <PermissionDock title="Edit" options={options} onChoose={() => undefined} details={details()} />);
    expect(quiet.querySelector(".sb-double")).toBeNull();
  });
});

describe("internal tool steps", () => {
  const step = (id: string, internal = false): StepView => ({ id, kind: "read", verb: id, status: "completed", internal });
  it("groups runs of internal steps in order", () => {
    expect(groupInternal([step("a"), step("b", true), step("c", true), step("d"), step("e", true)]).map((segment) => (segment.type === "step" ? segment.step.id : segment.steps.map((entry) => entry.id).join("+")))).toEqual(["a", "b+c", "d", "e"]);
  });
  it("hides internal steps under a muted row until it is opened", () => {
    const host = mount(() => <WorkGroup headline="Worked" steps={[step("visible"), step("resolve-prompt-1", true), step("read_many_files", true)]} />);
    expect(host.querySelectorAll(".sb-step")).toHaveLength(1);
    const row = host.querySelector<HTMLButtonElement>(".sb-internal-row")!;
    expect(text(row)).toContain("Agent housekeeping (2)");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    click(row);
    expect(host.querySelectorAll(".sb-step")).toHaveLength(3);
    expect(text(host.querySelector(".sb-internal-steps"))).toContain("resolve-prompt-1");
  });
  it("shows hint notes, thumbnails that open the viewer, and a saved path as plain text", () => {
    const opened: string[] = [];
    const host = mount(() => (
      <WorkGroup
        headline="Worked"
        steps={[
          { id: "a", kind: "run", verb: "Shell", status: "completed", note: "Output not available from agent" },
          { id: "b", kind: "other", verb: "Generate image", status: "completed", images: [{ id: "b:image:0", name: "image-1.png", mime: "image/png", src: "data:image/png;base64,AAAA", onOpen: () => opened.push("b:image:0") }], savedPath: "/Users/x/out.png" },
        ]}
      />
    ));
    expect(text(host.querySelector(".sb-step-note"))).toBe("Output not available from agent");
    click(host.querySelector(".sb-thumb-btn"));
    expect(opened).toEqual(["b:image:0"]);
    expect(host.querySelector("img.sb-thumb")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    const saved = host.querySelector(".sb-step-saved")!;
    expect(text(saved)).toContain("/Users/x/out.png");
    expect(text(saved)).toContain("does not open it");
    expect(saved.querySelector("button, a")).toBeNull();
  });
});

describe("ConnectScreen presets", () => {
  it("lists a preset with its exact command and connects it", () => {
    const connected: string[] = [];
    const host = mount(() => (
      <ConnectScreen found={[]} registry={[]} presets={[{ id: "opencode", name: "OpenCode", description: "Custom ACP command", command: "opencode acp" }]} onPreset={(id) => connected.push(id)} onConnect={() => undefined} onInstall={() => undefined} onCustom={() => undefined} />
    ));
    expect(text(host.querySelector(".sb-preset-command"))).toBe("opencode acp");
    click(host.querySelector("[aria-label='Connect OpenCode']"));
    expect(connected).toEqual(["opencode"]);
  });
  it("loads presets through the controller and launches exactly the shown command", async () => {
    mocks.agentPresets.mockResolvedValue([{ id: "opencode", name: "OpenCode", description: "d", launch: { command: "opencode", args: ["acp"], env: {} } }]);
    const { a } = await withAgent(() => null);
    mocks.api.agentConnect.mockClear();
    expect(a.presets().map((preset) => preset.id)).toEqual(["opencode"]);
    a.connectPreset("opencode");
    await tick();
    expect(mocks.api.agentConnect).toHaveBeenCalledWith({ command: "opencode", args: ["acp"], env: {} }, "/w");
    expect(a.agentName()).toBe("OpenCode");
  });
});

describe("sign-in forms and secrets", () => {
  const SECRET = "sk-super-secret-123";
  it("uses password fields for the key and for every header value", () => {
    const key = mount(() => <AuthForm kind="apiKey" methodName="Gemini API key" onSubmit={() => undefined} />);
    expect(key.querySelector("input")?.getAttribute("type")).toBe("password");
    expect(key.querySelector("input")?.getAttribute("autocomplete")).toBe("off");
    const gateway = mount(() => <AuthForm kind="gateway" methodName="Gateway" onSubmit={() => undefined} />);
    click([...gateway.querySelectorAll("button")].find((button) => button.textContent === "Add header"));
    expect(gateway.querySelector("input[aria-label='Header value']")?.getAttribute("type")).toBe("password");
    expect(gateway.querySelector("input[type=url]")).not.toBeNull();
  });
  it("hands the secret over once, clears the field on submit and renders nothing back", () => {
    const received: unknown[] = [];
    const host = mount(() => <AuthForm kind="apiKey" methodName="Gemini API key" onSubmit={(secret) => received.push(secret)} />);
    const input = host.querySelector("input")!;
    type(input, SECRET);
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(received).toEqual([{ kind: "apiKey", key: SECRET }]);
    expect(input.value).toBe("");
    expect(host.textContent).not.toContain(SECRET);
    expect(host.innerHTML).not.toContain(SECRET);
  });
  it("clears typed values when the form unmounts without a submit", () => {
    let input!: HTMLInputElement;
    const host = document.createElement("div");
    document.body.append(host);
    return import("solid-js/web").then(({ render }) => {
      const dispose = render(() => <AuthForm kind="apiKey" methodName="k" onSubmit={() => undefined} />, host);
      input = host.querySelector("input")!;
      type(input, SECRET);
      expect(input.value).toBe(SECRET);
      dispose();
      expect(input.value).toBe("");
      expect(host.textContent).not.toContain(SECRET);
    });
  });
  it("validates the gateway URL and sends base URL and headers", () => {
    expect(parseGatewayUrl("https://gw.example.com/v1")).toBe("https://gw.example.com/v1");
    expect(parseGatewayUrl("javascript:alert(1)")).toBeUndefined();
    expect(parseGatewayUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseGatewayUrl("nope")).toBeUndefined();
    const received: unknown[] = [];
    const host = mount(() => <AuthForm kind="gateway" methodName="Gateway" onSubmit={(secret) => received.push(secret)} />);
    type(host.querySelector<HTMLInputElement>("input[type=url]")!, "https://gw.example.com");
    click([...host.querySelectorAll("button")].find((button) => button.textContent === "Add header"));
    type(host.querySelector<HTMLInputElement>("input[aria-label='Header name']")!, "X-Team");
    type(host.querySelector<HTMLInputElement>("input[aria-label='Header value']")!, "abc");
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(received).toEqual([{ kind: "gateway", baseUrl: "https://gw.example.com/", headers: { "X-Team": "abc" } }]);
    const bad = mount(() => <AuthForm kind="gateway" methodName="Gateway" onSubmit={(secret) => received.push(secret)} />);
    type(bad.querySelector<HTMLInputElement>("input[type=url]")!, "ftp://x");
    bad.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(received).toHaveLength(1);
    expect(bad.querySelector("[role=alert]")?.textContent).toContain("https://");
  });
  it("shows the hint text and opens a form only for methods that take input", () => {
    const picked: string[] = [];
    const host = mount(() => (
      <SignIn
        title="Sign in to Gemini"
        hint="Run `opencode auth login` in a terminal, then retry"
        methods={[{ id: "oauth", name: "Google login" }, { id: "gemini-api-key", name: "API key", input: "apiKey" }]}
        onPick={(id) => picked.push(id)}
        onSubmit={() => undefined}
      />
    ));
    expect(host.querySelector(".sb-auth-hint code")?.textContent).toBe("opencode auth login");
    const [oauth, apiKey] = host.querySelectorAll<HTMLButtonElement>(".sb-method");
    expect(host.querySelector(".sb-auth-form")).toBeNull();
    click(oauth);
    expect(picked).toEqual(["oauth"]);
    click(apiKey);
    expect(host.querySelector(".sb-auth-form")).not.toBeNull();
    expect(picked).toEqual(["oauth"]);
  });
  it("signs in through the panel with a typed key, then no field or text holds it", async () => {
    Element.prototype.scrollTo = () => undefined;
    const methods = [{ id: "gemini-api-key", name: "Gemini API key", description: null, kind: "agent", supported: true, input: "apiKey" as const }];
    mocks.api.agentInstalled.mockResolvedValueOnce([{ id: "gemini", version: "1", launch: { command: "gemini", args: ["--acp"], env: {} } }] as never);
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features: features(), authMethods: methods }, { kind: "authRequired", message: "Authentication required", authMethods: methods, hint: undefined } as AgentEvent);
      return "";
    });
    const host = mount(() => <AgentPanel workspacePath="/w" workspaceGeneration={1} />);
    await tick();
    await tick();
    click(host.querySelector("[aria-label='Connect gemini']"));
    await tick();
    click(host.querySelector(".sb-method"));
    const input = host.querySelector<HTMLInputElement>(".sb-auth-form input[type=password]")!;
    type(input, SECRET);
    host.querySelector(".sb-auth-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(mocks.agentAuthenticateWith).toHaveBeenCalledWith("gemini-api-key", { kind: "apiKey", key: SECRET });
    expect(mocks.api.agentAuthenticate).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(host.querySelector(".sb-auth-form")).toBeNull();
    expect(host.textContent).not.toContain(SECRET);
    expect([...host.querySelectorAll("input,textarea")].every((field) => !(field as HTMLInputElement).value.includes(SECRET))).toBe(true);
  });
  it("shows the OpenCode login hint from authRequired and the unsupported method's hint once", async () => {
    Element.prototype.scrollTo = () => undefined;
    const methods = [{ id: "opencode-login", name: "Login with opencode", description: null, kind: "terminal", supported: false, hint: "runOpencodeAuthLogin" as const }];
    mocks.api.agentInstalled.mockResolvedValueOnce([{ id: "opencode", version: "1", launch: { command: "opencode", args: ["acp"], env: {} } }] as never);
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "opencode", agentTitle: "OpenCode", agentVersion: "1", features: features(), authMethods: methods }, { kind: "authRequired", message: "Authentication required", authMethods: methods, hint: "runOpencodeAuthLogin" } as AgentEvent);
      return "";
    });
    const host = mount(() => <AgentPanel workspacePath="/w" workspaceGeneration={1} />);
    await tick();
    await tick();
    click(host.querySelector("[aria-label='Connect opencode']"));
    await tick();
    expect(host.querySelectorAll("code")).toHaveLength(1);
    expect(text(host.querySelector(".sb-auth-hint"))).toBe("Run opencode auth login in a terminal, then retry");
    expect(text(host)).not.toContain("needs a terminal sign-in");
  });
  it("authenticateWith passes the credential straight through and leaves it nowhere in state", async () => {
    const methods = [{ id: "gemini-api-key", name: "Gemini API key", description: null, kind: "agent", supported: true, input: "apiKey" as const }];
    mocks.api.agentConnect.mockImplementationOnce(async () => {
      mocks.emit({ kind: "ready", agentName: "gemini", agentTitle: "Gemini", agentVersion: "1", features: features(), authMethods: methods }, { kind: "authRequired", message: "Authentication required", authMethods: methods });
      return "";
    });
    let controller!: AgentController;
    mount(() => {
      controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return null;
    });
    await tick();
    controller.connectCustom("gemini --acp");
    await tick();
    expect(controller.state().auth?.methods[0]).toMatchObject({ id: "gemini-api-key", input: "apiKey" });
    await controller.authenticateWith("gemini-api-key", { kind: "apiKey", key: SECRET });
    expect(mocks.agentAuthenticateWith).toHaveBeenCalledWith("gemini-api-key", { kind: "apiKey", key: SECRET });
    expect(controller.state().sessionId).toBe("s1");
    expect(controller.state().auth).toBeUndefined();
    expect(JSON.stringify(controller.state())).not.toContain(SECRET);
    expect(JSON.stringify(controller.feed())).not.toContain(SECRET);
    expect(mocks.api.agentAuthenticate).not.toHaveBeenCalled();
  });
  it("a failed sign-in reports the backend message and still keeps the secret out of state", async () => {
    mocks.agentAuthenticateWith.mockRejectedValueOnce(new Error("The key was rejected"));
    let controller!: AgentController;
    mount(() => {
      controller = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
      return null;
    });
    await tick();
    await controller.authenticateWith("gemini-api-key", { kind: "apiKey", key: SECRET });
    expect(controller.state().failure).toMatchObject({ phase: "auth", message: "The key was rejected" });
    expect(JSON.stringify(controller.state())).not.toContain(SECRET);
    expect(controller.pendingAction()).toBe("");
  });
});

describe("feed and composer with adapter data", () => {
  it("updates a retry notice in place and removes it when cleared", async () => {
    const { a, host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    const notice = (description: string): AgentEvent => ({ kind: "notice", sessionId: "s1", severity: "warning", title: "", description, noticeId: "retry", hint: "retrying" }) as AgentEvent;
    mocks.emit(notice("attempt 1"));
    await tick();
    expect(host.querySelectorAll(".sb-card.alert")).toHaveLength(1);
    expect(text(host.querySelector(".sb-card.alert"))).toContain("Retrying");
    expect(text(host.querySelector(".sb-card.alert"))).toContain("attempt 1");
    mocks.emit(notice("attempt 2"));
    await tick();
    expect(host.querySelectorAll(".sb-card.alert")).toHaveLength(1);
    expect(text(host.querySelector(".sb-card.alert"))).toContain("attempt 2");
    mocks.emit({ kind: "noticeCleared", sessionId: "s1", noticeId: "retry" });
    await tick();
    expect(host.querySelectorAll(".sb-card.alert")).toHaveLength(0);
    expect(a.feed()).toEqual([]);
  });
  it("renders replayed user attachments as chips", async () => {
    const { host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    mocks.emit({ kind: "user", sessionId: "s1", text: "see this", attachments: [{ kind: "image", name: "shot.png", uri: null, mimeType: "image/png" }] } as AgentEvent);
    await tick();
    expect(host.querySelector(".agent-message.user .att-chip-open, .agent-message.user .att-tile-open")).not.toBeNull();
    expect(host.querySelector(".agent-message.user")?.textContent).toContain("shot.png");
  });
  it("starts a new bubble for newBlock text", async () => {
    const { host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    mocks.emit({ kind: "text", sessionId: "s1", text: "first", messageId: "m1" } as AgentEvent, { kind: "text", sessionId: "s1", text: "second", messageId: "m2", newBlock: true } as AgentEvent);
    await tick();
    expect([...host.querySelectorAll(".agent-message.text")].map((node) => node.textContent?.trim())).toEqual(["first", "second"]);
  });
  const editTool = { kind: "tool", sessionId: "s1", toolCallId: "t1", title: "Write a.ts", status: "completed", toolKind: "edit", parentToolCallId: null, contentJson: "{}", locations: [{ path: "/w/a.ts" }] } as AgentEvent;
  it("says plainly that edits land directly when the agent bypasses review, and not otherwise", async () => {
    const bypass = await withAgent((agent) => <AgentFeed agent={agent} />, features({ editsBypassReview: true }));
    mocks.emit(editTool);
    await tick();
    expect(text(bypass.host.querySelector(".sb-bypass-note"))).toBe("Gemini writes files directly; Span can't review edits before they land");
    expect(bypass.host.querySelector(".sb-change-actions, [aria-label^='Accept']")).toBeNull();
  });
  it("shows no bypass note for an agent that reviews through Span", async () => {
    mocks.listeners.splice(0);
    const normal = await withAgent((agent) => <AgentFeed agent={agent} />, features());
    mocks.emit(editTool);
    await tick();
    expect(normal.host.querySelector(".sb-bypass-note")).toBeNull();
  });
  it("opens a tool image in the shared viewer with the bytes the agent sent", async () => {
    const png = "iVBORw0KGgo=";
    const { a, host } = await withAgent((agent) => <AgentFeed agent={agent} />);
    mocks.emit({ kind: "tool", sessionId: "s1", toolCallId: "g1", title: "Generate image", status: "completed", toolKind: "other", parentToolCallId: null, contentJson: "{}", images: [{ mimeType: "image/png", data: png, uri: null }], savedPath: "/Users/x/out.png" } as AgentEvent);
    await tick();
    click(host.querySelector(".sb-thumb-btn"));
    expect(a.viewing()).toBe("g1:image:0");
    expect(a.viewingItem()).toMatchObject({ kind: "image", mime: "image/png", status: "ready" });
    expect(a.viewingItem()?.bytes?.length).toBe(8);
    expect(a.viewingItem()?.path).toBeUndefined();
    expect(text(host.querySelector(".sb-step-saved"))).toContain("/Users/x/out.png");
  });
  const permissionEvent = (patch: Record<string, unknown> = {}): AgentEvent =>
    ({ kind: "permission", sessionId: "s1", requestId: "r1", toolCallId: "t1", title: "Edit a.ts", options, toolKind: "edit", locations: [{ path: "/w/src/a.ts", line: 7 }, { path: "/etc/passwd" }], diffs: [{ path: "/w/src/a.ts", resolved: true, change: "modify", oldText: "a\n", newText: "b\n" }], ...patch }) as AgentEvent;
  it("shows the diff in the permission dock and opens locations only inside the workspace", async () => {
    const onOpenFile = vi.fn();
    const { host } = await withAgent((agent) => <AgentComposer agent={agent} brand={{ id: "gemini", name: "Gemini" }} label="Gemini" />, features({ doubleApproval: true }), { onOpenFile });
    mocks.emit(permissionEvent());
    await tick();
    expect(host.querySelector(".sb-dock .sb-diff-line.add")?.textContent).toContain("b");
    expect(host.querySelector(".sb-double")).not.toBeNull();
    const links = host.querySelectorAll(".sb-dock-locs li");
    expect(links[1].querySelector("button")).toBeNull();
    click(links[0].querySelector("button"));
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", 7);
    expect([...host.querySelectorAll(".sb-dock .sb-actions button")].map((button) => button.textContent?.replace(/[YN]$/, ""))).toEqual(["Allow once", "Reject"]);
  });
  it("collapses an internal permission and still answers it", async () => {
    const { host } = await withAgent((agent) => <AgentComposer agent={agent} brand={{ id: "gemini", name: "Gemini" }} label="Gemini" />);
    mocks.emit(permissionEvent({ internal: true, title: "resolve-prompt-1", diffs: [], locations: [] }));
    await tick();
    expect(host.querySelector(".sb-dock.internal")).not.toBeNull();
    expect(host.querySelector(".sb-dock-details")).toBeNull();
    click(host.querySelector(".sb-dock .sb-actions button"));
    await tick();
    expect(mocks.api.agentPermission).toHaveBeenCalledWith("r1", "ao");
  });
  it("shows tokens for the last turn only when no context usage was ever reported", async () => {
    const { host } = await withAgent((agent) => <AgentComposer agent={agent} brand={{ id: "g", name: "G" }} label="G" />);
    mocks.emit({ kind: "complete", sessionId: "s1", stopReason: "end_turn", usage: { totalTokens: 1234 } } as AgentEvent);
    await tick();
    expect(text(host.querySelector(".agent-turn-tokens"))).toBe("1,234 tokens last turn");
    expect(host.querySelector(".sb-ring")).toBeNull();
    mocks.emit({ kind: "usage", sessionId: "s1", used: 10, size: 100, costAmount: null, costCurrency: null } as AgentEvent);
    await tick();
    expect(host.querySelector(".agent-turn-tokens")).toBeNull();
    expect(host.querySelector(".sb-ring")).not.toBeNull();
  });
});

describe("Gemini legacy modes and models", () => {
  const config = {
    kind: "config",
    sessionId: "s1",
    options: [
      { id: "mode", name: "Mode", description: null, category: "mode", currentValue: "default", groups: [{ name: "", choices: [{ value: "default", name: "Default" }, { value: "yolo", name: "YOLO" }] }] },
      { id: "model", name: "Model", description: null, category: "model", currentValue: "gemini-2.5-pro", groups: [{ name: "", choices: [{ value: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }, { value: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }] }] },
    ],
  } as AgentEvent;
  it("shows them as normal options in the model popover and changes them through set-config", async () => {
    const { host } = await withAgent((agent) => <AgentComposer agent={agent} brand={{ id: "gemini", name: "Gemini" }} label="Gemini" />);
    mocks.emit(config);
    await tick();
    click(host.querySelector("[aria-label^='Agent and model']"));
    await tick();
    const popover = host.querySelector("[role=dialog]")!;
    expect([...popover.querySelectorAll("[role=radiogroup]")].map((group) => group.getAttribute("aria-label"))).toEqual(["Model", "Mode"]);
    expect(text(popover)).toContain("Gemini 2.5 Flash");
    expect(text(popover)).toContain("YOLO");
    click([...popover.querySelectorAll("[role=radio]")].find((option) => option.textContent?.includes("Gemini 2.5 Flash")));
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "gemini-2.5-flash");
  });
});
