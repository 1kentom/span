// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentPermission } from "./AgentPermission";
import { AgentTool } from "./AgentTool";
import type { ToolEvent } from "../lib/agent-feed";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});
function mount(view: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  cleanup.push(render(view, host));
  return host;
}

describe("AgentMarkdown", () => {
  it("renders formatting and routes links through the preview policy", () => {
    const files: string[] = [];
    const urls: string[] = [];
    const host = mount(() => (
      <AgentMarkdown
        text={"**Done**\n\n- one\n- two\n\n[readme](README.md) [site](https://example.com) [bad](javascript:alert(1))"}
        workspaceRoot="/work"
        onOpenFile={(path) => files.push(path)}
        onOpenExternal={(url) => urls.push(url)}
      />
    ));
    expect(host.querySelector("strong")?.textContent).toBe("Done");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    host.querySelector<HTMLAnchorElement>("a[data-markdown-file]")!.click();
    host.querySelector<HTMLAnchorElement>("a[data-markdown-external]")!.click();
    expect(files).toEqual(["/work/README.md"]);
    expect(urls).toEqual(["https://example.com/"]);
    expect([...host.querySelectorAll("a")].some((link) => /^javascript:/i.test(link.getAttribute("href") ?? ""))).toBe(false);
  });

  it("keeps streaming text current after the throttle", () => {
    vi.useFakeTimers();
    try {
      let set!: (value: string) => void;
      const host = mount(() => {
        const [text, setText] = createSignal("first");
        set = setText;
        return <AgentMarkdown text={text()} workspaceRoot="/work" streaming />;
      });
      expect(host.textContent).toContain("first");
      set("first and second");
      vi.advanceTimersByTime(80);
      expect(host.textContent).toContain("first and second");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentPermission", () => {
  const options = [
    { optionId: "no", name: "Reject", kind: "reject_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "once", name: "Allow once", kind: "allow_once" },
  ];
  it("lists allow choices first and answers number keys", () => {
    const chosen: (string | null)[] = [];
    const host = mount(() => (
      <AgentPermission title="Run command" summary="git status" options={options} resolved={false} active busy={false} onChoose={(id) => chosen.push(id)} />
    ));
    expect([...host.querySelectorAll(".agent-permission-option")].map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "1Allow once",
      "2Always allowRemembered by Span for this session",
      "3Reject",
    ]);
    expect(host.querySelector(".agent-permission-summary")?.textContent).toBe("git status");
    const choice = host.querySelector<HTMLButtonElement>(".agent-permission-option")!;
    choice.focus();
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
    expect(chosen).toEqual(["always"]);
    host.querySelector<HTMLButtonElement>(".agent-link")!.click();
    expect(chosen).toEqual(["always", null]);
  });

  it("ignores number keys while typing and when another request is first", () => {
    const chosen: (string | null)[] = [];
    mount(() => <AgentPermission title="t" summary="" options={options} resolved={false} active={false} busy={false} onChoose={(id) => chosen.push(id)} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));
    const area = document.createElement("textarea");
    area.value = "draft";
    document.body.append(area);
    mount(() => <AgentPermission title="t" summary="" options={options} resolved={false} active busy={false} onChoose={(id) => chosen.push(id)} />);
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(chosen).toEqual([]);
  });

  it("hides the choices once resolved", () => {
    const host = mount(() => <AgentPermission title="t" summary="" options={options} resolved active busy={false} onChoose={() => {}} />);
    expect(host.querySelector(".agent-permission-option")).toBeNull();
    expect(host.textContent).toContain("resolved");
  });

  it("never answers while digits are typed in editor or other text fields", () => {
    const choose = vi.fn();
    const host = mount(() => <AgentPermission title="t" summary="" options={options} resolved={false} active busy={false} onChoose={choose} />);
    const editor = document.createElement("div");
    editor.className = "cm-content";
    editor.contentEditable = "true";
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    const textbox = document.createElement("div");
    textbox.setAttribute("role", "textbox");
    textbox.tabIndex = 0;
    const area = document.createElement("textarea");
    const input = document.createElement("input");
    const unrelated = document.createElement("button");
    document.body.append(editor, textbox, area, input, unrelated);
    for (const target of [editor, textbox, area, input, unrelated]) {
      target.focus();
      const event = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(choose).not.toHaveBeenCalled();
    const choice = host.querySelector<HTMLButtonElement>(".agent-permission-option")!;
    choice.focus();
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(choose).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("ignores consumed, composing, repeated keys and another open dialog", () => {
    const choose = vi.fn();
    const host = mount(() => <AgentPermission title="t" summary="" options={options} resolved={false} active busy={false} onChoose={choose} />);
    const choice = host.querySelector<HTMLButtonElement>(".agent-permission-option")!;
    choice.focus();
    const consumed = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    consumed.preventDefault();
    choice.dispatchEvent(consumed);
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, isComposing: true }));
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, repeat: true }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(choose).not.toHaveBeenCalled();
    dialog.remove();
    choice.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    expect(choose).toHaveBeenCalledExactlyOnceWith("no");
  });
});

describe("AgentTool", () => {
  const tool = (id: string, status: string, parent: string | null = null): ToolEvent => ({
    kind: "tool", sessionId: "s", toolCallId: id, title: `call ${id}`, status, toolKind: null, parentToolCallId: parent, contentJson: "{}",
  });
  it("shows subagent progress under the parent call", () => {
    const host = mount(() => <AgentTool tool={tool("task", "in_progress")} children={[tool("a", "completed", "task"), tool("b", "in_progress", "task")]} />);
    expect(host.querySelector(".agent-subagent summary")?.textContent).toContain("1/2 done");
    expect(host.querySelectorAll(".agent-subagent li")).toHaveLength(2);
    expect(host.querySelector<HTMLDetailsElement>(".agent-subagent")!.open).toBe(true);
  });
  it("renders a plain call without a subagent section", () => {
    const host = mount(() => <AgentTool tool={tool("solo", "completed")} children={[]} />);
    expect(host.querySelector(".agent-subagent")).toBeNull();
  });
});
