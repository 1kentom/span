// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_WATCHDOG_MS, diagnosticsText, errorSummary, isAppReady, onAppReady, resetAppReadyForTests, signalAppReady, startBootWatchdog } from "./boot-guard";

beforeEach(() => {
  resetAppReadyForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("boot watchdog", () => {
  it("fires after 8 seconds without a ready signal", () => {
    const onTimeout = vi.fn();
    startBootWatchdog({ onTimeout });
    vi.advanceTimersByTime(BOOT_WATCHDOG_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(BOOT_WATCHDOG_MS).toBe(8000);
  });
  it("stays quiet when the app signals ready in time", () => {
    const onTimeout = vi.fn();
    startBootWatchdog({ onTimeout });
    vi.advanceTimersByTime(3000);
    signalAppReady();
    vi.advanceTimersByTime(BOOT_WATCHDOG_MS * 2);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(isAppReady()).toBe(true);
    expect(document.documentElement.dataset.spanReady).toBe("true");
  });
  it("reports a late ready after it fired", () => {
    const onTimeout = vi.fn();
    const onReadyAfterTimeout = vi.fn();
    startBootWatchdog({ onTimeout, onReadyAfterTimeout, timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    signalAppReady();
    expect(onReadyAfterTimeout).toHaveBeenCalledTimes(1);
  });
  it("does nothing once stopped", () => {
    const onTimeout = vi.fn();
    const stop = startBootWatchdog({ onTimeout, timeoutMs: 100 });
    stop();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
  it("runs ready listeners once, and at once when already ready", () => {
    const early = vi.fn();
    onAppReady(early);
    signalAppReady();
    signalAppReady();
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    onAppReady(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("diagnostics", () => {
  it("summarises any thrown value on one line", () => {
    expect(errorSummary(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
    expect(errorSummary("plain")).toBe("plain");
    expect(errorSummary({ code: 1 })).toBe('{"code":1}');
  });
  it("names the reason, the error and the marks, with key names only", () => {
    const text = diagnosticsText({ reason: "slow", error: new Error("boom"), marks: { entry: 12, session: null }, storageKeys: ["span.theme"], now: new Date(0) });
    expect(text).toContain("startup did not finish in time");
    expect(text).toContain("error: Error: boom");
    expect(text).toContain("entry=12, session=none");
    expect(text).toContain("stored interface keys: span.theme");
    expect(text).not.toMatch(/\u2014/);
  });
});
