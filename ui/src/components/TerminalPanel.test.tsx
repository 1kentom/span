// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TerminalPanel, type TerminalController, type TerminalTransport, type TerminalHandlers } from "./TerminalPanel";

const xterm = vi.hoisted(() => ({
  instance: undefined as { cols: number; rows: number } | undefined,
  construct: vi.fn(), write: vi.fn(), dispose: vi.fn(), focus: vi.fn(), paste: vi.fn(), webgl: vi.fn(),
  data: undefined as ((data: string) => void) | undefined,
  binary: undefined as ((data: string) => void) | undefined,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; options = { theme: {} as Record<string, unknown>, fontSize: 13, fontFamily: "JetBrains Mono" };
  constructor(options: { theme: Record<string, unknown>; fontSize: number; fontFamily: string }) { Object.assign(this.options, options); xterm.instance = this; xterm.construct(this.options); }
  loadAddon() {} open() {} clear() {}
  write = xterm.write; dispose = xterm.dispose; focus = xterm.focus;
  getSelection() { return "selected terminal text"; } paste = xterm.paste;
  onData(callback: (data: string) => void) { xterm.data = callback; }
  onBinary(callback: (data: string) => void) { xterm.binary = callback; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {
  constructor() { xterm.webgl(); }
  onContextLoss() {} dispose() {}
} }));
const cleanup: (() => void)[] = [];
const observations: ResizeObserverCallback[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  xterm.write.mockReset();
  observations.length = 0;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { observations.push(callback); } observe() {} disconnect() {} });
});
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function mount(visible = true, embedded = false) {
  let handlers: TerminalHandlers | undefined;
  const runCommand = vi.fn(async (_code: string, _language: string): Promise<void> => undefined);
  const transport: TerminalTransport = {
    createCommand: vi.fn(async () => "command-1"),
    create: vi.fn(async (_cols, _rows, value) => { handlers = value; return "terminal-1"; }), write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const [shown, setShown] = createSignal(visible);
  const [fontSize, setFontSize] = createSignal(13); const [fontFamily, setFontFamily] = createSignal("JetBrains Mono");
  let controller: TerminalController | undefined;
  const root = document.createElement("div"); document.body.append(root);
  cleanup.push(render(() => <TerminalPanel onRunCommand={runCommand} fontSize={fontSize()} fontFamily={fontFamily()} visible={shown()} embedded={embedded} workspaceLabel="fixture" transport={transport} onReady={value => { controller = value; }} onHide={() => setShown(false)} />, root));
  return { transport, runCommand, root, setShown, setFontSize, setFontFamily, controller: () => controller, handlers: () => handlers! };
}

describe("terminal panel", () => {
  it("fits visible sessions and surfaces native resize errors while hidden sessions stay idle", async () => {
    const view = mount();
    Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    expect(view.transport.resize).not.toHaveBeenCalled();
    xterm.instance!.cols = 81; observations.at(-1)!([], {} as ResizeObserver);
    await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledWith("terminal-1", 81, 24));
    vi.mocked(view.transport.resize).mockRejectedValueOnce(new Error("Resize disconnected"));
    xterm.instance!.cols = 82;
    observations.at(-1)!([], {} as ResizeObserver);
    await vi.waitFor(() => expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Resize disconnected"));
    view.setShown(false); vi.mocked(view.transport.resize).mockClear();
    observations.at(-1)!([], {} as ResizeObserver);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(view.transport.resize).not.toHaveBeenCalled();
  });
  it("acknowledges native output only after xterm has consumed it", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    const acknowledge = vi.fn(); const bytes = new TextEncoder().encode("real PTY output 日本語");
    view.handlers().data(bytes, acknowledge);
    expect(xterm.write).toHaveBeenCalledWith(bytes, expect.any(Function)); expect(acknowledge).not.toHaveBeenCalled();
    xterm.write.mock.calls.at(-1)![1](); expect(acknowledge).toHaveBeenCalledOnce();
  });
  it("retains output and retryable input when closing the native session fails", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    vi.mocked(view.transport.close).mockRejectedValueOnce(new Error("Close denied"));
    await expect(view.controller()!.close()).rejects.toThrow("Close denied");
    const bytes = new Uint8Array([65]); view.handlers().data(bytes);
    expect(xterm.write).toHaveBeenCalledWith(bytes, undefined);
    xterm.data?.("printf still-connected\r");
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalled());
    expect(view.transport.write).toHaveBeenCalled();
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Close denied");
  });
  it("reports command and shell-exit failures without synthesizing terminal output", async () => {
    const view = mount(true, true); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    view.runCommand.mockRejectedValueOnce(new Error("PTY disconnected"));
    await expect(view.controller()!.send("printf explicit", true)).rejects.toThrow("PTY disconnected");
    expect(xterm.write).not.toHaveBeenCalled();
    view.handlers().exit(7);
    expect(view.root.textContent).toContain("Shell exited (7)");
    await expect(view.controller()!.send("printf after-exit", true)).rejects.toThrow("unavailable");
  });
  it("loads and spawns only once visible and never sends commands on render", async () => {
    const view = mount(false);
    await Promise.resolve();
    expect(view.transport.create).not.toHaveBeenCalled();
    expect(xterm.construct).not.toHaveBeenCalled();
    view.setShown(true);
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    expect(view.transport.create).toHaveBeenCalledTimes(1);
    expect(view.transport.write).not.toHaveBeenCalled();
    view.setShown(false); view.setShown(true);
    await Promise.resolve();
    expect(view.transport.create).toHaveBeenCalledTimes(1);
  });
  it("stages exact multiline Send without writing any PTY bytes until Run draft", async () => {
    const view = mount();
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    const code = "printf 'hello 日本語'\nprintf 'second'";
    await view.controller()!.send(code, false);
    expect(view.root.querySelector("textarea")?.value).toBe(code);
    expect(view.runCommand).not.toHaveBeenCalled();
    expect(view.transport.write).not.toHaveBeenCalled();
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.runCommand).toHaveBeenCalledTimes(1));
    expect(view.runCommand).toHaveBeenCalledWith(code, "shell");
    expect(view.transport.write).not.toHaveBeenCalled();
  });
  it("preserves a newer draft while Run is pending and submits only once", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let release!: () => void;
    view.runCommand.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await view.controller()!.send("printf first", false);
    const run = [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!;
    run.click(); run.click();
    await vi.waitFor(() => expect(view.runCommand).toHaveBeenCalledTimes(1));
    expect(run.disabled).toBe(true);
    const input = view.root.querySelector("textarea")!;
    input.value = "printf unsent"; input.dispatchEvent(new Event("input", { bubbles: true }));
    release();
    await vi.waitFor(() => expect(run.disabled).toBe(false));
    expect(view.root.querySelector("textarea")?.value).toBe("printf unsent");
    expect(view.runCommand).toHaveBeenCalledTimes(1);
    run.click();
    await vi.waitFor(() => expect(view.root.querySelector("textarea")).toBeNull());
    expect(view.runCommand).toHaveBeenLastCalledWith("printf unsent", "shell");
  });
  it("keeps replacement drafts and errors when a pending Run fails", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let reject!: (error: Error) => void;
    view.runCommand.mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    await view.controller()!.send("printf old", false);
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.runCommand).toHaveBeenCalledTimes(1));
    await view.controller()!.send("printf replacement", false);
    reject(new Error("Write disconnected"));
    await vi.waitFor(() => expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Write disconnected"));
    expect(view.root.querySelector("textarea")?.value).toBe("printf replacement");
  });
  it("does not focus a disposed terminal when a pending Run completes", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let release!: () => void;
    view.runCommand.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await view.controller()!.send("printf pending", false);
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.runCommand).toHaveBeenCalledTimes(1));
    cleanup.pop()!(); xterm.focus.mockClear(); release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(xterm.focus).not.toHaveBeenCalled();
  });
  it("routes explicit Run through command creation and preserves keyboard and binary input order", async () => {
    const view = mount();
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    await view.controller()!.send("printf 'x'\n", true, "bash");
    expect(view.runCommand).toHaveBeenCalledExactlyOnceWith("printf 'x'\n", "bash");
    expect(view.transport.write).not.toHaveBeenCalled();
    xterm.data?.("日本語"); xterm.binary?.("\xff\x80");
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(view.transport.write).mock.calls;
    expect(new TextDecoder().decode(calls[0][1])).toBe("日本語");
    expect([...calls[1][1]]).toEqual([255, 128]);
  });
  it("keeps Hide reversible and closes the owned process on unmount", async () => {
    const view = mount();
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    view.root.querySelector<HTMLButtonElement>('[aria-label="Hide terminal"]')!.click();
    expect(view.transport.close).not.toHaveBeenCalled();
    cleanup.pop()!();
    expect(view.transport.close).toHaveBeenCalledWith("terminal-1");
    expect(xterm.dispose).toHaveBeenCalledTimes(1);
    expect(view.controller()).toBeUndefined();
  });
});

it("preserves the early automatic DSR reply until create returns its session id", async () => {
  const view = mount();
  let release!: (id: string) => void;
  xterm.write.mockImplementation((bytes: Uint8Array, acknowledge?: () => void) => {
    if (new TextDecoder().decode(bytes) === "\x1b[6n") xterm.data?.("\x1b[1;1R");
    acknowledge?.();
  });
  vi.mocked(view.transport.create).mockImplementationOnce(async (_cols, _rows, handlers) => {
    handlers.data(new TextEncoder().encode("\x1b[6n"));
    return new Promise<string>(resolve => { release = resolve; });
  });
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  expect(view.controller()).toBeUndefined();
  expect(view.transport.write).not.toHaveBeenCalled();
  xterm.data?.("typed before ready"); xterm.binary?.("\xff");
  release("early-dsr-pty");
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(3));
  const calls = vi.mocked(view.transport.write).mock.calls;
  expect(calls.map(call => call[0])).toEqual(["early-dsr-pty", "early-dsr-pty", "early-dsr-pty"]);
  expect(new TextDecoder().decode(calls[0][1])).toBe("\x1b[1;1R");
  expect(new TextDecoder().decode(calls[1][1])).toBe("typed before ready");
  expect([...calls[2][1]]).toEqual([255]);
});

it("drops failed-create input and refuses callbacks from the old generation after restart", async () => {
  const view = mount(); let oldInput: ((data: string) => void) | undefined;
  vi.mocked(view.transport.create).mockImplementationOnce(async () => {
    oldInput = xterm.data; oldInput?.("never replay"); throw new Error("Create failed");
  });
  await vi.waitFor(() => expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Create failed"));
  expect(view.transport.write).not.toHaveBeenCalled();
  view.root.querySelector<HTMLButtonElement>('[aria-label="Start new shell"]')!.click();
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  oldInput?.("stale reply");
  xterm.data?.("printf fresh\r");
  await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledOnce());
  expect(view.transport.write).toHaveBeenCalledExactlyOnceWith("terminal-1", new TextEncoder().encode("printf fresh\r"));
  expect(view.root.querySelector('[role="alert"]')).toBeNull();
});
it("drops startup input on disposal and closes the late native session without writing", async () => {
  const view = mount(); let release!: (id: string) => void;
  vi.mocked(view.transport.create).mockImplementationOnce(async () => {
    xterm.data?.("old workspace input"); return new Promise<string>(resolve => { release = resolve; });
  });
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  cleanup.pop()!(); xterm.focus.mockClear(); release("late-old-session");
  await vi.waitFor(() => expect(view.transport.close).toHaveBeenCalledWith("late-old-session"));
  expect(view.transport.write).not.toHaveBeenCalled(); expect(xterm.focus).not.toHaveBeenCalled();
});
it("bounds startup input bytes and chunks while retaining accepted replies", async () => {
  const view = mount(); let release!: (id: string) => void;
  vi.mocked(view.transport.create).mockImplementationOnce(async () => new Promise<string>(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  xterm.data?.("x".repeat(64 * 1024 + 1));
  for (let index = 0; index < 257; index++) xterm.data?.("r");
  await vi.waitFor(() => expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("startup input limit"));
  release("bounded-session");
  await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(256));
  expect(vi.mocked(view.transport.write).mock.calls.every(([id, bytes]) => id === "bounded-session" && bytes.byteLength === 1)).toBe(true);
});

it("does not steal focus when a pending shell finishes after the panel is hidden", async () => {
  const view = mount(); let finish!: (id: string) => void;
  vi.mocked(view.transport.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  view.setShown(false); xterm.focus.mockClear(); finish("hidden-session");
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  expect(xterm.focus).not.toHaveBeenCalled(); expect(view.transport.close).not.toHaveBeenCalled();
  view.setShown(true); await vi.waitFor(() => expect(xterm.focus).toHaveBeenCalled());
  expect(view.transport.create).toHaveBeenCalledOnce();
});

it("does not surface a superseded resize failure after restarting the shell", async () => {
  const view = mount(); let reject!: (cause: Error) => void;
  Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
  vi.mocked(view.transport.resize).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  xterm.instance!.cols = 81; observations.at(-1)!([], {} as ResizeObserver);
  await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledOnce());
  view.handlers().exit(0);
  view.root.querySelector<HTMLButtonElement>('[aria-label="Start new shell"]')!.click();
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledTimes(2));
  reject(new Error("Old shell resize failed"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.root.querySelector('[role="alert"]')).toBeNull();
});

it("finishes an explicit draft without focusing a hidden terminal", async () => {
  const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
  let release!: () => void;
  view.runCommand.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  await view.controller()!.send("printf explicit", false);
  [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
  await vi.waitFor(() => expect(view.runCommand).toHaveBeenCalledOnce());
  view.setShown(false); xterm.focus.mockClear(); release();
  await vi.waitFor(() => expect(view.root.querySelector("textarea")).toBeNull());
  expect(xterm.focus).not.toHaveBeenCalled(); expect(view.transport.close).not.toHaveBeenCalled();
});


it("updates editor font settings in the renderer without respawning or stealing focus", async () => {
  const view = mount(); Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  expect(view.transport.resize).not.toHaveBeenCalled(); xterm.focus.mockClear();
  view.setFontSize(18); view.setFontFamily("SFMono-Regular");
  await vi.waitFor(() => expect(xterm.construct.mock.calls[0][0]).toMatchObject({ fontSize: 18, fontFamily: '"SFMono-Regular", monospace' }));
  expect(view.transport.create).toHaveBeenCalledOnce(); expect(view.transport.close).not.toHaveBeenCalled(); expect(xterm.focus).not.toHaveBeenCalled();
});

it("applies hidden-session themes and fonts without waiting for an animation frame", async () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let background = "#18191b";
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (token: string) => token === "--island" ? background : "" }));
  const view = mount(); view.root.className = "ide theme-dark";
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  const options = xterm.construct.mock.calls[0][0];
  expect(options.theme.background).toBe("#18191b");
  view.setShown(false); xterm.focus.mockClear();
  background = "#ffffff"; view.root.className = "ide theme-light";
  await vi.waitFor(() => expect(options.theme.background).toBe("#ffffff"));
  background = "#1c1929"; view.root.className = "ide theme-purple";
  await vi.waitFor(() => expect(options.theme.background).toBe("#1c1929"));
  view.setFontSize(18); view.setFontFamily("Menlo");
  await vi.waitFor(() => expect(options).toMatchObject({ fontSize: 18, fontFamily: '"Menlo", monospace' }));
  expect(view.transport.resize).not.toHaveBeenCalled();
  expect(view.transport.create).toHaveBeenCalledOnce();
  expect(view.transport.close).not.toHaveBeenCalled();
  expect(xterm.focus).not.toHaveBeenCalled();
  const acknowledge = vi.fn();
  const bytes = new TextEncoder().encode("retained real PTY output 日本語");
  view.handlers().data(bytes, acknowledge);
  expect(xterm.write).toHaveBeenLastCalledWith(bytes, acknowledge);
  expect(acknowledge).not.toHaveBeenCalled();
  xterm.write.mock.calls.at(-1)![1]();
  expect(acknowledge).toHaveBeenCalledOnce();
  view.setShown(true);
  expect(view.transport.create).toHaveBeenCalledOnce();
  expect(xterm.focus).toHaveBeenCalledOnce();
});

it.each([
  [true, "MacIntel", false], [true, "MacARM", false],
  [true, "Win32", true], [true, "Linux x86_64", true], [false, "MacIntel", true],
])("selects the renderer for native=%s platform=%s without changing PTY input/output", async (native, platform, webgl) => {
  vi.stubGlobal("WebGL2RenderingContext", class {});
  if (native) vi.stubGlobal("__TAURI_INTERNALS__", {});
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  try {
    const view = mount();
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    expect(xterm.webgl).toHaveBeenCalledTimes(webgl ? 1 : 0);
    const bytes = new TextEncoder().encode("real PTY output 日本語🌱"); const acknowledge = vi.fn();
    view.handlers().data(bytes, acknowledge);
    expect(xterm.write).toHaveBeenLastCalledWith(bytes, acknowledge);
    xterm.write.mock.calls.at(-1)![1]();
    expect(acknowledge).toHaveBeenCalledOnce();
    xterm.data?.("printf explicit\r");
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledOnce());
    expect(view.transport.write).toHaveBeenCalledExactlyOnceWith("terminal-1", new TextEncoder().encode("printf explicit\r"));
  } finally { platformSpy.mockRestore(); }
});

it("sends SIGWINCH through native resize only when logical rows or columns change", async () => {
  const view = mount(); Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  for (let index = 0; index < 20; index++) observations.at(-1)!([], {} as ResizeObserver);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(view.transport.resize).not.toHaveBeenCalled();
  xterm.instance!.cols = 100; xterm.instance!.rows = 30;
  observations.at(-1)!([], {} as ResizeObserver);
  await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledExactlyOnceWith("terminal-1", 100, 30));
  view.setShown(false); view.setFontFamily("Menlo"); view.setShown(true);
  for (let index = 0; index < 20; index++) observations.at(-1)!([], {} as ResizeObserver);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(view.transport.resize).toHaveBeenCalledOnce();
  xterm.instance!.rows = 31; observations.at(-1)!([], {} as ResizeObserver);
  await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledTimes(2));
  expect(view.transport.resize).toHaveBeenLastCalledWith("terminal-1", 100, 31);
});

it("serializes native resizes and coalesces pending layouts to the latest dimensions", async () => {
  const view = mount(); Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
  await vi.waitFor(() => expect(view.controller()).toBeDefined());
  let release!: () => void;
  vi.mocked(view.transport.resize).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  xterm.instance!.cols = 100; observations.at(-1)!([], {} as ResizeObserver);
  await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledExactlyOnceWith("terminal-1", 100, 24));
  xterm.instance!.cols = 110; observations.at(-1)!([], {} as ResizeObserver);
  await new Promise(resolve => setTimeout(resolve, 30));
  xterm.instance!.cols = 120; xterm.instance!.rows = 30; observations.at(-1)!([], {} as ResizeObserver);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(view.transport.resize).toHaveBeenCalledOnce();
  release();
  await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledTimes(2));
  expect(view.transport.resize).toHaveBeenLastCalledWith("terminal-1", 120, 30);
  observations.at(-1)!([], {} as ResizeObserver);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(view.transport.resize).toHaveBeenCalledTimes(2);
});
