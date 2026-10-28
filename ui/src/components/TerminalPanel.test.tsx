// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TerminalPanel, type TerminalController, type TerminalTransport, type TerminalHandlers } from "./TerminalPanel";

const xterm = vi.hoisted(() => ({
  construct: vi.fn(), write: vi.fn(), dispose: vi.fn(), focus: vi.fn(), paste: vi.fn(),
  data: undefined as ((data: string) => void) | undefined,
  binary: undefined as ((data: string) => void) | undefined,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  constructor() { xterm.construct(); }
  loadAddon() {} open() {} clear() {}
  write = xterm.write; dispose = xterm.dispose; focus = xterm.focus;
  getSelection() { return "selected terminal text"; } paste = xterm.paste;
  onData(callback: (data: string) => void) { xterm.data = callback; }
  onBinary(callback: (data: string) => void) { xterm.binary = callback; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
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
  const transport: TerminalTransport = {
    create: vi.fn(async (_cols, _rows, value) => { handlers = value; return "terminal-1"; }), write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const [shown, setShown] = createSignal(visible);
  let controller: TerminalController | undefined;
  const root = document.createElement("div"); document.body.append(root);
  cleanup.push(render(() => <TerminalPanel visible={shown()} embedded={embedded} workspaceLabel="fixture" transport={transport} onReady={value => { controller = value; }} onHide={() => setShown(false)} />, root));
  return { transport, root, setShown, controller: () => controller, handlers: () => handlers! };
}

describe("terminal panel", () => {
  it("fits visible sessions and surfaces native resize errors while hidden sessions stay idle", async () => {
    const view = mount();
    Object.defineProperty(view.root.querySelector(".terminal-host"), "clientWidth", { value: 640 });
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    await vi.waitFor(() => expect(view.transport.resize).toHaveBeenCalledWith("terminal-1", 80, 24));
    vi.mocked(view.transport.resize).mockRejectedValueOnce(new Error("Resize disconnected"));
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
    await view.controller()!.send("printf still-connected", true);
    expect(view.transport.write).toHaveBeenCalled();
    expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Close denied");
  });
  it("reports write and shell-exit failures without synthesizing terminal output", async () => {
    const view = mount(true, true); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    vi.mocked(view.transport.write).mockRejectedValueOnce(new Error("PTY disconnected"));
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
    expect(view.transport.write).not.toHaveBeenCalled();
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(1));
    expect(new TextDecoder().decode(vi.mocked(view.transport.write).mock.calls[0][1])).toBe(`${code}\r`);
  });
  it("preserves a newer draft while Run is pending and submits only once", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let release!: () => void;
    vi.mocked(view.transport.write).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await view.controller()!.send("printf first", false);
    const run = [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!;
    run.click(); run.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(1));
    expect(run.disabled).toBe(true);
    const input = view.root.querySelector("textarea")!;
    input.value = "printf unsent"; input.dispatchEvent(new Event("input", { bubbles: true }));
    release();
    await vi.waitFor(() => expect(run.disabled).toBe(false));
    expect(view.root.querySelector("textarea")?.value).toBe("printf unsent");
    expect(view.transport.write).toHaveBeenCalledTimes(1);
    run.click();
    await vi.waitFor(() => expect(view.root.querySelector("textarea")).toBeNull());
    expect(new TextDecoder().decode(vi.mocked(view.transport.write).mock.calls[1][1])).toBe("printf unsent\r");
  });
  it("keeps replacement drafts and errors when a pending Run fails", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let reject!: (error: Error) => void;
    vi.mocked(view.transport.write).mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    await view.controller()!.send("printf old", false);
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(1));
    await view.controller()!.send("printf replacement", false);
    reject(new Error("Write disconnected"));
    await vi.waitFor(() => expect(view.root.querySelector('[role="alert"]')?.textContent).toContain("Write disconnected"));
    expect(view.root.querySelector("textarea")?.value).toBe("printf replacement");
  });
  it("does not focus a disposed terminal when a pending Run completes", async () => {
    const view = mount(); await vi.waitFor(() => expect(view.controller()).toBeDefined());
    let release!: () => void;
    vi.mocked(view.transport.write).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await view.controller()!.send("printf pending", false);
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(1));
    cleanup.pop()!(); xterm.focus.mockClear(); release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(xterm.focus).not.toHaveBeenCalled();
  });
  it("writes explicit Run exactly, adds Enter once, and preserves binary and keyboard order", async () => {
    const view = mount();
    await vi.waitFor(() => expect(view.controller()).toBeDefined());
    await view.controller()!.send("printf 'x'\n", true);
    xterm.data?.("日本語"); xterm.binary?.("\xff\x80");
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(view.transport.write).mock.calls;
    expect(new TextDecoder().decode(calls[0][1])).toBe("printf 'x'\n");
    expect(new TextDecoder().decode(calls[1][1])).toBe("日本語");
    expect([...calls[2][1]]).toEqual([255, 128]);
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
  await view.controller()!.send("printf fresh", true);
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
