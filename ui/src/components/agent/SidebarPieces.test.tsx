// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { FollowPill } from "./FollowPill";
import { ComposerHints } from "./ComposerHints";
import { EditorToast } from "./EditorToast";
import { mount, text } from "./test-utils";

describe("FollowPill", () => {
  it("is an icon button when off and a Following pill when on, with pressed state", () => {
    const toggle = vi.fn();
    const [on, setOn] = createSignal(false);
    const host = mount(() => <FollowPill following={on()} onToggle={() => { toggle(); setOn(!on()); }} />);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Follow the agent in the editor");
    button.click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(text(button)).toBe("Following");
    expect(button.classList.contains("on")).toBe(true);
  });
});

describe("ComposerHints", () => {
  const hints = {
    idle: [{ keys: ["Enter"], label: "send" }, { keys: ["Up"], label: "history" }],
    permission: [{ keys: ["Y"], label: "allow" }],
  };
  it("renders only the hints given for the mode", () => {
    const [mode, setMode] = createSignal<"idle" | "running" | "question" | "permission">("idle");
    const host = mount(() => <ComposerHints mode={mode()} hints={hints} />);
    expect([...host.querySelectorAll(".sb-hint")].map((h) => text(h))).toEqual(["Enter send", "Up history"]);
    expect(host.querySelectorAll("kbd")).toHaveLength(2);
    setMode("permission");
    expect([...host.querySelectorAll(".sb-hint")].map((h) => text(h))).toEqual(["Y allow"]);
    setMode("running");
    expect(host.querySelector(".sb-hints")).toBeNull();
  });
  it("shows several keys for one hint", () => {
    const host = mount(() => <ComposerHints mode="question" hints={{ question: [{ keys: ["1", "3"], label: "choose" }, { keys: ["Esc"], label: "skip" }] }} />);
    expect(host.querySelectorAll(".sb-hint")[0].querySelectorAll("kbd")).toHaveLength(2);
    expect(host.querySelector("[aria-label='Keyboard shortcuts']")).not.toBeNull();
  });
});

describe("EditorToast", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it("announces through a status region and auto dismisses", () => {
    const dismiss = vi.fn();
    const host = mount(() => <EditorToast name="App.tsx" onDismiss={dismiss} duration={2000} />);
    expect(host.querySelector("[role=status]")).not.toBeNull();
    expect(text(host.querySelector(".sb-toast"))).toBe("Opened App.tsx in the editor");
    vi.advanceTimersByTime(1999); expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2); expect(dismiss).toHaveBeenCalledOnce();
  });
  it("renders no toast without a name, restarts the timer on a new name and clears on unmount", () => {
    const dismiss = vi.fn();
    const [name, setName] = createSignal<string | undefined>(undefined);
    const host = mount(() => <EditorToast name={name()} onDismiss={dismiss} duration={1000} />);
    expect(host.querySelector(".sb-toast")).toBeNull();
    setName("a.ts"); vi.advanceTimersByTime(800);
    setName("b.ts"); vi.advanceTimersByTime(800);
    expect(dismiss).not.toHaveBeenCalled();
    expect(text(host.querySelector(".sb-toast"))).toContain("b.ts");
    vi.advanceTimersByTime(300); expect(dismiss).toHaveBeenCalledOnce();
  });
});
