import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEvent, TerminalInfo } from "../bindings";
import type { TerminalHandlers } from "../components/TerminalPanel";

const native = vi.hoisted(() => ({ create: vi.fn(), createCommand: vi.fn(), profiles: vi.fn(), write: vi.fn(), resize: vi.fn(), interrupt: vi.fn(), close: vi.fn(), acknowledge: vi.fn(), channels: [] as { onmessage?: (event: TerminalEvent) => void }[] }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage?: (event: TerminalEvent) => void; constructor() { native.channels.push(this); } } }));
vi.mock("./client", () => ({ isDesktop: true, api: { terminalCreate: native.create, terminalCreateCommand: native.createCommand, terminalProfiles: native.profiles, terminalWrite: native.write, terminalResize: native.resize, terminalInterrupt: native.interrupt, terminalClose: native.close, terminalAcknowledge: native.acknowledge } }));
import { createTerminalTransport } from "./terminal-transport";

const info: TerminalInfo = { id: "epoch1:pty1", cwd: "/workspace", shell: "/bin/sh", cols: 80, rows: 24, processId: 123, exitCode: null, exited: false };
beforeEach(() => { vi.resetAllMocks(); native.channels.length = 0; native.create.mockResolvedValue(info); native.createCommand.mockResolvedValue(info); native.profiles.mockResolvedValue([]); native.write.mockResolvedValue(undefined); native.resize.mockResolvedValue(undefined); native.interrupt.mockResolvedValue(undefined); native.close.mockResolvedValue(undefined); native.acknowledge.mockResolvedValue(undefined); });
const handlers = (): TerminalHandlers => ({ data: vi.fn(), exit: vi.fn(), error: vi.fn() });

describe("generated native terminal adapter", () => {
  it("subscribes before spawning and acknowledges each output sequence exactly once after rendering", async () => {
    const callbacks = handlers();
    native.create.mockImplementationOnce(async (_cwd, _cols, _rows, channel) => { channel.onmessage({ kind: "output", id: info.id, data: [65, 0, 255], sequence: 7 }); return info; });
    const transport = createTerminalTransport("/workspace"); expect(await transport.create(80, 24, callbacks)).toBe(info.id);
    expect(native.create).toHaveBeenCalledWith("/workspace", 80, 24, native.channels[0], undefined);
    expect(callbacks.data).toHaveBeenCalledWith(new Uint8Array([65, 0, 255]), expect.any(Function)); expect(native.acknowledge).not.toHaveBeenCalled();
    const complete = vi.mocked(callbacks.data).mock.calls[0][1]!; complete(); complete();
    expect(native.acknowledge).toHaveBeenCalledExactlyOnceWith(info.id, 7);
  });
  it("preserves byte input and dimensions through the typed IPC port", async () => {
    const transport = createTerminalTransport("/workspace"); await transport.create(80, 24, handlers());
    const bytes = new Uint8Array([27, 91, 65, 255]); await transport.write(info.id, bytes); await transport.resize(info.id, 120, 42); await transport.interrupt(info.id);
    expect(native.write).toHaveBeenCalledWith(info.id, bytes); expect(native.resize).toHaveBeenCalledWith(info.id, 120, 42); expect(native.interrupt).toHaveBeenCalledWith(info.id);
  });
  it("retains callbacks if closing fails and discards late events after successful close", async () => {
    const transport = createTerminalTransport("/workspace"); const callbacks = handlers(); await transport.create(80, 24, callbacks);
    native.close.mockRejectedValueOnce(new Error("Close failed")); await expect(transport.close(info.id)).rejects.toThrow("Close failed");
    native.channels[0].onmessage!({ kind: "output", id: info.id, data: [66], sequence: 1 }); expect(callbacks.data).toHaveBeenCalledOnce();
    await transport.close(info.id);
    native.channels[0].onmessage!({ kind: "output", id: info.id, data: [67], sequence: 2 });
    native.channels[0].onmessage!({ kind: "exit", id: info.id, code: 0 });
    expect(callbacks.data).toHaveBeenCalledOnce(); expect(callbacks.exit).not.toHaveBeenCalled(); expect(native.acknowledge).toHaveBeenCalledWith(info.id, 2);
  });
  it("reports exit and transport failures without converting them into terminal output", async () => {
    const transport = createTerminalTransport("/workspace"); const callbacks = handlers(); await transport.create(80, 24, callbacks);
    native.channels[0].onmessage!({ kind: "error", id: info.id, message: "PTY read failed" }); native.channels[0].onmessage!({ kind: "exit", id: info.id, code: 9 });
    expect(callbacks.error).toHaveBeenCalledWith("PTY read failed"); expect(callbacks.exit).toHaveBeenCalledWith(9); expect(callbacks.data).not.toHaveBeenCalled();
  });
});

it("creates command PTYs with literal source and workspace guard, preserving early output and exit", async () => {
  const callbacks = { ...handlers(), started: vi.fn() };
  const source = "printf '%s\\n' '日本語🌱'\nprintf '%s\\n' 'quoted \"value\"'\n";
  native.createCommand.mockImplementationOnce(async (_language, _source, _root, _cols, _rows, channel) => {
    channel.onmessage({ kind: "output", id: info.id, data: [65], sequence: 1 });
    channel.onmessage({ kind: "exit", id: info.id, code: 7 });
    return info;
  });
  const transport = createTerminalTransport("/workspace");
  expect(await transport.createCommand(80, 24, callbacks, "bash", source)).toBe(info.id);
  expect(native.createCommand).toHaveBeenCalledExactlyOnceWith("bash", source, "/workspace", 80, 24, native.channels[0]);
  expect(native.create).not.toHaveBeenCalled(); expect(native.write).not.toHaveBeenCalled();
  expect(callbacks.started).toHaveBeenCalledWith("/bin/sh");
  expect(callbacks.exit).toHaveBeenCalledWith(7);
  vi.mocked(callbacks.data).mock.calls[0][1]!();
  expect(native.acknowledge).toHaveBeenCalledExactlyOnceWith(info.id, 1);
  await transport.close(info.id);
  native.channels[0].onmessage!({ kind: "output", id: info.id, data: [66], sequence: 2 });
  expect(callbacks.data).toHaveBeenCalledOnce(); expect(native.acknowledge).toHaveBeenCalledWith(info.id, 2);
});

it("passes an installed shell profile to create and reports the actual executable", async () => {
  const callbacks = { ...handlers(), started: vi.fn() };
  const profiles = [{ id: "/bin/bash", path: "/bin/bash", name: "Bash", isDefault: false, kind: "shell" as const }];
  native.profiles.mockResolvedValueOnce(profiles);
  native.create.mockResolvedValueOnce({ ...info, shell: "/bin/bash" });
  const transport = createTerminalTransport("/workspace");
  expect(await transport.profiles!()).toEqual(profiles);
  await transport.create(100, 30, callbacks, "/bin/bash");
  expect(native.create).toHaveBeenCalledWith("/workspace", 100, 30, native.channels[0], "/bin/bash");
  expect(callbacks.started).toHaveBeenCalledWith("/bin/bash");
});
