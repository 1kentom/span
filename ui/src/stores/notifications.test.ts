import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_MS, MAX_TOASTS, REPEAT_QUIET_MS, TOAST_MS, clearNotifications, dismissToast, markAllRead, notifications, notify, notifyError, pauseToast, removeNotification, resumeToast, unreadCount, visibleToasts } from "./notifications";

beforeEach(() => { vi.useFakeTimers(); clearNotifications(); });
afterEach(() => { clearNotifications(); vi.useRealTimers(); });

describe("notifications", () => {
  it("shows a toast that animates out and then leaves, while the history keeps it", () => {
    notify({ level: "info", message: "Saved" });
    expect(visibleToasts()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_MS.info);
    expect(visibleToasts()[0].leaving).toBe(true);
    vi.advanceTimersByTime(EXIT_MS);
    expect(visibleToasts()).toHaveLength(0);
    expect(notifications()).toHaveLength(1);
  });
  it("keeps errors up longer than info and sticky ones until dismissed", () => {
    notify({ level: "error", message: "Bad" });
    notify({ level: "warning", message: "Careful", sticky: true });
    vi.advanceTimersByTime(TOAST_MS.error + EXIT_MS + 10);
    expect(visibleToasts().map(toast => toast.id)).toHaveLength(1);
    const sticky = visibleToasts()[0].id;
    vi.advanceTimersByTime(60000);
    expect(visibleToasts()[0].id).toBe(sticky);
    dismissToast(sticky); vi.advanceTimersByTime(EXIT_MS);
    expect(visibleToasts()).toHaveLength(0);
  });
  it("pauses while hovered and resumes with a fresh timer", () => {
    const id = notify({ level: "info", message: "Hold" });
    pauseToast(id); vi.advanceTimersByTime(TOAST_MS.info * 3);
    expect(visibleToasts()[0].leaving).toBe(false);
    resumeToast(id); vi.advanceTimersByTime(TOAST_MS.info);
    expect(visibleToasts()[0].leaving).toBe(true);
  });
  it("folds repeats into one entry with a count and stays quiet after a dismissed toast", () => {
    notifyError("Create atomic save /x: No space left on device (os error 28)");
    vi.advanceTimersByTime(TOAST_MS.error + EXIT_MS);
    notifyError("Create atomic save /x: No space left on device (os error 28)");
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].count).toBe(2);
    expect(visibleToasts()).toHaveLength(0);
    vi.advanceTimersByTime(REPEAT_QUIET_MS);
    notifyError("Create atomic save /x: No space left on device (os error 28)");
    expect(visibleToasts()).toHaveLength(1);
    expect(notifications()[0].count).toBe(3);
  });
  it("uses plain language for a full disk and keeps the raw text", () => {
    notifyError(new Error("Write atomic save /x: No space left on device (os error 28)"));
    expect(notifications()[0].message).toMatch(/disk is full/i);
    expect(notifications()[0].detail).toContain("os error 28");
  });
  it("shows at most three toasts and tracks unread until read", () => {
    for (let i = 0; i < 5; i++) notify({ message: `n${i}` });
    expect(visibleToasts()).toHaveLength(MAX_TOASTS);
    expect(notifications()).toHaveLength(5);
    expect(unreadCount()).toBe(5);
    markAllRead();
    expect(unreadCount()).toBe(0);
    removeNotification(notifications()[0].id);
    expect(notifications()).toHaveLength(4);
  });
});
