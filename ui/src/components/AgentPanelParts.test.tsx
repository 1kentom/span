// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentMarkdown } from "./AgentMarkdown";

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
