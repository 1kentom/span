// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ConnectScreen } from "./ConnectScreen";
import { ConnectingSteps, ReadyCard } from "./ConnectFlow";
import { EmptySession } from "./EmptySession";
import { SignIn } from "./SignIn";
import { mount, text } from "./test-utils";

describe("ConnectScreen", () => {
  const view = (extra: Partial<Parameters<typeof ConnectScreen>[0]> = {}) => {
    const calls: string[] = [];
    const host = mount(() => (
      <ConnectScreen
        found={[{ id: "claude", name: "Claude Code", subtitle: "/usr/local/bin/claude" }]}
        registry={[
          { id: "gemini", name: "Gemini CLI", status: "available" },
          { id: "qwen", name: "Qwen Code", status: "installing" },
          { id: "mistral", name: "Mistral Vibe", status: "installing", progress: 0.4 },
          { id: "odd", name: "Odd Agent", status: "unsupported" },
        ]}
        onConnect={(id) => calls.push(`connect:${id}`)}
        onInstall={(id) => calls.push(`install:${id}`)}
        onCustom={(command) => calls.push(`custom:${command}`)}
        {...extra}
      />
    ));
    return { host, calls };
  };

  it("routes Connect, Install and shows install and unsupported states", () => {
    const { host, calls } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Connect Claude Code']")!.click();
    host.querySelector<HTMLButtonElement>("[aria-label='Install Gemini CLI']")!.click();
    expect(calls).toEqual(["connect:claude", "install:gemini"]);
    const bars = host.querySelectorAll("[role=progressbar]");
    expect(bars).toHaveLength(2);
    expect(bars[0].classList.contains("indeterminate")).toBe(true);
    expect(bars[0].hasAttribute("aria-valuenow")).toBe(false);
    expect(bars[1].getAttribute("aria-valuenow")).toBe("40");
    expect(host.textContent).toContain("Needs custom command");
  });

  it("submits a custom command only when one is typed", () => {
    const { host, calls } = view();
    host.querySelector<HTMLButtonElement>(".sb-custom-toggle")!.click();
    const input = host.querySelector<HTMLInputElement>("[aria-label='ACP command']")!;
    const submit = host.querySelector<HTMLButtonElement>(".sb-custom-form button")!;
    expect(submit.disabled).toBe(true);
    input.value = " my-agent --acp ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(calls).toEqual(["custom:my-agent --acp"]);
  });
});

describe("ConnectingSteps and ReadyCard", () => {
  it("marks each phase state with a visible and an accessible label", () => {
    const host = mount(() => (
      <ConnectingSteps phases={[
        { id: "a", label: "Starting process", state: "done", meta: "pid 4" },
        { id: "b", label: "Initialising", state: "active" },
        { id: "c", label: "Opening session", state: "pending" },
      ]} />
    ));
    const items = [...host.querySelectorAll("li")];
    expect(items.map((li) => li.className)).toEqual(["sb-phase done", "sb-phase active", "sb-phase pending"]);
    expect(items[1].querySelector(".sb-spinner")).not.toBeNull();
    expect(items[1].getAttribute("aria-current")).toBe("step");
    expect(text(items[0])).toContain("Starting process");
  });

  it("shows supported capabilities as chips and unsupported as dashed", () => {
    const host = mount(() => (
      <ReadyCard id="claude" title="Claude Code" version="1.2.0" capabilities={[
        { id: "load", label: "Resume chats", supported: true },
        { id: "img", label: "Images", supported: false },
      ]} />
    ));
    const chips = [...host.querySelectorAll(".sb-chip")];
    expect(chips[0].classList.contains("off")).toBe(false);
    expect(chips[1].classList.contains("off")).toBe(true);
    expect(text(chips[1])).toContain("not supported");
    expect(host.textContent).toContain("1.2.0");
  });
});

describe("EmptySession and SignIn", () => {
  it("opens a recent session and lists key hints", () => {
    const opened = vi.fn();
    const host = mount(() => (
      <EmptySession id="claude" name="Claude Code" title="What should we build?" keys={[{ keys: ["Enter"], label: "send" }, { keys: ["Shift", "Enter"], label: "newline" }]}
        recents={[{ id: "s1", title: "Fix the parser", time: "2h" }]} onOpenRecent={opened} />
    ));
    expect(host.querySelectorAll("kbd")).toHaveLength(3);
    host.querySelector<HTMLButtonElement>(".sb-recent")!.click();
    expect(opened).toHaveBeenCalledWith("s1");
  });

  it("makes the first method primary and states who holds credentials", () => {
    const picked: string[] = [];
    const host = mount(() => (
      <SignIn id="claude" title="Sign in" methods={[{ id: "oauth", name: "Browser", description: "Opens a page" }, { id: "key", name: "API key" }]} onPick={(id) => picked.push(id)} />
    ));
    const buttons = host.querySelectorAll<HTMLButtonElement>(".sb-method");
    expect(buttons[0].classList.contains("primary")).toBe(true);
    expect(buttons[1].classList.contains("primary")).toBe(false);
    buttons[1].click();
    expect(picked).toEqual(["key"]);
    expect(host.textContent).toContain("Credentials stay with the agent. Span never sees them.");
  });
});

describe("signal-driven props", () => {
  it("reflects an install finishing", () => {
    const [status, setStatus] = createSignal<"installing" | "available">("installing");
    const host = mount(() => (
      <ConnectScreen found={[]} registry={[{ id: "g", name: "Gemini", status: status() }]} onConnect={() => {}} onInstall={() => {}} onCustom={() => {}} />
    ));
    expect(host.querySelector("[role=progressbar]")).not.toBeNull();
    setStatus("available");
    expect(host.querySelector("[role=progressbar]")).toBeNull();
    expect(host.querySelector("[aria-label='Install Gemini']")).not.toBeNull();
  });
});
