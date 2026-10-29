// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentMarkdown } from "./AgentMarkdown";
import { PermissionDock } from "./agent/Docks";
import { WorkGroup } from "./agent/WorkGroup";
import type { ToolEvent } from "../lib/agent-feed";
import { initialAgentState, openPermission, reduceAgentEvent, resolvePermission } from "../lib/agent-session";
import { toStep, workChildren } from "../lib/agent-view";

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

  it("keeps streaming text current after the paced reveal", () => {
    vi.useFakeTimers();
    try {
      let set!: (value: string) => void;
      const host = mount(() => {
        const [text, setText] = createSignal("first ");
        set = setText;
        return <AgentMarkdown text={text()} workspaceRoot="/work" streaming />;
      });
      vi.advanceTimersByTime(80);
      expect(host.textContent).toContain("first");
      set("first and second ");
      vi.advanceTimersByTime(500);
      expect(host.textContent).toContain("first and second");
    } finally {
      vi.useRealTimers();
    }
  });
});

// AgentPermission was replaced by PermissionDock. These keep the old component's behaviour covered: allow choices
// first, Span named as the holder of a standing choice, and keys that only count from inside the focused choices.
describe("AgentPermission (now PermissionDock)", () => {
  const options = [
    { optionId: "no", name: "Reject", kind: "reject_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "once", name: "Allow once", kind: "allow_once" },
  ];
  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const firstChoice = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".sb-actions .sb-btn")!;

  it("lists allow choices first and answers its hotkeys (Y, A and N replace number keys)", () => {
    const chosen: string[] = [];
    const host = mount(() => <PermissionDock title="Run command" command="git status" options={options} onChoose={(id) => chosen.push(id)} />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".sb-actions .sb-btn")];
    expect(buttons.map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Allow onceY", "Always allowA", "RejectN"]);
    expect(buttons[1].title).toBe("Always allow (Remembered by Span for this session)");
    expect(host.querySelector(".sb-dock-command")?.textContent).toBe("$ git status");
    buttons[0].focus();
    press(buttons[0], "a");
    expect(chosen).toEqual(["always"]);
    press(buttons[0], "y");
    press(buttons[0], "n");
    expect(chosen).toEqual(["always", "once", "no"]);
  });

  it("ignores number keys while typing and when another request is first", () => {
    const chosen: string[] = [];
    const inactive = mount(() => <PermissionDock title="t" options={options} active={false} onChoose={(id) => chosen.push(id)} />);
    firstChoice(inactive).focus();
    press(firstChoice(inactive), "y");
    press(firstChoice(inactive), "1");
    const area = document.createElement("textarea");
    area.value = "draft";
    document.body.append(area);
    mount(() => <PermissionDock title="t" options={options} onChoose={(id) => chosen.push(id)} />);
    area.focus();
    press(area, "1");
    press(area, "y");
    expect(chosen).toEqual([]);
  });

  it("hides the choices once resolved", () => {
    const permission = { kind: "permission", sessionId: "s1", requestId: "r1", toolCallId: "t1", title: "Run", options } as const;
    let state = reduceAgentEvent({ ...initialAgentState(true), sessionId: "s1" }, permission);
    // The composer draws a PermissionDock only for the open request, so a resolved one leaves no choices on screen.
    expect(openPermission(state.feed)?.event.requestId).toBe("r1");
    state = resolvePermission(state, "r1");
    expect(openPermission(state.feed)).toBeUndefined();
  });

  it("never answers while digits are typed in editor or other text fields", () => {
    const choose = vi.fn();
    const host = mount(() => <PermissionDock title="t" options={options} onChoose={choose} />);
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
      for (const key of ["1", "y"]) expect(press(target, key).defaultPrevented).toBe(false);
    }
    expect(choose).not.toHaveBeenCalled();
    const choice = firstChoice(host);
    choice.focus();
    press(choice, "y");
    expect(choose).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("ignores consumed, composing, repeated keys and another open dialog", () => {
    const choose = vi.fn();
    const host = mount(() => <PermissionDock title="t" options={options} onChoose={choose} />);
    const choice = firstChoice(host);
    choice.focus();
    const consumed = new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true });
    consumed.preventDefault();
    choice.dispatchEvent(consumed);
    press(choice, "y", { isComposing: true });
    press(choice, "y", { repeat: true });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    press(choice, "y");
    expect(choose).not.toHaveBeenCalled();
    dialog.remove();
    press(choice, "n");
    expect(choose).toHaveBeenCalledExactlyOnceWith("no");
  });
});

// AgentTool was replaced by the work group rows. Subagent calls still render under their parent call.
describe("AgentTool (now WorkGroup steps)", () => {
  const tool = (id: string, status: string, parent: string | null = null): ToolEvent => ({
    kind: "tool", sessionId: "s", toolCallId: id, title: `call ${id}`, status, toolKind: null, parentToolCallId: parent, contentJson: "{}",
  });
  const item = (event: ToolEvent, id: number) => ({ id, kind: "tool" as const, event });
  it("shows subagent progress under the parent call", () => {
    const parent = tool("task", "in_progress");
    const feed = [item(parent, 1), item(tool("a", "completed", "task"), 2), item(tool("b", "in_progress", "task"), 3)];
    const children = workChildren(feed as never, parent);
    expect(children.map((child) => child.toolCallId)).toEqual(["a", "b"]);
    const host = mount(() => <WorkGroup headline="Working" steps={[toStep(parent, children)]} />);
    expect(host.querySelectorAll(".sb-children .sb-child")).toHaveLength(2);
    expect(host.querySelector(".sb-step-glyph .sb-spinner")).not.toBeNull();
  });
  it("renders a plain call without a subagent section", () => {
    const solo = tool("solo", "completed");
    const host = mount(() => <WorkGroup headline="Worked" steps={[toStep(solo, workChildren([item(solo, 1)] as never, solo))]} />);
    expect(host.querySelectorAll(".sb-step")).toHaveLength(1);
    expect(host.querySelector(".sb-children")).toBeNull();
  });
});
