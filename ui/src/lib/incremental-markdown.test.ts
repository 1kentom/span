// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseMarkdown, renderMarkdownBlock } from "../components/MarkdownPreview";
import { createIncrementalParser, lastSafeBreak, offsetLines } from "./incremental-markdown";

const parseFrom = (text: string, line: number) => offsetLines(parseMarkdown(text), line);

const context = { documentPath: "/w/.span-agent.md", workspaceRoot: "/w" };
const html = (blocks: ReturnType<typeof parseMarkdown>) => blocks.map((block) => renderMarkdownBlock(block, context)).join("");

const sample = [
  "# Plan",
  "",
  "First paragraph with **bold** and `code`.",
  "",
  "- one",
  "- two",
  "",
  "- loose three",
  "",
  "  continued item text",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted",
  "",
  "Closing words.",
  "",
].join("\n");

describe("incremental markdown", () => {
  it("renders every streamed prefix exactly like a full parse", () => {
    const parse = createIncrementalParser(parseFrom);
    for (let end = 1; end <= sample.length; end += 7) {
      const prefix = sample.slice(0, end);
      expect(html(parse(prefix))).toBe(html(parseMarkdown(prefix)));
    }
    expect(html(parse(sample))).toBe(html(parseMarkdown(sample)));
  });

  it("never breaks inside a fence, before a list item or an indented line", () => {
    expect(lastSafeBreak("```\na\n\nb\n```\n", 0)).toBe(0);
    expect(lastSafeBreak("- a\n\n- b\n", 0)).toBe(0);
    expect(lastSafeBreak("- a\n\n  more\n", 0)).toBe(0);
    expect(lastSafeBreak("one\n\ntwo\n", 0)).toBe(5);
    expect(lastSafeBreak("one\n\ntwo", 0)).toBe(0);
  });

  it("keeps frozen blocks as the same objects", () => {
    const parse = createIncrementalParser(parseFrom);
    const first = parse("alpha\n\nbeta\n\ngam");
    const second = parse("alpha\n\nbeta\n\ngamma rays\n");
    const third = parse("alpha\n\nbeta\n\ngamma rays\n\nand more");
    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).toBe(second[1]);
  });

  it("starts over when the text is replaced", () => {
    const parse = createIncrementalParser(parseFrom);
    parse("alpha\n\nbeta\n\n");
    expect(html(parse("other\n\ntext"))).toBe(html(parseMarkdown("other\n\ntext")));
  });

  it("streams 50k characters without re-parsing the whole text each frame", () => {
    const paragraph = "Streaming answers arrive in small pieces and the renderer must keep up without parsing everything again. ";
    let text = "";
    while (text.length < 50_000) text += `${paragraph.repeat(3)}\n\n`;
    const parse = createIncrementalParser(parseFrom);
    let frames = 0;
    for (let end = 120; end < text.length; end += 120) {
      parse(text.slice(0, end));
      frames++;
    }
    parse(text);
    frames++;
    const fullReparse = (frames * text.length) / 2;
    // Each frame parses only the open tail (one paragraph plus the new chunk) on top of a single pass over the text.
    expect(parse.parsedChars).toBeLessThan(text.length + frames * 600);
    expect(parse.parsedChars).toBeLessThan(fullReparse / 20);
  });
});
