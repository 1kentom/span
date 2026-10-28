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

describe("broad language coverage", () => {
  it("resolves markdown fence names and file names", () => {
    for (const [hint, id] of [["go", "go"], ["golang", "go"], ["c++", "cpp"], ["cpp", "cpp"], ["c#", "csharp"], ["cs", "csharp"], ["kt", "kotlin"], ["rb", "ruby"], ["sql", "sql"], ["postgres", "sql"], ["xml", "xml"], ["docker", "dockerfile"], ["make", "makefile"], ["objc", "objectivec"], ["pwsh", "powershell"], ["tf", "terraform"], ["protobuf", "proto"], ["gql", "graphql"], ["patch", "diff"], ["scss", "css"], ["language-go", "go"], ["fish", "shell"]] as const) expect(resolveLanguageId(hint), hint).toBe(id);
    expect(resolveLanguageId("", "Dockerfile.dev")).toBe("dockerfile");
    expect(resolveLanguageId("", "src/GNUmakefile")).toBe("makefile");
    expect(resolveLanguageId("", "CMakeLists.txt")).toBe("cmake");
    expect(resolveLanguageId("", "go.mod")).toBe("gomod");
    expect(resolveLanguageId("", "Gemfile")).toBe("ruby");
    expect(resolveLanguageId("", "pom.xml")).toBe("xml");
    expect(resolveLanguageId("", ".zshrc")).toBe("shell");
  });

  it("keeps svg on the html grammar and unknown files plain", () => {
    expect(resolveLanguageId("", "logo.svg")).toBe("html");
    expect(resolveLanguageId("", "data.unknownext")).toBe("text");
    expect(resolveLanguageId("constructor", "")).toBe("text");
  });

  it("loads fence grammars for the new languages", async () => {
    for (const name of ["go", "cpp", "sql", "xml", "ruby", "dockerfile", "makefile"]) expect(await loadLanguage(name), name).not.toBeNull();
    expect(await loadLanguage("not-a-language")).toBeNull();
  });
});
