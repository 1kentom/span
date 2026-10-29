import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { LANGUAGE_FALLBACK_ICON, languageIconFor, languageIconRender, languageLogoKeys, serverLanguage } from "./language-icons";
import { bestContrast, contrast, paintedColors, parseColor, MIN_LOGO_CONTRAST } from "./svg-paint";
import { iconAssetPath } from "./menuIcons";
import { serverOrder } from "./language-intelligence-copy";

const dir = resolve("public/icons/languages");
const provenance = JSON.parse(readFileSync(resolve(dir, "provenance.json"), "utf8"));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The real surface tokens of each theme, read from the stylesheet rather than copied into the test. */
function surfaces(): Record<string, Record<string, string>> {
  const css = readFileSync(resolve("src/styles/workbench.css"), "utf8");
  const out: Record<string, Record<string, string>> = {};
  for (const match of css.matchAll(/\.ide(\.theme-([a-z]+))?\{(--curLine[^}]*)\}/g)) {
    const theme = match[2] ?? "dark";
    out[theme] = Object.fromEntries(["canvas", "island", "popup"].map(token => [token, new RegExp(`--${token}:(#[0-9a-f]{3,6})`).exec(match[3])![1]]));
  }
  return out;
}

describe("language icon lookup", () => {
  it("resolves editor language ids, aliases and language server ids to one logo", () => {
    expect(languageIconFor("rust")?.src).toBe("/icons/languages/rust-original.svg");
    expect(languageIconFor("rust-analyzer")?.key).toBe("rust");
    expect(languageIconFor("html")?.key).toBe("html5");
    expect(languageIconFor("scss")?.key).toBe("sass");
    expect(languageIconFor("jsonc")?.key).toBe("json");
    expect(languageIconFor("shell")?.key).toBe("bash");
    expect(languageIconFor("cpp")?.key).toBe("cplusplus");
    expect(languageIconFor("graphql")?.src).toBe("/icons/languages/graphql-plain.svg");
    expect(languageIconFor(" TypeScript ")?.key).toBe("typescript");
  });
  it("covers every server in the catalog and the common editor languages", () => {
    for (const id of serverOrder) expect(languageIconFor(id), id).toBeDefined();
    for (const id of serverOrder) expect(languageIconFor(serverLanguage(id)), id).toBeDefined();
    // Servers proposed in other work (Svelte, Vue, Astro) resolve by their own id.
    for (const id of ["svelte", "vue", "astro"]) expect(languageIconFor(id), id).toBeDefined();
    for (const id of ["javascript", "python", "go", "c", "cpp", "markdown", "yaml", "toml", "shell", "kotlin", "swift", "php", "ruby", "csharp", "dockerfile", "lua"]) expect(languageIconFor(id), id).toBeDefined();
  });
  it("returns nothing for unknown languages, which then use the vendored neutral glyph", () => {
    expect(languageIconFor("text")).toBeUndefined();
    expect(languageIconFor("less")).toBeUndefined();
    expect(languageIconFor(undefined)).toBeUndefined();
    expect(languageIconFor("__proto__")).toBeUndefined();
    expect(iconAssetPath(LANGUAGE_FALLBACK_ICON)).toBe("/icons/language-unknown.svg");
  });
  it("draws the dark rendering on the purple theme", () => {
    const rust = languageIconFor("rust")!;
    expect(languageIconRender(rust, "Light")).toBe("color");
    expect(languageIconRender(rust, "Dark")).toBe("mono");
    expect(languageIconRender(rust, "Purple")).toBe("mono");
  });
});

describe("vendored devicon artwork", () => {
  it("pins one upstream commit, ships its MIT license and lists exactly the logos the app uses", () => {
    expect(provenance.repository).toBe("https://github.com/devicons/devicon");
    expect(provenance.commit).toMatch(/^[0-9a-f]{40}$/);
    const license = readFileSync(resolve(dir, provenance.licenseFile), "utf8");
    expect(license).toMatch(/^The MIT License/);
    expect(provenance.assets.map((asset: { key: string }) => asset.key).sort()).toEqual([...languageLogoKeys].sort());
    expect(JSON.stringify(provenance)).not.toMatch(/\/Users\/|[A-Z]:\\/);
  });
  it("keeps every file byte-identical to the pinned source and free of active content", () => {
    for (const asset of provenance.assets) {
      const path = resolve(dir, asset.file);
      expect(asset.source).toBe(`https://raw.githubusercontent.com/devicons/devicon/${provenance.commit}/icons/${asset.key}/${asset.file}`);
      expect(sha(path), asset.file).toBe(asset.sha256);
      expect(languageIconFor(asset.key)?.src).toBe(`/icons/languages/${asset.file}`);
      const svg = readFileSync(path, "utf8");
      expect(svg).not.toMatch(/<(?:script|foreignObject|image|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i);
      expect(svg).not.toMatch(/(?:href|xlink:href)\s*=\s*["'](?!#)/i);
    }
  });
  it("renders a logo in color on a theme only when it stays visible on every surface token of that theme", () => {
    const themes = surfaces();
    expect(Object.keys(themes).sort()).toEqual(["dark", "light", "purple"]);
    for (const asset of provenance.assets) {
      const svg = readFileSync(resolve(dir, asset.file), "utf8");
      const visible = (theme: string) => Object.values(themes[theme]).every(surface => bestContrast(svg, parseColor(surface)!) >= MIN_LOGO_CONTRAST);
      const expected = { light: visible("light") ? "color" : "mono", dark: visible("dark") && visible("purple") ? "color" : "mono" };
      expect(asset.render, asset.key).toEqual(expected);
      const icon = languageIconFor(asset.key)!;
      expect({ light: icon.light, dark: icon.dark }, asset.key).toEqual(expected);
    }
    // The marks that motivated the rule: black artwork must not be drawn as is on dark surfaces.
    expect(languageIconFor("rust")!.dark).toBe("mono");
    expect(languageIconFor("markdown")!.dark).toBe("mono");
  });
});

describe("neutral fallback glyph", () => {
  it("is the unchanged Iconsax file recorded in its provenance", () => {
    const record = JSON.parse(readFileSync(resolve("public/icons/language-fallback-provenance.json"), "utf8"));
    const asset = record.assets[0];
    expect(asset.asset).toBe("language-unknown.svg");
    expect(asset.sourceSha256).toBe(asset.assetSha256);
    expect(sha(resolve("public/icons/language-unknown.svg"))).toBe(asset.assetSha256);
    expect(readFileSync(resolve("public/icons/language-unknown.svg"), "utf8")).toContain('stroke="currentColor"');
    expect(existsSync(resolve("public/icons/languages/language-unknown.svg"))).toBe(false);
  });
});

describe("svg paint reader", () => {
  it("follows inheritance, gradients, style attributes and the default black fill", () => {
    const colors = (svg: string) => paintedColors(svg).map(color => color.join(","));
    expect(colors('<svg><path d="M0 0"/></svg>')).toEqual(["0,0,0"]);
    expect(colors('<svg><g fill="#fff"><path d="M0 0"/></g></svg>')).toEqual(["255,255,255"]);
    expect(colors('<svg><path style="fill:#f00" d="M0 0"/><path fill="none" stroke="#00f"/></svg>')).toEqual(["255,0,0", "0,0,255"]);
    expect(colors('<svg><linearGradient id="a"><stop offset="0"/><stop stop-color="#fff"/></linearGradient><path fill="url(#a)"/></svg>')).toEqual(["0,0,0", "255,255,255"]);
    expect(colors('<svg><defs><path id="x" fill="#123456"/></defs></svg>')).toEqual([]);
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  });
});
