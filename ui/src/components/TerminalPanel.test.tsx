// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TerminalPanel, type TerminalController, type TerminalTransport } from "./TerminalPanel";

const xterm = vi.hoisted(() => ({
  construct: vi.fn(), write: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
  data: undefined as ((data: string) => void) | undefined,
  binary: undefined as ((data: string) => void) | undefined,
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  constructor() { xterm.construct(); }
  loadAddon() {} open() {} clear() {}
  write = xterm.write; dispose = xterm.dispose; focus = xterm.focus;
  onData(callback: (data: string) => void) { xterm.data = callback; }
  onBinary(callback: (data: string) => void) { xterm.binary = callback; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function mount(visible = true) {
  const transport: TerminalTransport = {
    create: vi.fn(async () => "terminal-1"), write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
  };
  const [shown, setShown] = createSignal(visible);
  let controller: TerminalController | undefined;
  const root = document.createElement("div"); document.body.append(root);
  cleanup.push(render(() => <TerminalPanel visible={shown()} workspaceLabel="fixture" transport={transport} onReady={value => { controller = value; }} onHide={() => setShown(false)} />, root));
  return { transport, root, setShown, controller: () => controller };
}

describe("terminal panel", () => {
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
