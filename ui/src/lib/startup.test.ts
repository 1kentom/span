import { afterEach, describe, expect, it, vi } from "vitest";
import { afterNextPaint, collectStartupTimings, markStartup, STARTUP_MARKS } from "./startup";

function fakePerformance(paints: { name: string; startTime: number }[] = []) {
  const marks: { name: string; startTime: number }[] = [];
  let now = 10;
  return {
    timeOrigin: 1_700_000_000_000.4,
    marks,
    mark: vi.fn((name: string) => { marks.push({ name, startTime: (now += 15.4) }); return undefined as unknown as PerformanceMark; }),
    getEntriesByName: (name: string) => marks.filter(entry => entry.name === name) as unknown as PerformanceEntryList,
    getEntriesByType: (type: string) => (type === "paint" ? paints : []) as unknown as PerformanceEntryList,
  };
}

describe("startup timings", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the first time when a mark is recorded twice", () => {
    const perf = fakePerformance();
    markStartup(STARTUP_MARKS.entryEvaluated, perf);
    markStartup(STARTUP_MARKS.entryEvaluated, perf);
    expect(perf.mark).toHaveBeenCalledTimes(1);
  });

  it("reports rounded marks and prefers first-paint over first-contentful-paint", () => {
    const perf = fakePerformance([{ name: "first-contentful-paint", startTime: 90.6 }, { name: "first-paint", startTime: 80.2 }]);
    markStartup(STARTUP_MARKS.entryEvaluated, perf);
    markStartup(STARTUP_MARKS.shellRendered, perf);
    expect(collectStartupTimings(perf)).toEqual({ firstPaintMs: 80, entryEvaluatedMs: 25, shellRenderedMs: 41, sessionReadyMs: null, timeOriginMs: 1_700_000_000_000 });
  });

  it("falls back to first-contentful-paint and reports null without performance", () => {
    expect(collectStartupTimings(fakePerformance([{ name: "first-contentful-paint", startTime: 12 }])).firstPaintMs).toBe(12);
    expect(collectStartupTimings(null)).toEqual({ firstPaintMs: null, entryEvaluatedMs: null, shellRenderedMs: null, sessionReadyMs: null, timeOriginMs: null });
  });

  it("runs once after a frame, or after the fallback when frames never come", () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const painted = vi.fn();
    afterNextPaint(painted, 500);
    frames[0]!(0);
    vi.advanceTimersByTime(0);
    expect(painted).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(painted).toHaveBeenCalledTimes(1);

    const throttled = vi.fn();
    afterNextPaint(throttled, 500);
    vi.advanceTimersByTime(499);
    expect(throttled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(throttled).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
