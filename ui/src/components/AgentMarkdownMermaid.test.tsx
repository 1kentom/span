// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { AgentMarkdown } from "./AgentMarkdown";
import { MarkdownPreview } from "./MarkdownPreview";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, text: string) => ({
    svg: `<svg id="${id}" width="220" height="120" xmlns="http://www.w3.org/2000/svg"><text>${text.replace(/[<>&]/g, "")}</text></svg>`,
    diagramType: "flowchart",
  })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  mermaid.initialize.mockClear();
  mermaid.render.mockClear();
});

const fence = "```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```";

describe("Mermaid in Markdown surfaces", () => {
  it("draws a mermaid fence in the editor preview instead of a code block", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    cleanup.push(render(() => <MarkdownPreview text={fence} documentPath="/work/readme.md" workspaceRoot="/work" />, host));
    await vi.waitFor(() => expect(host.querySelector(".markdown-mermaid svg")).not.toBeNull());
    expect(host.querySelector(".markdown-code-block")).toBeNull();
    expect(host.querySelector(".markdown-mermaid-source")?.textContent).toContain("Diagram source");
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it("draws a completed diagram in the agent feed", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    cleanup.push(render(() => <AgentMarkdown text={`Intro\n\n${fence}`} workspaceRoot="/work" />, host));
    await vi.waitFor(() => expect(host.querySelector(".markdown-mermaid svg")).not.toBeNull());
    expect(host.textContent).toContain("Intro");
    expect(host.querySelector("[data-mermaid-code]")?.textContent).toContain("A[Start] --> B[Finish]");
  });

  it("waits for the streaming turn to end before drawing the tail diagram", async () => {
    const [text] = createSignal(fence);
    const [streaming, setStreaming] = createSignal(true);
    const host = document.createElement("div");
    document.body.append(host);
    cleanup.push(render(() => <AgentMarkdown text={text()} workspaceRoot="/work" streaming={streaming()} />, host));
    await vi.waitFor(() => expect(host.querySelector("[data-markdown-mermaid]")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(host.querySelector(".markdown-mermaid svg")).toBeNull();
    setStreaming(false);
    await vi.waitFor(() => expect(host.querySelector(".markdown-mermaid svg")).not.toBeNull());
  });
});
