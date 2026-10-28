import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LOW_CONTRAST_TOKENS, SYNTAX_TOKENS, THEME_BACKGROUNDS, applyPalette, clearPalette, contrastRatio, cssVariable, defaultPalette,
  isValidColor, sanitizeOverrides, type SyntaxTheme,
} from "./syntax-palette";

const themes: SyntaxTheme[] = ["dark", "light", "purple"];
const root = (theme: SyntaxTheme) => {
  const element = document.createElement("div");
  element.setAttribute("data-theme", theme);
  return element;
};

describe("syntax token list", () => {
  it("has the 30 documented ids in order", () => {
    expect(SYNTAX_TOKENS).toHaveLength(30);
    expect(new Set(SYNTAX_TOKENS).size).toBe(30);
    expect(SYNTAX_TOKENS.slice(0, 3)).toEqual(["keyword", "controlKeyword", "operator"]);
    expect(cssVariable("importPath")).toBe("--syn-importPath");
  });

  it("matches the Rust token table", () => {
    const source = readFileSync(resolve(__dirname, "../../../crates/syntax/src/tokens.rs"), "utf8");
    const block = /TOKEN_IDS: \[&str; \d+\] = \[([^\]]+)\]/.exec(source)?.[1] ?? "";
    expect([...block.matchAll(/"(\w+)"/g)].map((match) => match[1])).toEqual([...SYNTAX_TOKENS]);
  });
});

describe("default palettes", () => {
  it.each(themes)("%s defines every token with a valid colour", (theme) => {
    const palette = defaultPalette(theme);
    expect(Object.keys(palette).sort()).toEqual([...SYNTAX_TOKENS].sort());
    for (const id of SYNTAX_TOKENS) expect(isValidColor(palette[id]), `${theme}.${id}`).toBe(true);
  });

  it.each(themes)("%s meets WCAG AA against the editor background", (theme) => {
    const palette = defaultPalette(theme);
    const failures = SYNTAX_TOKENS.flatMap((id) => {
      const minimum = LOW_CONTRAST_TOKENS.includes(id) ? 3 : 4.5;
      const ratio = contrastRatio(palette[id], THEME_BACKGROUNDS[theme]);
      return ratio >= minimum ? [] : [`${id} ${palette[id]} ${ratio.toFixed(2)} < ${minimum}`];
    });
    expect(failures).toEqual([]);
  });

  it("also passes on the light editor fallback background", () => {
    const palette = defaultPalette("light");
    for (const id of SYNTAX_TOKENS) expect(contrastRatio(palette[id], "#faf9f7")).toBeGreaterThanOrEqual(LOW_CONTRAST_TOKENS.includes(id) ? 3 : 4.5);
  });

  it("keeps the new tokens visually distinct from each other", () => {
    for (const theme of themes) {
      const palette = defaultPalette(theme);
      const distinct = ["namespace", "importPath", "annotation", "class", "interface", "enum", "typeParameter", "parameter", "property", "constant"] as const;
      expect(new Set(distinct.map((id) => palette[id])).size, theme).toBe(distinct.length);
    }
  });

  it("matches the stylesheet defaults and the tree-sitter classes", () => {
    const css = readFileSync(resolve(__dirname, "../styles/syntax.css"), "utf8");
    const selectors: Record<SyntaxTheme, string> = { dark: '.span-editor[data-theme="dark"]', light: '.span-editor[data-theme="light"]', purple: '.span-editor[data-theme="purple"]' };
    for (const theme of themes) {
      const block = new RegExp(`${selectors[theme].replace(/[[\]"]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      for (const id of SYNTAX_TOKENS) expect(block, `${theme} --syn-${id}`).toContain(`--syn-${id}: ${defaultPalette(theme)[id]};`);
    }
    for (const id of SYNTAX_TOKENS) expect(css).toContain(`.span-editor .cm-tree-${id} { color: var(--syn-${id});`);
  });
});

describe("applyPalette", () => {
  it("validates colours", () => {
    for (const ok of ["#abc", "#AABBCC", "#aabbccdd"]) expect(isValidColor(ok)).toBe(true);
    for (const bad of ["red", "#abcd1", "abc", "rgb(1,2,3)", "#12", "url(x)", "", 12, null]) expect(isValidColor(bad)).toBe(false);
  });

  it("sets valid overrides and ignores unknown ids and invalid values", () => {
    const element = root("dark");
    applyPalette(element, "dark", { importPath: "#112233", keyword: "red", nonsense: "#fff" } as never);
    expect(element.style.getPropertyValue("--syn-importPath")).toBe("#112233");
    expect(element.style.getPropertyValue("--syn-keyword")).toBe("");
    expect(element.style.getPropertyValue("--syn-nonsense")).toBe("");
  });

  it("removes a variable again when the override disappears", () => {
    const element = root("light");
    applyPalette(element, "light", { string: "#010203" });
    expect(element.style.getPropertyValue("--syn-string")).toBe("#010203");
    applyPalette(element, "light", {});
    expect(element.style.getPropertyValue("--syn-string")).toBe("");
  });

  it("writes theme defaults inline when the root carries another theme", () => {
    const element = root("dark");
    applyPalette(element, "purple", {});
    expect(element.style.getPropertyValue("--syn-keyword")).toBe(defaultPalette("purple").keyword);
    clearPalette(element);
    expect(element.style.getPropertyValue("--syn-keyword")).toBe("");
  });

  it("normalises override colours", () => {
    expect(sanitizeOverrides({ class: " #ABCDEF " })).toEqual({ class: "#abcdef" });
    expect(sanitizeOverrides("nope")).toEqual({});
  });
});
