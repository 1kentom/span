import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_COLORS, readBootTheme, rememberBootTheme, THEME_STORAGE_KEY } from "./startup";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const html = read("index.html");
const head = html.slice(0, html.indexOf("</head>"));
const bootCss = read("public/boot.css");
const bootJs = read("public/boot.js");
const workbench = read("src/styles/workbench.css");

const canvasOf = (selector: string) => {
  const rule = workbench.split("\n").find(line => line.startsWith(`${selector}{`));
  return rule?.match(/--canvas:(#[0-9a-f]+)/i)?.[1];
};

describe("first paint before the app bundle runs", () => {
  it("loads the boot stylesheet and theme script in the head as external files", () => {
    expect(head).toMatch(/<link rel="stylesheet" href="\/boot\.css"\s*\/?>/);
    expect(head).toMatch(/<script src="\/boot\.js"><\/script>/);
    // Inline <style> or <script> would get CSP nonces or hashes added by Tauri, which disables 'unsafe-inline'.
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("paints html and body with each theme's canvas colour", () => {
    expect(bootCss).toMatch(new RegExp(`html,\\s*body\\s*\\{[^}]*background:\\s*${CANVAS_COLORS.dark}`));
    expect(bootCss).toMatch(new RegExp(`html\\[data-theme="light"\\][^{]*\\{[^}]*background:\\s*${CANVAS_COLORS.light}`));
    expect(bootCss).toMatch(new RegExp(`html\\[data-theme="purple"\\][^{]*\\{[^}]*background:\\s*${CANVAS_COLORS.purple}`));
  });

  it("keeps the boot colours equal to the workbench canvas tokens", () => {
    expect(canvasOf(".ide")).toBe(CANVAS_COLORS.dark);
    expect(canvasOf(".ide.theme-light")).toBe(CANVAS_COLORS.light);
    expect(canvasOf(".ide.theme-purple")).toBe(CANVAS_COLORS.purple);
  });

  it("sets a readable text colour per theme equal to the workbench text token", () => {
    const tokenOf = (selector: string, token: string) => workbench.split("\n").find(line => line.startsWith(`${selector}{`))?.match(new RegExp(`--${token}:(#[0-9a-f]+)`, "i"))?.[1];
    expect(bootCss).toMatch(new RegExp(`html,\\s*body\\s*\\{[^}]*\\bcolor:\\s*${tokenOf(".ide", "text")}`));
    expect(bootCss).toMatch(new RegExp(`html\\[data-theme="light"\\][^{]*\\{[^}]*\\bcolor:\\s*${tokenOf(".ide.theme-light", "text")}`));
    expect(bootCss).toMatch(new RegExp(`html\\[data-theme="purple"\\][^{]*\\{[^}]*\\bcolor:\\s*${tokenOf(".ide.theme-purple", "text")}`));
  });

  it("shows a plain fallback only when the app entry never ran", () => {
    expect(bootJs).toContain("dataset.spanEntry");
    expect(read("src/index.tsx")).toContain("dataset.spanEntry = \"true\"");
    expect(bootJs).toMatch(/span\.".*span:"|indexOf\("span\."\)/s);
    expect(bootCss).toContain(".boot-fallback");
  });

  it("reads the same storage key the app writes", () => {
    expect(bootJs).toContain(`"${THEME_STORAGE_KEY}"`);
    for (const theme of Object.keys(CANVAS_COLORS)) expect(bootJs).toContain(`"${theme}"`);
  });

  it("remembers only known themes and survives broken storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readBootTheme(storage)).toBeUndefined();
    rememberBootTheme("light", storage);
    expect(readBootTheme(storage)).toBe("light");
    values.set(THEME_STORAGE_KEY, "neon");
    expect(readBootTheme(storage)).toBeUndefined();
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readBootTheme(broken)).toBeUndefined();
    expect(() => rememberBootTheme("dark", broken)).not.toThrow();
  });
});
