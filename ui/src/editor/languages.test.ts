import { LanguageSupport } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { loadLanguage, resolveLanguageId } from "./languages";

describe("java language", () => {
  it("maps java extensions, hints and paths", () => {
    expect(resolveLanguageId("", "src/Main.java")).toBe("java");
    expect(resolveLanguageId("", "src/OLD.JAV")).toBe("java");
    expect(resolveLanguageId("java")).toBe("java");
    expect(resolveLanguageId("language-java")).toBe("java");
    expect(resolveLanguageId("", "notes.txt")).toBe("text");
  });

  it("lazily loads a CodeMirror language that parses java", async () => {
    const support = await loadLanguage("java", "Main.java");
    expect(support).toBeInstanceOf(LanguageSupport);
    const language = (support as LanguageSupport).language;
    expect(language.name).toBe("java");
    const tree = language.parser.parse("class A { int x = 1; }");
    expect(tree.length).toBe(22);
    expect(await loadLanguage("java", "Main.java")).toBe(support);
  });
});
