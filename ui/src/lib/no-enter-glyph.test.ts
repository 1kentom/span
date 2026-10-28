import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Enter key is always the library return icon (KeyGlyph renders `key-enter`), never a text glyph.
 * Only two places may hold the glyph as data: the KeyGlyph module's own constants, and the key lists in
 * agent-hints.ts, which ComposerHints renders through KeyGlyph. Everything else passes ENTER_KEY.
 */
const GLYPH = /[↵↩⏎]|\\u(21b5|21a9|23ce)/i;
const roots = ["src/components", "src/lib"].map((dir) => resolve(dir));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Drop comments (keeping line numbers) so prose about the glyph does not count. Good enough for this codebase's sources. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

function offenders(file: string, source: string): string[] {
  const name = relative(resolve("src"), file).replaceAll("\\", "/");
  let code = stripComments(source);
  if (name === "components/agent/KeyGlyph.tsx") {
    code = code.replace(/export const ENTER_KEY = "[^"]*";/, "").replace(/const ENTER_GLYPHS = new Set\(\[[^\]]*\]\);/, "");
  }
  if (name === "lib/agent-hints.ts") code = code.replace(/keys:\s*\[[^\]]*\]/g, "keys: []");
  return code
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => GLYPH.test(line))
    .map(({ line, index }) => `${name}:${index + 1}: ${line.trim()}`);
}

describe("no Enter text glyph in the UI", () => {
  const files = roots.flatMap(sources);

  it("scans the component and lib sources", () => {
    expect(files.some((file) => file.endsWith("Docks.tsx"))).toBe(true);
    expect(files.some((file) => file.endsWith("agent-hints.ts"))).toBe(true);
  });

  it("renders every visible Enter key cap through KeyGlyph", () => {
    const found = files.flatMap((file) => offenders(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });

  it("catches a raw glyph in a key cap, an escaped glyph in a JSX attribute, and glyph data outside the hint lists", () => {
    const file = resolve("src/components/agent/Example.tsx");
    expect(offenders(file, `<kbd class="sb-hotkey">↵</kbd>`)).toHaveLength(1);
    expect(offenders(file, `<KeyGlyph value="\\u21b5" />`)).toHaveLength(1);
    expect(offenders(file, `const KEYS = [{ keys: ["⌥", "↩"] }];`)).toHaveLength(1);
    expect(offenders(file, `// ↵ in a comment is fine`)).toEqual([]);
    expect(offenders(resolve("src/lib/agent-hints.ts"), `send.push({ keys: ["↵"], label: "Send" });`)).toEqual([]);
    expect(offenders(resolve("src/lib/agent-hints.ts"), `const label = "↵ Send";`)).toHaveLength(1);
  });
});
