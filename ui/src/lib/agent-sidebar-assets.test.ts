import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const css = readFileSync(resolve(root, "src/styles/workbench.css"), "utf8");
const block = (selector: string) => css.split("\n").find(line => line.startsWith(selector)) ?? "";

describe("agent sidebar icons", () => {
  it("vendors the sidebar icons as separate files, with chevron-only arrows", () => {
    for (const name of ["Gps", "Gallery", "Maximize4", "3DotsMore", "arrow-up3", "arrow-down4", "arrow-right4", "arrow-left4"]) {
      const file = resolve(root, `public/icons/${name}.svg`);
      expect(existsSync(file), name).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).not.toMatch(/c2pa|<script|href=/i);
    }
  });
});

describe("agent sidebar icon references", () => {
  it("only names icons that exist in public/icons", () => {
    const sources = ["src/components/AgentPanel.tsx", ...["agent", "attachments"].flatMap((dir) => readdirSync(resolve(root, `src/components/${dir}`)).filter((name) => name.endsWith(".tsx") && !name.includes(".test.")).map((name) => `src/components/${dir}/${name}`))];
    const names = new Set<string>();
    for (const source of sources) {
      const text = readFileSync(resolve(root, source), "utf8");
      for (const tag of text.match(/<Icon\b[^>]*?name=(?:"[^"]*"|\{[^}]*\})/g) ?? []) for (const [, name] of tag.matchAll(/(?<![=!]==\s*)"([A-Za-z0-9-]+)"/g)) names.add(name);
      for (const map of text.match(/(?:KIND_ICON|kindIcons)[^=]*=\s*\{[^}]*\}/g) ?? []) for (const [, name] of map.matchAll(/:\s*"([A-Za-z0-9-]+)"/g)) names.add(name);
    }
    expect(names.size).toBeGreaterThan(10);
    for (const name of names) expect(existsSync(resolve(root, `public/icons/${name}.svg`)), name).toBe(true);
  });
});

describe("agent sidebar theme tokens", () => {
  const tokens = ["diffAdd", "diffAddText", "diffAddGutter", "diffDel", "diffDelText", "diffDelGutter", "amberSurface", "amberBorder", "redSurface", "redBorder", "accentDock"];
  it.each([".ide{", ".ide.theme-light{", ".ide.theme-purple{"])("%s defines every token", selector => {
    const line = block(selector);
    expect(line).not.toBe("");
    for (const token of tokens) expect(line, token).toContain(`--${token}:`);
  });
});
