// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { UrlDock } from "./Docks";
import { key, mount, text } from "./test-utils";

afterEach(() => vi.useRealTimers());
const buttons = (host: Element) => [...host.querySelectorAll<HTMLButtonElement>("button")];

describe("UrlDock browser sign-in", () => {
  it("shows the title, brand slot, host emphasis and a labelled code", () => {
    const host = mount(() => <UrlDock title="Authorize GitHub" href="https://github.com@evil.example/login/device?x=1" code="WDJB-MJHT" onOpen={() => {}} onCancel={() => {}} />);
    expect(text(host.querySelector(".sb-dock-title"))).toBe("Authorize GitHub");
    expect(text(host.querySelector(".sb-url-host"))).toBe("evil.example");
    expect(host.querySelector(".sb-urlbox")?.textContent).toContain("github.com@");
    expect(host.querySelector(".sb-mono")?.getAttribute("title")).toContain("login/device?x=1");
    expect(text(host)).toContain("Enter this code");
    const code = host.querySelector(".sb-code-value")!;
    expect(code.textContent).toBe("WDJB-MJHT");
    expect(code.getAttribute("aria-label")).toBe("One-time code");
    expect(host.querySelector(`#${code.getAttribute("aria-describedby")}`)?.textContent).toBe("Code from the agent's message");
    // The Enter key cap is the library icon (its screen reader label reads "Enter"), never a text glyph.
    expect(buttons(host).map((button) => text(button))).toEqual(expect.arrayContaining(["Open browserEnter", "Cancel"]));
    expect(host.querySelector(".sb-btn.primary .sb-hotkey .key-enter")).not.toBeNull();
    expect(host.textContent).not.toMatch(/[\u21b5\u21a9\u23ce]|\\u21b5/);
  });

  it("shows no code block without a code", () => {
    const host = mount(() => <UrlDock title="Open example.org" href="https://example.org/" onOpen={() => {}} onCancel={() => {}} />);
    expect(host.querySelector(".sb-code-value")).toBeNull();
    expect(host.querySelector("[aria-label='Copy code']")).toBeNull();
  });

  it("copies once through the handler and says Copied for 1.5 s", async () => {
    vi.useFakeTimers();
    const copy = vi.fn(async () => {});
    const host = mount(() => <UrlDock title="t" href="https://github.com/login/device" code="WDJB-MJHT" onOpen={() => {}} onCancel={() => {}} onCopyCode={copy} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Copy code']")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith("WDJB-MJHT");
    const status = host.querySelector("[role=status]")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1499);
    expect(status.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(2);
    expect(host.querySelector("[role=status]")?.textContent ?? "").toBe("");
  });

  it("reports a failed copy instead of Copied", async () => {
    const host = mount(() => <UrlDock title="t" href="https://github.com/x" code="WDJB-MJHT" onOpen={() => {}} onCancel={() => {}} onCopyCode={async () => { throw new Error("no"); }} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Copy code']")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector("[role=status]")?.textContent).toBe("Could not copy");
  });

  it("waiting state: spinner, Waiting for browser, Open again and Dismiss", () => {
    const [waiting, setWaiting] = createSignal(false);
    const open = vi.fn();
    const host = mount(() => <UrlDock title="Authorize GitHub" href="https://github.com/login/device" waiting={waiting()} onOpen={open} onCancel={() => {}} />);
    expect(host.querySelector(".sb-spinner")).toBeNull();
    expect(text(host)).not.toContain("Waiting for browser");
    setWaiting(true);
    expect(host.querySelector(".sb-spinner")).not.toBeNull();
    expect(text(host)).toContain("Waiting for browser");
    expect(buttons(host).map((button) => text(button))).toEqual(expect.arrayContaining(["Open againEnter", "Dismiss"]));
    expect(host.querySelector(".sb-waiting [role=status]")?.getAttribute("aria-live")).toBe("polite");
    buttons(host).find((button) => text(button)?.startsWith("Open again"))!.click();
    expect(open).toHaveBeenCalledOnce();
  });

  it("keys stay scoped to the dock", () => {
    const open = vi.fn();
    const cancel = vi.fn();
    const host = mount(() => (
      <div>
        <UrlDock title="t" href="https://github.com/x" onOpen={open} onCancel={cancel} />
        <textarea id="c" />
      </div>
    ));
    const composer = host.querySelector("#c")!;
    key("Enter", {}, composer);
    key("Escape", {}, composer);
    key("Enter");
    key("Escape");
    expect(open).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    const dock = host.querySelector(".sb-dock")!;
    key("Enter", {}, dock);
    key("Escape", {}, dock);
    expect(open).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("renders a hostile message as text only", () => {
    const host = mount(() => <UrlDock title="t" text="<img src=x onerror=alert(1)>" href="https://e.com" onOpen={() => {}} onCancel={() => {}} />);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".sb-body")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
