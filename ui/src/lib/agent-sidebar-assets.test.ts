import { readFileSync, existsSync } from "node:fs";
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

describe("agent sidebar theme tokens", () => {
  const tokens = ["diffAdd", "diffAddText", "diffAddGutter", "diffDel", "diffDelText", "diffDelGutter", "amberSurface", "amberBorder", "redSurface", "redBorder", "accentDock"];
  it.each([".ide{", ".ide.theme-light{", ".ide.theme-purple{"])("%s defines every token", selector => {
    const line = block(selector);
    expect(line).not.toBe("");
    for (const token of tokens) expect(line, token).toContain(`--${token}:`);
  });
});
