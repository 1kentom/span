import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoSaveController, type AutoSaveSnapshot } from "./autosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const snapshot: AutoSaveSnapshot = { generation: 1, mode: "afterDelay", delay: 1000, buffers: [{ path: "a.ts", revision: 1, dirty: true }, { path: "b.ts", revision: 1, dirty: true }] };
  const save = vi.fn(async (_path: string, _generation: number) => true);
  const onFailures = vi.fn();
  const controller = createAutoSaveController({ read: () => snapshot, save, onFailures });
  const edit = (path: string) => { snapshot.buffers = snapshot.buffers.map(buffer => buffer.path === path ? { ...buffer, revision: buffer.revision + 1 } : buffer); controller.sync(); };
  return { snapshot, save, onFailures, controller, edit };
}
describe("Auto Save scheduling", () => {
  it("debounces each buffer independently and never re-saves an unchanged revision", async () => {
    const f = fixture(); f.controller.sync();
    await vi.advanceTimersByTimeAsync(500); f.edit("a.ts");
    await vi.advanceTimersByTimeAsync(500); expect(f.save.mock.calls).toEqual([["b.ts", 1]]);
    await vi.advanceTimersByTimeAsync(500); expect(f.save.mock.calls).toEqual([["b.ts", 1], ["a.ts", 1]]);
    f.controller.sync(); await vi.advanceTimersByTimeAsync(10000); expect(f.save).toHaveBeenCalledTimes(2); f.controller.dispose();
  });
  it("serializes saves, drops obsolete queued revisions, and saves edits made during a write", async () => {
    const f = fixture(); let finish!: (saved: boolean) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.controller.sync(); await vi.advanceTimersByTimeAsync(1000); expect(f.save.mock.calls).toEqual([["a.ts", 1]]);
    f.edit("a.ts"); f.edit("b.ts"); finish(true); await vi.advanceTimersByTimeAsync(0);
    expect(f.save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(f.save.mock.calls).toEqual([["a.ts", 1], ["a.ts", 1], ["b.ts", 1]]); f.controller.dispose();
  });
  it("uses explicit focus and window triggers according to the selected mode", async () => {
    const f = fixture(); f.snapshot.mode = "off"; f.controller.sync(); f.controller.editorBlur("a.ts"); f.controller.windowBlur();
    await vi.advanceTimersByTimeAsync(10000); expect(f.save).not.toHaveBeenCalled();
    f.snapshot.mode = "onFocusChange"; f.controller.sync(); f.controller.editorBlur("a.ts"); await vi.advanceTimersByTimeAsync(0);
    expect(f.save.mock.calls).toEqual([["a.ts", 1]]); f.controller.windowBlur(); await vi.advanceTimersByTimeAsync(0); expect(f.save).toHaveBeenCalledTimes(2);
    f.edit("a.ts"); f.snapshot.mode = "onWindowChange"; f.controller.editorBlur("a.ts"); await vi.advanceTimersByTimeAsync(0); expect(f.save).toHaveBeenCalledTimes(2);
    f.controller.windowBlur(); await vi.advanceTimersByTimeAsync(0); expect(f.save).toHaveBeenCalledTimes(3); f.controller.dispose();
  });
  it("cancels timers for closed buffers, workspace changes, paused work, and disabling", async () => {
    const f = fixture(); f.controller.sync(); f.snapshot.buffers = []; f.controller.sync(); await vi.advanceTimersByTimeAsync(1000); expect(f.save).not.toHaveBeenCalled();
    f.snapshot.buffers = [{ path: "new.ts", revision: 1, dirty: true }]; f.controller.sync(); f.snapshot.generation++; f.snapshot.mode = "off"; f.controller.sync();
    await vi.advanceTimersByTimeAsync(1000); expect(f.save).not.toHaveBeenCalled();
    f.snapshot.mode = "afterDelay"; f.snapshot.paused = true; f.controller.sync(); await vi.advanceTimersByTimeAsync(1000); expect(f.save).not.toHaveBeenCalled();
    f.snapshot.paused = false; f.controller.sync(); await vi.advanceTimersByTimeAsync(1000); expect(f.save.mock.calls).toEqual([["new.ts", 2]]); f.controller.dispose();
  });
  it("rechecks generation, current revision, and open state immediately before queued writes", async () => {
    const f = fixture(); let finish!: (saved: boolean) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.controller.sync(); await vi.advanceTimersByTimeAsync(1000);
    f.snapshot.generation++; f.snapshot.mode = "off"; f.snapshot.buffers = []; f.controller.sync(); finish(false);
    await vi.advanceTimersByTimeAsync(0); expect(f.save).toHaveBeenCalledTimes(1); expect(f.onFailures).toHaveBeenLastCalledWith([]); f.controller.dispose();
  });
  it("leaves failures quiet, preserves the dirty input, and backs off new edits", async () => {
    const f = fixture(); f.snapshot.buffers = f.snapshot.buffers.slice(0, 1); f.snapshot.delay = 0; f.save.mockRejectedValueOnce(new Error("File changed on disk"));
    f.controller.sync(); await vi.advanceTimersByTimeAsync(0); expect(f.onFailures).toHaveBeenLastCalledWith([{ path: "a.ts", revision: 1, message: "File changed on disk", retryAfter: Date.now() + 1000 }]);
    expect(f.snapshot.buffers[0].dirty).toBe(true); f.controller.sync(); f.controller.windowBlur(); await vi.advanceTimersByTimeAsync(10000); expect(f.save).toHaveBeenCalledTimes(1);
    f.edit("a.ts"); await vi.advanceTimersByTimeAsync(0); expect(f.save).toHaveBeenCalledTimes(2); expect(f.onFailures).toHaveBeenLastCalledWith([]);
    f.save.mockResolvedValueOnce(false); f.edit("a.ts"); await vi.advanceTimersByTimeAsync(0); f.edit("a.ts");
    await vi.advanceTimersByTimeAsync(999); expect(f.save).toHaveBeenCalledTimes(3); await vi.advanceTimersByTimeAsync(1); expect(f.save).toHaveBeenCalledTimes(4); f.controller.dispose();
  });
  it("requires explicit Save for settings drafts and never saves excluded or clean buffers", async () => {
    const f = fixture(); f.snapshot.buffers = [
      { path: ".span/settings.jsonc", revision: 1, dirty: true }, { path: ".vscode/settings.json", revision: 1, dirty: true },
      { path: "settings://user", revision: 1, dirty: true }, { path: "settings://workspace", revision: 1, dirty: true },
      { path: "proposal.ts", revision: 1, dirty: true, eligible: false }, { path: "clean.ts", revision: 1, dirty: false },
    ];
    f.controller.sync(); await vi.advanceTimersByTimeAsync(1000); expect(f.save).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it("does not publish stale failures after disposal", async () => {
    const f = fixture(); let finish!: (saved: boolean) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); f.controller.sync(); await vi.advanceTimersByTimeAsync(1000);
    f.controller.dispose(); finish(false); await vi.advanceTimersByTimeAsync(1000); expect(f.save).toHaveBeenCalledTimes(1); expect(f.onFailures).toHaveBeenLastCalledWith([]);
  });
  it("checks live workspace state before publishing an in-flight error even before the next sync", async () => {
    const f = fixture(); let finish!: (saved: boolean) => void;
    f.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); f.controller.sync(); await vi.advanceTimersByTimeAsync(1000);
    f.snapshot.generation++; f.snapshot.buffers = []; finish(false); await vi.advanceTimersByTimeAsync(0);
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.onFailures).not.toHaveBeenCalled(); f.controller.dispose();
  });
});
