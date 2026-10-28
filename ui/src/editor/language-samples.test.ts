import { LanguageSupport } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { LANGUAGE_SAMPLES } from "./language-samples";
import { hasGrammar, loadLanguage, resolveLanguageId, type LanguageId } from "./languages";

async function classes(id: LanguageId) {
  const sample = LANGUAGE_SAMPLES[id]!;
  const support = await loadLanguage(id, sample.file);
  const language = support instanceof LanguageSupport ? support.language : support!;
  const found = new Map<string, number>();
  let covered = 0;
  highlightTree(language.parser.parse(sample.code), classHighlighter, (from, to, cls) => {
    covered += to - from;
    for (const name of cls.split(" ")) found.set(name, (found.get(name) ?? 0) + (to - from));
  });
  return { found, covered, total: sample.code.replace(/\s/g, "").length };
}

const commented = new Set<string>("go c cpp php ruby sql xml dockerfile makefile cmake lua yaml terraform graphql powershell batch scala haskell elixir ini perl r groovy objectivec erlang clojure less proto".split(" "));

describe("language samples", () => {
  const ids = Object.keys(LANGUAGE_SAMPLES) as LanguageId[];

  it("has a sample for every new language with a grammar", () => {
    for (const id of ["go", "c", "cpp", "csharp", "kotlin", "swift", "php", "ruby", "sql", "xml", "dockerfile", "makefile", "lua", "yaml"] as LanguageId[]) expect(LANGUAGE_SAMPLES[id], id).toBeDefined();
  });

  for (const id of ids) {
    it(`${id} sample resolves from its file name and colours several token kinds`, async () => {
      const sample = LANGUAGE_SAMPLES[id]!;
      expect(hasGrammar(id)).toBe(true);
      expect(resolveLanguageId("", sample.file)).toBe(id);
      const { found, covered, total } = await classes(id);
      expect(found.size, [...found.keys()].join(",")).toBeGreaterThanOrEqual(3);
      expect(covered / total, `${id} coloured share`).toBeGreaterThan(0.1);
      if (commented.has(id)) expect(found.has("tok-comment"), `${id} comment`).toBe(true);
    });
  }
});
