import { LanguageSupport } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { loadLanguage } from "./languages";
import { frontMatterEnd } from "./markdown-frontmatter";

async function nodes(text: string): Promise<string[]> {
  const support = await loadLanguage("markdown", "notes.md") as LanguageSupport;
  const names: string[] = [];
  support.language.parser.parse(text).iterate({ enter: (node) => { names.push(node.name); } });
  return names;
}

describe("markdown parser configuration", () => {
  it("parses GFM tables, strikethrough and task lists", async () => {
    const names = await nodes("| a | b |\n| - | - |\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n");
    expect(names).toContain("Table");
    expect(names).toContain("Strikethrough");
    expect(names).toContain("Task");
  });

  it("recognises YAML and TOML front matter with keys and values", async () => {
    const yaml = await nodes("---\ntitle: Hello\n# note\n---\n# Heading\n");
    expect(yaml).toEqual(expect.arrayContaining(["FrontMatter", "FrontMatterMark", "FrontMatterKey", "FrontMatterValue", "FrontMatterComment", "ATXHeading1"]));
    expect(yaml).not.toContain("SetextHeading2");
    const toml = await nodes("+++\ntitle = \"x\"\n+++\ntext\n");
    expect(toml).toEqual(expect.arrayContaining(["FrontMatter", "FrontMatterKey", "FrontMatterValue", "Paragraph"]));
  });

  it("leaves an unclosed or late delimiter alone", async () => {
    expect(await nodes("---\ntext\n")).not.toContain("FrontMatter");
    expect(await nodes("intro\n\n---\na: b\n---\n")).not.toContain("FrontMatter");
    expect(frontMatterEnd("---\na: 1\n...\n", "---")).toBe(2);
    expect(frontMatterEnd("+++\na = 1\n", "+++")).toBe(-1);
  });
});
