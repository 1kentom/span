import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/agents-page.css"), "utf8");
/** The declarations of every rule whose selector is exactly `selector`, joined. */
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]).join("\n");
};

describe("Agents page wide-window layout", () => {
  it("caps the thread column with a fluid width that grows with the window", () => {
    const thread = rule(".ap-thread");
    expect(thread).toMatch(/--ap-column-cap:\s*clamp\(860px,\s*62vw,\s*1800px\)/);
    expect(thread).toMatch(/--ap-column:\s*min\(100% - 2 \* var\(--ap-gutter\),\s*var\(--ap-column-cap\)\)/);
    expect(thread).toMatch(/--ap-prose:\s*110ch/);
    expect(rule(".ap-thread .agent-feed > *")).toMatch(/max-width:\s*min\(100%,\s*var\(--ap-column-cap\)\)/);
    expect(rule(".ap-thread-composer")).toMatch(/max-width:\s*calc\(var\(--ap-column-cap\) \+ 16px\)/);
  });

  it("keeps no fixed 860px or 1280px cap on the thread column or its blocks", () => {
    expect(css).not.toMatch(/max-width:\s*(calc\()?860px/);
    expect(css).not.toMatch(/--ap-prose:\s*860px/);
    expect(css).not.toMatch(/--ap-wide:\s*1280px/);
    for (const selector of [".ap-thread-empty", ".ap-thread-failure", ".ap-picker"]) expect(rule(selector)).toMatch(/max-width:\s*calc\(var\(--ap-column\) \+ 2 \* var\(--ap-gutter\)\)/);
  });

  it("gives the side panel a proportional default width and a half-window maximum", () => {
    const page = rule(".ap-page");
    expect(page).toMatch(/--ap-side-default:\s*clamp\(420px,\s*24vw,\s*760px\)/);
    expect(page).toMatch(/--ap-side-max:\s*50vw/);
    expect(rule(".ap-side")).toMatch(/width:\s*var\(--ap-side-width,\s*var\(--ap-side-default\)\)/);
  });

  it("uses tokens rather than raw colours", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
