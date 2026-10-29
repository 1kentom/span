// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentPanel } from "./AgentPanel";
import type { DroppedPath } from "../lib/native-drop";
const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  registry: vi.fn(),
  remove: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  install: vi.fn(),
  onEvent: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  setConfig: vi.fn(),
  listSessions: vi.fn(),
  resumeSession: vi.fn(),
  newSession: vi.fn(),
  openBuffer: vi.fn(),
  invoke: vi.fn(),
  dragHandler: undefined as undefined | ((event: { payload: unknown }) => void),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async (handler: (event: { payload: unknown }) => void) => { mocks.dragHandler = handler; return () => { mocks.dragHandler = undefined; }; } }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("../lib/client", () => ({
  isDesktop: true,
  api: {
    agentInstalled: mocks.installed,
    agentRegistry: mocks.registry,
    agentRemove: mocks.remove,
    agentConnect: mocks.connect,
    agentDisconnect: mocks.disconnect,
    agentInstall: mocks.install,
    onAgentEvent: mocks.onEvent,
    agentPrompt: mocks.prompt,
    agentCancel: mocks.cancel,
    agentSetConfig: mocks.setConfig,
    agentListSessions: mocks.listSessions,
    agentResumeSession: mocks.resumeSession,
    agentNewSession: mocks.newSession,
    writeClipboard: vi.fn(async () => undefined),
    openBuffer: mocks.openBuffer,
    readImage: vi.fn(async () => ({ dataUrl: "" })),
  },
  agentPresets: vi.fn(async () => []),
  agentAuthenticateWith: vi.fn(async () => ""),
  agentChildPermission: vi.fn(async () => undefined),
  agentCancelTask: vi.fn(async () => undefined),
  agentDelegationStatus: vi.fn(async () => ({ enabled: false, available: false, reason: null, lead: null, attached: false, tasks: [], decisions: [] })),
}));
const disposers: (() => void)[] = [];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); for (let i = 0; i < 8; i++) await Promise.resolve(); };
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** Paths the fake drop handed to Rust: only these may be inspected or read. */
let dropped: Record<string, DroppedPath & { bytes?: Uint8Array }> = {};
const enc = new TextEncoder();
function fakeDrop(entries: (DroppedPath & { bytes?: Uint8Array })[]) { dropped = Object.fromEntries(entries.map((entry) => [entry.path, entry])); }
function mount(props: { dropHover?: boolean; capture?: (attach: (paths: { path: string; isDir: boolean }[]) => void) => void } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const [hover, setHover] = createSignal(props.dropHover ?? false);
  const folderOutline = vi.fn(async (path: string) => ({ text: `${path}/\n  a.ts`, files: 1, truncated: false }));
  disposers.push(render(() => <AgentPanel workspacePath="/w/proj" removeAgent={mocks.remove} folderOutline={folderOutline} dropHover={hover()} onAttachReady={props.capture} />, root));
  // The panel occupies the right side of a 1400 px wide window: CSS x 1000 to 1400.
  root.querySelector<HTMLElement>(".agent-panel")!.getBoundingClientRect = () => box(1000, 0, 400, 900);
  const tiles = () => [...root.querySelectorAll<HTMLElement>(".att-tile")];
  const names = () => tiles().map((tile) => tile.querySelector(".att-tile-name")?.textContent);
  const overlay = () => root.querySelector(".att-drop");
  return { root, tiles, names, overlay, setHover, folderOutline };
}
/** Sends a Tauri drag-drop payload with physical pixels, on a 2x display. */
const native = (payload: Record<string, unknown>) => mocks.dragHandler!({ payload });
beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.installed.mockResolvedValue([]);
  mocks.registry.mockResolvedValue([]);
  mocks.onEvent.mockResolvedValue(() => undefined);
  mocks.listSessions.mockResolvedValue([]);
  dropped = {};
  mocks.invoke.mockImplementation(async (command: string, args: { path: string; maxBytes?: number }) => {
    const entry = dropped[args?.path];
    if (command === "dropped_path_info") { if (!entry) throw new Error("Only items from the latest drop can be read"); const { bytes: _bytes, ...info } = entry; return info; }
    if (command === "read_dropped_file") {
      if (!entry || entry.isDir) throw new Error("Only items from the latest drop can be read");
      let binary = ""; for (const byte of entry.bytes ?? []) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    return undefined;
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
const readCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "read_dropped_file").map(([, args]) => (args as { path: string }).path);

describe("native drops on the agent panel", () => {
  it("shows the full panel overlay only while files hover the panel", async () => {
    const view = mount(); await flush();
    expect(mocks.dragHandler).toBeDefined();
    native({ type: "enter", paths: ["/elsewhere/a.png"], position: { x: 2200, y: 400 } }); await flush();
    expect(view.overlay()?.textContent).toContain("Drop to attach");
    // Physical x 1800 is CSS x 900: over the editor, not the panel.
    native({ type: "over", position: { x: 1800, y: 400 } }); await flush();
    expect(view.overlay()).toBeNull();
    native({ type: "over", position: { x: 2600, y: 400 } }); await flush();
    expect(view.overlay()).not.toBeNull();
    native({ type: "leave" }); await flush();
    expect(view.overlay()).toBeNull();
  });
  it("embeds several dropped files as attachment chips with name, size and a remove button", async () => {
    const view = mount(); await flush();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    fakeDrop([
      { path: "/elsewhere/shot.png", name: "shot.png", isDir: false, size: png.length, bytes: png },
      { path: "/elsewhere/notes.txt", name: "notes.txt", isDir: false, size: 11, bytes: enc.encode("hello\nworld") },
    ]);
    native({ type: "drop", paths: ["/elsewhere/shot.png", "/elsewhere/notes.txt"], position: { x: 2400, y: 1000 } }); await flush(); await flush();
    expect(view.names()).toEqual(["shot.png", "notes.txt"]);
    expect(view.tiles()[0].dataset.kind).toBe("image");
    expect(view.tiles()[1].querySelector(".att-tile-meta")?.textContent).toMatch(/11 B|2 lines/);
    expect(view.root.querySelector('[aria-label="Remove notes.txt"]')).not.toBeNull();
    expect(readCalls().sort()).toEqual(["/elsewhere/notes.txt", "/elsewhere/shot.png"]);
    expect(view.overlay()).toBeNull();
  });
  it("turns a workspace file into a workspace chip by relative path, with its content", async () => {
    const view = mount(); await flush();
    fakeDrop([{ path: "/w/proj/src/main.ts", name: "main.ts", isDir: false, size: 9, bytes: enc.encode("let a = 1") }]);
    native({ type: "drop", paths: ["/w/proj/src/main.ts"], position: { x: 2100, y: 300 } }); await flush(); await flush();
    expect(view.names()).toEqual(["main.ts"]);
    expect(view.tiles()[0].getAttribute("title")).toBe("main.ts");
  });
  it("attaches a dropped folder outside the project as a path mention without listing or reading it", async () => {
    const view = mount(); await flush();
    fakeDrop([{ path: "/elsewhere/assets", name: "assets", isDir: true, size: 0 }]);
    native({ type: "drop", paths: ["/elsewhere/assets"], position: { x: 2100, y: 300 } }); await flush(); await flush();
    expect(view.names()).toEqual(["assets"]);
    expect(view.tiles()[0].dataset.kind).toBe("folder");
    expect(readCalls()).toEqual([]);
    expect(view.folderOutline).not.toHaveBeenCalled();
  });
  it("outlines a dropped folder inside the project with the existing folder outline", async () => {
    const view = mount(); await flush();
    fakeDrop([{ path: "/w/proj/src", name: "src", isDir: true, size: 0 }]);
    native({ type: "drop", paths: ["/w/proj/src"], position: { x: 2100, y: 300 } }); await flush(); await flush();
    expect(view.folderOutline).toHaveBeenCalledWith("src", expect.any(Number));
    expect(view.names()).toEqual(["src"]);
  });
  it("ignores drops that land outside the panel", async () => {
    const view = mount(); await flush();
    fakeDrop([{ path: "/elsewhere/notes.txt", name: "notes.txt", isDir: false, size: 2, bytes: enc.encode("hi") }]);
    native({ type: "drop", paths: ["/elsewhere/notes.txt"], position: { x: 600, y: 300 } }); await flush(); await flush();
    expect(view.tiles()).toHaveLength(0);
    expect(mocks.invoke).not.toHaveBeenCalledWith("dropped_path_info", expect.anything());
  });
});

describe("Span's own drags onto the agent panel", () => {
  it("shows the overlay while an Explorer row or tab hovers the panel", async () => {
    const view = mount(); await flush();
    expect(view.overlay()).toBeNull();
    view.setHover(true); await flush();
    expect(view.overlay()?.textContent).toContain("Drop to attach");
  });
  it("attaches Explorer files with their text and folders as outlines", async () => {
    let attach: ((paths: { path: string; isDir: boolean }[]) => void) | undefined;
    mocks.openBuffer.mockResolvedValue({ path: "src/a.ts", text: "export const a = 1;\n", revision: 1, savedRevision: 1, language: "typescript" });
    const view = mount({ capture: (fn) => { attach = fn; } }); await flush();
    attach!([{ path: "src/a.ts", isDir: false }, { path: "src", isDir: true }]); await flush(); await flush();
    expect(mocks.openBuffer).toHaveBeenCalledWith("src/a.ts");
    expect(view.folderOutline).toHaveBeenCalledWith("src", expect.any(Number));
    expect(view.names()).toEqual(["src", "a.ts"]);
    expect(mocks.invoke).not.toHaveBeenCalledWith("read_dropped_file", expect.anything());
  });
});

describe("HTML drops on the agent panel", () => {
  const drop = (target: Element, data: Record<string, string>, type = "drop") => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: Object.keys(data), files: [], items: [], getData: (key: string) => data[key] ?? "", dropEffect: "none" } });
    target.dispatchEvent(event);
    return event;
  };
  it("inserts short dragged text into the prompt when dropped on the panel", async () => {
    const view = mount(); await flush();
    const header = view.root.querySelector(".agent-header")!;
    expect(drop(header, { "text/plain": "fixture" }, "dragover").defaultPrevented).toBe(true);
    expect(drop(header, { "text/plain": "selected code" }).defaultPrevented).toBe(true);
    await flush();
    expect(view.root.querySelector<HTMLTextAreaElement>("#agent-prompt")!.value).toBe("selected code");
  });
  it("leaves short text dropped on the prompt box to the browser, at the drop position", async () => {
    const view = mount(); await flush();
    const prompt = view.root.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
    expect(drop(prompt, { "text/plain": "short" }).defaultPrevented).toBe(false);
  });
  it("attaches long dragged text as a snippet chip", async () => {
    const view = mount(); await flush();
    const prompt = view.root.querySelector<HTMLTextAreaElement>("#agent-prompt")!;
    expect(drop(prompt, { "text/plain": "line\n".repeat(40) }).defaultPrevented).toBe(true);
    await flush();
    expect(view.names()).toEqual(["Pasted text, 41 lines"]);
  });
  it("attaches an image dragged as a data URL", async () => {
    const view = mount(); await flush();
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect(drop(view.root.querySelector(".agent-header")!, { "text/uri-list": `data:image/png;base64,${pixel}` }).defaultPrevented).toBe(true);
    await flush(); await flush();
    expect(view.names()).toEqual(["Dropped image.png"]);
    expect(view.tiles()[0].dataset.kind).toBe("image");
  });
});
