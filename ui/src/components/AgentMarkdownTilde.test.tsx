// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseMarkdown, renderMarkdownBlock } from "./MarkdownPreview";

const context = { documentPath: "/workspace/.span-agent.md", workspaceRoot: "/workspace" };
function render(text: string) {
  const root = document.createElement("div");
  root.innerHTML = parseMarkdown(text).map((block) => renderMarkdownBlock(block, context)).join("");
  return root;
}
const struck = (root: HTMLElement) => [...root.querySelectorAll("s, del")].map((node) => node.textContent);

describe("single tildes are never strikethrough", () => {
  it("keeps the reported changed-files line literal", () => {
    const text = "Changed: `styles.css` in ~/a/b, view.fxml, TaskCell.java in ~/c/d";
    const root = render(text);
    expect(struck(root)).toEqual([]);
    expect(root.textContent?.trim()).toBe(text.replaceAll("`", ""));
  });
  it("keeps single tilde pairs around words literal", () => {
    const root = render("Changed: ~styles.css~, ~view.fxml~, ~TaskCell.java~");
    expect(struck(root)).toEqual([]);
    expect(root.textContent).toContain("~styles.css~, ~view.fxml~");
  });
  it("keeps a lone tilde and home paths literal", () => {
    expect(struck(render("about ~5 minutes and ~/x/y or ~/z"))).toEqual([]);
    expect(render("about ~5 minutes").textContent).toContain("~5");
  });
  it("still strikes double tildes", () => {
    expect(struck(render("this is ~~real~~ and ~~also this~~"))).toEqual(["real", "also this"]);
  });
  it("leaves code spans untouched", () => {
    const root = render("`~a~ and ~~b~~` then ~~c~~");
    expect(root.querySelector("code")?.textContent).toBe("~a~ and ~~b~~");
    expect(struck(root)).toEqual(["c"]);
  });
});

// The real cause of the report: Codex names changed files as markdown links
// with absolute paths and line suffixes. Links Span would not open were drawn
// with a line-through, which reads as "deleted". Agent output now opens
// absolute paths inside the workspace (with or without a line suffix), and a
// link that still cannot be opened is plain text, never struck through.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdownDestination } from "./MarkdownPreview";

const agent = { ...context, agentPaths: true };
function renderAgent(text: string) {
  const root = document.createElement("div");
  root.innerHTML = parseMarkdown(text).map((block) => renderMarkdownBlock(block, agent)).join("");
  return root;
}

describe("file links in agent output", () => {
  const reported = "Changed: [styles.css](/workspace/src/main/resources/styles.css), [view.fxml](/workspace/src/main/resources/view.fxml:12), [TaskCell.java](src/main/java/TaskCell.java:40:3)";

  it("opens absolute workspace paths and strips line suffixes", () => {
    const root = renderAgent(reported);
    const files = [...root.querySelectorAll<HTMLAnchorElement>("a[data-markdown-file]")].map((link) => link.dataset.markdownFile);
    expect(files).toEqual(["/workspace/src/main/resources/styles.css", "/workspace/src/main/resources/view.fxml", "/workspace/src/main/java/TaskCell.java"]);
    expect(root.querySelectorAll(".markdown-invalid-link")).toHaveLength(0);
  });

  it("still refuses paths outside the workspace, and the editor preview keeps its relative-only policy", () => {
    expect(markdownDestination("/etc/passwd", agent)).toBeNull();
    expect(markdownDestination("/workspace-other/a.txt", agent)).toBeNull();
    expect(markdownDestination("/workspace/../etc/passwd", agent)).toBeNull();
    expect(markdownDestination("/workspace/src/a.css", context)).toBeNull();
    expect(markdownDestination("src/a.css:12", context)).toBeNull();
  });

  it("never draws an unopenable link with a line-through", () => {
    const css = readFileSync(resolve(__dirname, "../styles/markdown.css"), "utf8");
    const rule = css.match(/\.markdown-invalid-link\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toMatch(/line-through/);
    expect(renderAgent("see [notes](/elsewhere/notes.md)").querySelector("s, del")).toBeNull();
  });
});
