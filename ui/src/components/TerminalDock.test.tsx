// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JSX, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TerminalDock, type TerminalDockController } from "./TerminalDock";
import type { TerminalTransport } from "./TerminalPanel";
import { MarkdownPreview } from "./MarkdownPreview";

const xterm = vi.hoisted(() => ({ paste: vi.fn(), focus: vi.fn(), dispose: vi.fn() }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; options = { theme: {} };
  loadAddon() {} open() {} clear() {} write() {} onData() {} onBinary() {}
  focus = xterm.focus; dispose = xterm.dispose; paste = xterm.paste;
  getSelection() { return "selected bytes"; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
const disposers: (() => void)[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function mount(visible = false, headerStart?: JSX.Element) {
  let next = 0; const transport: TerminalTransport = { create: vi.fn(async () => `pty-${++next}`), write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined) };
  const clipboard = { readText: vi.fn(async () => "pasted text"), writeText: vi.fn(async () => undefined) };
  const [shown, setShown] = createSignal(visible); let dock: TerminalDockController | undefined;
  const root = document.createElement("div"); document.body.append(root);
  const dispose = render(() => <TerminalDock headerStart={headerStart} visible={shown()} workspaceRoot="/workspace" transport={transport} clipboard={clipboard} onReveal={() => setShown(true)} onHide={() => setShown(false)} onReady={value => { dock = value; }} />, root);
  disposers.push(dispose);
  const button = (label: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  return { root, transport, clipboard, dock: () => dock!, shown, setShown, button, dispose };
}

describe("terminal dock integration", () => {
  it("routes real Markdown Run and inferred Send buttons to the native transport fixture", async () => {
    const view = mount(); const preview = document.createElement("div"); document.body.append(preview);
    disposers.push(render(() => <MarkdownPreview text={"```bash\nprintf 'hello'\n```\n\n```\nnpm run dev\n```"} documentPath="/workspace/README.md" workspaceRoot="/workspace" onRunCode={request => view.dock().send(request.code, request.action === "run" && !request.detected)} />, preview));
    await vi.waitFor(() => expect(preview.querySelector('[aria-label="Run code in terminal"]')).not.toBeNull());
    preview.querySelector<HTMLButtonElement>('[aria-label="Run code in terminal"]')!.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(vi.mocked(view.transport.write).mock.calls[0][1])).toBe("printf 'hello'\r");
    preview.querySelector<HTMLButtonElement>('[aria-label="Send code to terminal for review"]')!.click();
    await vi.waitFor(() => expect(view.root.querySelector("textarea")?.value).toBe("npm run dev"));
    expect(view.transport.create).toHaveBeenCalledTimes(2); expect(view.transport.write).toHaveBeenCalledOnce();
    expect(preview.textContent).toContain("Staged in terminal");
  });
  it("creates one fresh shell and stages exact Markdown Send content without PTY input", async () => {
    const view = mount(); const code = "printf '日本語'\nprintf 'second line'\n";
    await view.dock().send(code, false);
    expect(view.transport.create).toHaveBeenCalledTimes(1); expect(view.root.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(view.root.querySelector("textarea")?.value).toBe(code); expect(view.transport.write).not.toHaveBeenCalled();
    expect(view.root.textContent).toContain("Working directory: /workspace");
    [...view.root.querySelectorAll("button")].find(button => button.textContent === "Run draft")!.click();
    await vi.waitFor(() => expect(view.transport.write).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(vi.mocked(view.transport.write).mock.calls[0][1])).toBe(code);
  });
  it("keeps shell tabs alive across hide and selection, and closes their real session IDs", async () => {
    const view = mount(true); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
    view.button("New terminal").click(); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledTimes(2));
    view.root.querySelector<HTMLButtonElement>('[role="tab"]')!.click(); view.setShown(false); view.setShown(true);
    await Promise.resolve(); expect(view.transport.create).toHaveBeenCalledTimes(2); expect(view.transport.close).not.toHaveBeenCalled();
    view.button("Close shell 1").click(); await vi.waitFor(() => expect(view.transport.close).toHaveBeenCalledWith("pty-1"));
    await vi.waitFor(() => expect(view.root.querySelectorAll('[role="tab"]')).toHaveLength(1));
    view.button("Close shell 2").click(); await vi.waitFor(() => expect(view.shown()).toBe(false));
    expect(view.transport.close).toHaveBeenCalledWith("pty-2"); expect(view.root.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });
  it("copies actual terminal selection and refuses a delayed paste after the active tab changes", async () => {
    const view = mount(true); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
    view.button("Copy terminal selection").click(); await vi.waitFor(() => expect(view.clipboard.writeText).toHaveBeenCalledWith("selected bytes"));
    let finish!: (text: string) => void; view.clipboard.readText.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.button("Paste into terminal").click(); await vi.waitFor(() => expect(view.clipboard.readText).toHaveBeenCalled());
    view.button("New terminal").click(); finish("do not paste into another shell");
    await vi.waitFor(() => expect(view.root.textContent).toContain("Terminal changed before paste completed")); expect(xterm.paste).not.toHaveBeenCalled();
  });
  it("rejects Markdown execution when its workspace disappears and closes a late-created orphan PTY", async () => {
    const view = mount(); let finish!: (id: string) => void;
    vi.mocked(view.transport.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const command = view.dock().send("printf explicit", true); const rejected = expect(command).rejects.toThrow("workspace was closed");
    await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalled()); view.dispose(); disposers.pop(); await rejected;
    finish("late-pty"); await vi.waitFor(() => expect(view.transport.close).toHaveBeenCalledWith("late-pty")); expect(view.transport.write).not.toHaveBeenCalled();
  });
});

it("navigates terminal tabs by keyboard with linked panels and a single tab stop", async () => {
  const view = mount(true); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  view.button("New terminal").click(); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledTimes(2));
  const tabs = [...view.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0]);
  tabs[1].focus(); tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(document.activeElement).toBe(tabs[0]); expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  const panel = view.root.querySelector(`[id="${tabs[0].getAttribute("aria-controls")}"]`)!;
  expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
  tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  expect(document.activeElement).toBe(tabs[1]); expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0]);
  tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(document.activeElement).toBe(tabs[0]);
  expect(view.transport.create).toHaveBeenCalledTimes(2); expect(view.transport.close).not.toHaveBeenCalled();
});

it("interrupts the selected native shell without closing other sessions", async () => {
  const view = mount(true); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  view.button("New terminal").click(); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledTimes(2));
  view.button("Interrupt command").click();
  await vi.waitFor(() => expect(view.transport.interrupt).toHaveBeenLastCalledWith("pty-2"));
  view.root.querySelector<HTMLButtonElement>('[role="tab"]')!.click();
  view.button("Interrupt command").click();
  await vi.waitFor(() => expect(view.transport.interrupt).toHaveBeenLastCalledWith("pty-1"));
  expect(view.transport.close).not.toHaveBeenCalled(); expect(view.transport.write).not.toHaveBeenCalled();
});


it("keeps shared view controls outside the shell tablist and preserves shell roving focus", async () => {
  const view = mount(true, <div role="tablist" aria-label="Output views"><button role="tab" aria-selected="true">Terminal</button><button role="tab" aria-selected="false">Run</button></div>);
  await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledOnce());
  const header = view.root.querySelector(".terminal-dock-toolbar")!;
  expect(header.firstElementChild?.getAttribute("aria-label")).toBe("Output views");
  const sessions = header.querySelector('[aria-label="Terminal sessions"]')!;
  expect(sessions.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(sessions.textContent).not.toContain("Run");
  view.button("New terminal").click(); await vi.waitFor(() => expect(view.transport.create).toHaveBeenCalledTimes(2));
  const tabs = [...sessions.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabs[1].focus(); tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(document.activeElement).toBe(tabs[0]); expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1]);
  expect(header.firstElementChild?.querySelector('[aria-selected="true"]')?.textContent).toBe("Terminal");
  expect(view.transport.close).not.toHaveBeenCalled();
});
