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

describe("agent sidebar colours come only from theme tokens", () => {
  const themeTokens = ["success", "warning", "error", "accentFill", "accentFillHover", "onAccent"];
  it.each([".ide{", ".ide.theme-light{", ".ide.theme-purple{"])("%s defines the status and accent fill tokens", selector => {
    const line = block(selector);
    for (const token of themeTokens) expect(line, token).toMatch(new RegExp(`--${token}:#[0-9a-f]{3,6}[;}]`, "i"));
  });
  it.each(["agent-sidebar.css", "agent.css"])("%s has no hard-coded hex colours", name => {
    const source = readFileSync(resolve(root, `src/styles/${name}`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });
});

/** WCAG 2.x relative luminance contrast of two #rgb or #rrggbb colours. */
function contrast(a: string, b: string): number {
  const channel = (hex: string) => {
    const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
    return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  };
  const lum = (hex: string) => { const [r, g, bl] = channel(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [high, low] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe("agent sidebar text contrast reaches 4.5:1 in every theme", () => {
  const values = (selector: string) => Object.fromEntries([...block(selector).matchAll(/--([A-Za-z]+):(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1], m[2]]));
  const dark = values(".ide{");
  const themes: Record<string, Record<string, string>> = { Dark: dark, Light: { ...dark, ...values(".ide.theme-light{") }, Purple: { ...dark, ...values(".ide.theme-purple{") } };
  const sidebar = readFileSync(resolve(root, "src/styles/agent-sidebar.css"), "utf8");
  /** The theme token a sidebar variable points at, for example `--sb-faint: var(--dim)` gives `dim`. */
  const target = (name: string) => sidebar.match(new RegExp(`--${name}:\\s*var\\(--([A-Za-z]+)\\)`))?.[1];
  it.each(Object.keys(themes))("%s", (theme) => {
    const t = themes[theme];
    const meta = target("sb-faint");
    expect(meta).toBeDefined();
    for (const surface of ["island", "popup", "accentDock"]) expect(contrast(t[meta!], t[surface]), `meta text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(target("sb-accent-fill")).toBe("accentFill");
    expect(contrast(t.onAccent, t.accentFill), "text on filled accent buttons").toBeGreaterThanOrEqual(4.5);
    for (const status of ["success", "warning", "error"]) expect(contrast(t[status], t.island), status).toBeGreaterThanOrEqual(4.5);
    expect(t.accent, "the app-wide accent is unchanged").toBe("#726cf9");
  });
});
