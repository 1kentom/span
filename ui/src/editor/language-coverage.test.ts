import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasGrammar, languageIds, loadLanguage, noHighlightingYet, resolveLanguageId } from "./languages";
import { languageDisplayName, languageNames } from "./language-names";

const source = readFileSync(resolve(process.cwd(), "../crates/core/src/buffer.rs"), "utf8");
const body = (name: string) => {
  const start = source.indexOf(`fn ${name}(`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
};
const arms = (name: string, wrap: (id: string) => string) => {
  const result: { keys: string[]; id: string }[] = [];
  for (const line of body(name).split("\n")) {
    const match = /^\s*((?:"[^"]+"(?:\s*\|\s*)?)+)\s*=>\s*(.+?),?$/.exec(line);
    if (!match) continue;
    const id = new RegExp(wrap("([a-z]+)")).exec(match[2])?.[1];
    if (id) result.push({ keys: [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), id });
  }
  return result;
};
const byExtension = arms("language_by_extension", (id) => `^"${id}"$`);
const byFilename = arms("language_by_filename", (id) => `^Some\\("${id}"\\)$`);
const rustIds = new Set([...byExtension, ...byFilename].map((arm) => arm.id));
for (const id of ["dotenv", "dockerfile", "text"]) rustIds.add(id);

// Rust ids that the UI resolves under a different, more specific id.
const uiId = (rust: string) => (rust === "scss" ? "css" : rust);

describe("rust and typescript language tables agree", () => {
  it("parses a plausible number of rust arms", () => {
    expect(byExtension.length).toBeGreaterThan(40);
    expect(byFilename.length).toBeGreaterThan(5);
    expect(rustIds.has("go") && rustIds.has("typescript") && rustIds.has("gomod")).toBe(true);
  });

  it("gives every rust language id a grammar loader or an explicit no highlighting entry", () => {
    for (const id of rustIds) {
      if (id === "text") continue;
      expect(hasGrammar(uiId(id)) || noHighlightingYet.includes(id), id).toBe(true);
    }
    for (const id of noHighlightingYet) expect(hasGrammar(id), `${id} should not also have a grammar`).toBe(false);
  });

  it("resolves every rust extension and file name to the same language in the editor", () => {
    for (const { keys, id } of byExtension) {
      if (noHighlightingYet.includes(id) || id === "text") continue;
      for (const key of keys) {
        // Rust folds jsonc into json and the UI keeps jsonc separate.
        const expected = key === "jsonc" ? "jsonc" : uiId(id);
        expect(resolveLanguageId(id, `file.${key}`), key).toBe(expected);
        expect(resolveLanguageId("", `file.${key.toUpperCase()}`), key).toBe(expected);
      }
    }
    for (const { keys, id } of byFilename) for (const key of keys) expect(resolveLanguageId("text", `/p/${key}`), key).toBe(id);
  });

  it("falls back to the rust id as a hint when the path has no known extension", () => {
    for (const id of rustIds) {
      if (id === "text" || noHighlightingYet.includes(id)) continue;
      expect(resolveLanguageId(id, "untitled"), id).toBe(uiId(id));
    }
  });

  it("has a display name for every rust id and every editor id", () => {
    for (const id of [...rustIds, ...languageIds, ...noHighlightingYet]) expect(Object.hasOwn(languageNames, id), id).toBe(true);
  });

  it("lazily builds a grammar for every editor id that has one", async () => {
    for (const id of languageIds) {
      if (!hasGrammar(id)) continue;
      const support = await loadLanguage(id, id === "jsonc" ? "x.jsonc" : "");
      expect(support, id).not.toBeNull();
    }
  });
});

describe("display names", () => {
  it("uses friendly names", () => {
    expect(languageDisplayName("cpp")).toBe("C++");
    expect(languageDisplayName("csharp")).toBe("C#");
    expect(languageDisplayName("objectivec")).toBe("Objective-C");
    expect(languageDisplayName("typescript")).toBe("TypeScript");
    expect(languageDisplayName("text")).toBe("Plain text");
    expect(languageDisplayName("dockerfile")).toBe("Dockerfile");
    expect(languageDisplayName("makefile")).toBe("Makefile");
    expect(languageDisplayName("shell")).toBe("Shell script");
    expect(languageDisplayName("")).toBe("Plain text");
    expect(languageDisplayName("somethingnew")).toBe("Somethingnew");
  });
});
