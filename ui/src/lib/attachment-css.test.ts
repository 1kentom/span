import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(process.cwd(), "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const code = walk(src)
  .filter((path) => /\.(tsx?|json)$/.test(path) && !path.endsWith("attachment-css.test.ts") && !path.endsWith("bindings.ts"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const classesIn = (file: string) => {
  const css = readFileSync(resolve(src, "styles", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...css.matchAll(/\.(att-[\w-]+)/g)].map((match) => match[1]))];
};

describe("attachment stylesheet", () => {
  it.each(["attachments.css", "agent.css"])("%s keeps no att- selector that nothing in ui/src uses", (file) => {
    const unused = classesIn(file).filter((name) => !code.includes(name));
    expect(unused).toEqual([]);
  });
  it("no longer carries the picker and viewer body rules of the deleted components", () => {
    const css = readFileSync(resolve(src, "styles/attachments.css"), "utf8");
    for (const name of ["att-picker", "att-line", "att-viewer-body", "att-viewer-image", "att-viewer-text", "att-chip-disabled", "att-dragging-blocked"]) expect(css).not.toContain(name);
  });
});
