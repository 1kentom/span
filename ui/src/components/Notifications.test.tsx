// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { NotificationBell, ToastStack } from "./Notifications";
import { EXIT_MS, TOAST_MS, clearNotifications, notify, notifyError } from "../stores/notifications";

const disposers: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); clearNotifications(); });
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); clearNotifications(); vi.useRealTimers(); });
const mount = () => { const host = document.createElement("div"); document.body.append(host); disposers.push(render(() => <><ToastStack /><NotificationBell /></>, host)); return host; };

describe("notifications UI", () => {
  it("shows a toast, runs its action, and removes it after the exit animation", () => {
    const run = vi.fn(); const host = mount();
    notify({ level: "error", message: "Could not save", actions: [{ label: "Retry", run }] });
    const toast = host.querySelector(".toast")!;
    expect(toast.getAttribute("role")).toBe("alert");
    (toast.querySelector(".notice-link") as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledOnce();
    expect(host.querySelector(".toast.leaving")).not.toBeNull();
    vi.advanceTimersByTime(EXIT_MS);
    expect(host.querySelector(".toast")).toBeNull();
  });
  it("disappears on its own and the bell keeps it with an unread badge until opened", () => {
    const host = mount();
    notify({ level: "info", message: "Indexed" });
    expect(host.querySelector(".notice-badge")?.textContent).toBe("1");
    vi.advanceTimersByTime(TOAST_MS.info + EXIT_MS);
    expect(host.querySelector(".toast")).toBeNull();
    (host.querySelector(".notice-bell-button") as HTMLButtonElement).click();
    expect(host.querySelector(".notice-panel")?.textContent).toContain("Indexed");
    expect(host.querySelector(".notice-badge")).toBeNull();
  });
  it("explains a full disk in the panel, shows the raw text under Details, and clears", () => {
    const host = mount();
    notifyError("Create atomic save /x/.session.json.span-1-2: No space left on device (os error 28)");
    (host.querySelector(".notice-bell-button") as HTMLButtonElement).click();
    const panel = host.querySelector(".notice-panel")!;
    expect(panel.textContent).toMatch(/disk is full/i);
    expect(panel.querySelector(".notice-detail")).toBeNull();
    (panel.querySelector(".notice-list .notice-link") as HTMLButtonElement).click();
    expect(panel.querySelector(".notice-detail")?.textContent).toContain("os error 28");
    (Array.from(panel.querySelectorAll("button")).find(b => b.textContent === "Clear all") as HTMLButtonElement).click();
    expect(host.querySelector(".notice-empty")).not.toBeNull();
  });
});
