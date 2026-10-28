// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWindowZoom, clampZoomLevel, createZoomController, MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, ZOOM_STORAGE_KEY, zoomFactor } from "./zoom";
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    clear: () => values.clear(),
  } });
});
afterEach(() => { window.localStorage.clear(); document.body.replaceChildren(); document.documentElement.style.removeProperty("zoom"); });
describe("whole window zoom", () => {
  it("uses 20 percent steps, clamps bounds, and resets without changing editor font settings", async () => {
    const applyZoom = vi.fn(async () => {}); const persistLevel = vi.fn(); document.documentElement.style.fontSize = "13px";
    const zoom = createZoomController({ initialLevel: 0, applyZoom, persistLevel });
    await zoom.zoomIn(); expect(applyZoom).toHaveBeenLastCalledWith(1.2); expect(zoom.level()).toBe(1);
    await zoom.zoomIn(); expect(applyZoom).toHaveBeenLastCalledWith(1.44);
    await zoom.setLevel(99); expect(zoom.level()).toBe(MAX_ZOOM_LEVEL);
    await zoom.setLevel(-99); expect(zoom.level()).toBe(MIN_ZOOM_LEVEL);
    await zoom.reset(); expect(zoom.level()).toBe(0); expect(applyZoom).toHaveBeenLastCalledWith(1); expect(persistLevel).toHaveBeenLastCalledWith(0);
    expect(document.documentElement.style.fontSize).toBe("13px"); expect(clampZoomLevel(Number.NaN)).toBe(0);
  });
  it("serializes rapid commands and recovers after a failed native apply", async () => {
    const applyZoom = vi.fn().mockRejectedValueOnce(new Error("Zoom denied")).mockResolvedValue(undefined); const persistLevel = vi.fn(); const onChange = vi.fn();
    const zoom = createZoomController({ initialLevel: 0, applyZoom, persistLevel, onChange });
    await expect(zoom.zoomIn()).rejects.toThrow("Zoom denied"); expect(zoom.level()).toBe(0); expect(persistLevel).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    await Promise.all([zoom.zoomIn(), zoom.zoomIn(), zoom.zoomOut()]); expect(zoom.level()).toBe(1); expect(applyZoom.mock.calls.slice(1)).toEqual([[1.2], [1.44], [1.2]]);
  });
  it("restores persisted window level and reports storage errors without hiding applied zoom", async () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, "2"); const applyZoom = vi.fn(async () => {}); const zoom = createZoomController({ applyZoom });
    await zoom.restore(); expect(applyZoom).toHaveBeenCalledWith(zoomFactor(2)); expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("2");
    await zoom.reset(); expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("0");
    const failure = createZoomController({ initialLevel: 0, applyZoom, persistLevel: () => { throw new Error("Disk unavailable"); } });
    await expect(failure.zoomIn()).rejects.toThrow("Disk unavailable"); expect(failure.level()).toBe(1);
  });
  it("applies preview zoom to the document and compensates the entire workbench viewport height", async () => {
    const workbench = document.createElement("main"); workbench.className = "ide"; document.body.append(workbench);
    await applyWindowZoom(1.2); expect(document.documentElement.style.zoom).toBe("1.2"); expect(workbench.style.height).toMatch(/83\.333/);
    await applyWindowZoom(1); expect(document.documentElement.style.zoom).toBe("1");
  });
});
