import { highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { loadLanguage } from "./languages";
import { SYNTAX_SAMPLES } from "./syntax-sample";
import { LANGUAGE_STYLE_TAGS, TAG_TOKENS, syntaxHighlightStyle, tokenClassHighlighter } from "./syntax-highlight";
import { SYNTAX_TOKENS } from "./syntax-palette";
import { LanguageSupport } from "@codemirror/language";

async function tokens(hint: string, path: string, source: string): Promise<Array<{ text: string; token: string }>> {
  const support = await loadLanguage(hint, path);
  const language = support instanceof LanguageSupport ? support.language : support;
  if (!language) throw new Error(`no language for ${hint}`);
  const tree = language.parser.parse(source);
  const found: Array<{ text: string; token: string }> = [];
  highlightTree(tree, tokenClassHighlighter, (from, to, classes) => {
    for (const name of classes.split(" ")) if (name.startsWith("syn-")) found.push({ text: source.slice(from, to), token: name.slice(4) });
  });
  return found;
}

const has = (found: Array<{ text: string; token: string }>, text: string, token: string) =>
  found.some((entry) => entry.text === text && entry.token === token);

describe("Lezer tag table", () => {
  it("only names known tokens and reaches every token", () => {
    const used = new Set(TAG_TOKENS.map(([, token]) => token));
    for (const token of used) expect(SYNTAX_TOKENS).toContain(token);
    expect([...SYNTAX_TOKENS].filter((token) => !used.has(token))).toEqual([]);
  });

  it("produces one style rule per tag with a token variable", () => {
    expect(syntaxHighlightStyle.specs.length).toBeGreaterThan(40);
    for (const spec of syntaxHighlightStyle.specs) {
      const color = (spec as { color?: string }).color;
      if (color) expect(color).toMatch(/^var\(--syn-[a-zA-Z]+\)$/);
    }
    expect(Object.keys(LANGUAGE_STYLE_TAGS).sort()).toEqual(["java", "python", "rust", "typescript"]);
  });
});

describe("Lezer trees get the same token ids as tree-sitter spans", () => {
  it("distinguishes java imports, annotations and declarations", async () => {
    const found = await tokens("java", "Main.java", SYNTAX_SAMPLES.java);
    expect(has(found, "import", "keyword")).toBe(true);
    expect(has(found, "javafx.scene.control", "importPath")).toBe(true);
    expect(has(found, "ButtonType", "class")).toBe(true);
    expect(has(found, "com.example.app", "namespace")).toBe(true);
    expect(has(found, "@FXML", "annotation")).toBe(true);
    expect(has(found, "MainController", "class")).toBe(true);
    expect(has(found, "items", "property")).toBe(true);
    expect(has(found, "values", "parameter")).toBe(true);
    expect(has(found, "pick", "method")).toBe(true);
    expect(has(found, "println", "method")).toBe(true);
    expect(has(found, "return", "controlKeyword")).toBe(true);
    expect(has(found, "int", "type")).toBe(true);
    expect(has(found, "10", "number")).toBe(true);
  });

  it("distinguishes typescript modules, types and decorators", async () => {
    const found = await tokens("typescript", "main.tsx", SYNTAX_SAMPLES.typescript);
    expect(has(found, '"react"', "importPath")).toBe(true);
    expect(has(found, "Service", "class")).toBe(true);
    expect(has(found, "Handler", "interface")).toBe(true);
    expect(has(found, "Mode", "enum")).toBe(true);
    expect(has(found, "@", "annotation")).toBe(true);
    expect(has(found, "count", "parameter")).toBe(true);
  });

  it("distinguishes python decorators and classes, rust attributes and traits", async () => {
    const python = await tokens("python", "main.py", SYNTAX_SAMPLES.python);
    expect(has(python, "@", "annotation")).toBe(true);
    expect(has(python, "Config", "class")).toBe(true);
    expect(has(python, "count", "parameter")).toBe(true);
    const rust = await tokens("rust", "main.rs", SYNTAX_SAMPLES.rust);
    expect(has(rust, "std", "importPath")).toBe(true);
    expect(rust.some((entry) => entry.text.startsWith("#[derive") && entry.token === "annotation")).toBe(true);
    expect(has(rust, "Handler", "interface")).toBe(true);
    expect(has(rust, "Config", "class")).toBe(true);
  });
});
