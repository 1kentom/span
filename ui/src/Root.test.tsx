// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onMount } from "solid-js";
import { render } from "solid-js/web";
import { Root } from "./Root";
import { resetAppReadyForTests, signalAppReady } from "./lib/boot-guard";

const disposers: (() => void)[] = [];
beforeEach(() => resetAppReadyForTests());
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function mount(app: () => any, options: { timeoutMs?: number } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const actions = { reload: vi.fn(), resetInterface: vi.fn(() => 2), copy: vi.fn(async (_text: string) => undefined) };
  const showWindow = vi.fn();
  disposers.push(render(() => <Root app={app} timeoutMs={options.timeoutMs} showWindow={showWindow} actions={actions} />, host));
  return { host, actions, showWindow };
}
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent === label) as HTMLButtonElement;
const settle = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

describe("root error boundary", () => {
  it("shows the recovery screen when the app throws while rendering", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { host, actions, showWindow } = mount(() => { throw new TypeError("old state"); });
    await settle();
    const screen = host.querySelector('[data-recovery="error"]');
    expect(screen).not.toBeNull();
    expect(screen?.classList.contains("ide")).toBe(true);
    expect(host.querySelector(".recovery-details summary")?.textContent).toBe("Details");
    expect(host.querySelector(".recovery-error")?.textContent).toBe("TypeError: old state");
    expect(showWindow).toHaveBeenCalled();
    button(host, "Reload").click();
    expect(actions.reload).toHaveBeenCalledTimes(1);
    button(host, "Reset interface state").click();
    expect(actions.resetInterface).toHaveBeenCalledTimes(1);
    expect(actions.reload).toHaveBeenCalledTimes(2);
    button(host, "Copy diagnostics").click();
    await settle();
    expect(actions.copy).toHaveBeenCalledTimes(1);
    expect(actions.copy.mock.calls[0][0]).toContain("TypeError: old state");
    expect(host.querySelector(".recovery-status")?.textContent).toBe("Diagnostics copied.");
  });

  it("shows the recovery screen when the app throws on mount", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { host } = mount(() => { onMount(() => { throw new Error("mount failed"); }); return <div class="app">app</div>; });
    await settle();
    expect(host.querySelector('[data-recovery="error"]')).not.toBeNull();
    expect(host.querySelector(".app")).toBeNull();
  });

  it("renders the app untouched when nothing fails", async () => {
    const { host } = mount(() => <div class="app">app</div>);
    await settle();
    expect(host.querySelector(".app")?.textContent).toBe("app");
    expect(host.querySelector("[data-recovery]")).toBeNull();
  });
});

describe("boot watchdog in the root", () => {
  it("shows the slow start screen over the app after the timeout and removes it once ready", async () => {
    vi.useFakeTimers();
    const { host, showWindow } = mount(() => <div class="app">app</div>, { timeoutMs: 8000 });
    vi.advanceTimersByTime(7999);
    expect(host.querySelector('[data-recovery="slow"]')).toBeNull();
    vi.advanceTimersByTime(1);
    const overlay = host.querySelector('[data-recovery="slow"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains("recovery-overlay")).toBe(true);
    expect(overlay?.textContent).toContain("Startup is slow or has failed");
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".app")).not.toBeNull();
    signalAppReady();
    expect(host.querySelector('[data-recovery="slow"]')).toBeNull();
  });

  it("never shows the slow screen when the app is ready in time", () => {
    vi.useFakeTimers();
    const { host } = mount(() => { onMount(() => signalAppReady()); return <div class="app">app</div>; });
    vi.advanceTimersByTime(20000);
    expect(host.querySelector("[data-recovery]")).toBeNull();
  });
});
