import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve("src/styles/agent.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is defined`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("composer stack shape", () => {
  const radius = /border-radius:\s*(\d+)px/.exec(block(".agent-composer"))?.[1];

  it("has a composer radius to match", () => {
    expect(Number(radius)).toBeGreaterThan(8);
  });

  it("gives the activity bar, docks and drawers one compact tab shape: inset on both sides, smaller top radius than the composer", () => {
    const stacked = block(".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity)");
    const inset = Number(/margin:\s*0\s+(\d+)px;/.exec(stacked)?.[1]);
    const tabRadius = Number(/border-radius:\s*(\d+)px\s+\1px\s+0\s+0/.exec(stacked)?.[1]);
    expect(inset).toBeGreaterThanOrEqual(8);
    expect(inset).toBeLessThanOrEqual(20);
    expect(tabRadius).toBeGreaterThanOrEqual(8);
    expect(tabRadius).toBeLessThan(Number(radius));
  });

  it("keeps the activity bar text clear of the rounded corner", () => {
    expect(block(".agent-footer > .sb-activity")).toMatch(/padding-inline:\s*(1[2-9]|[2-9]\d)px/);
  });

  it("squares the corners of every bar that sits under another bar, so only the top of the stack is rounded", () => {
    // General sibling: a dock under a dock, or the activity bar under the queue with a running step between, is square too.
    expect(block(".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity) ~ :is(.sb-drawer, .sb-dock, .sb-activity)")).toMatch(/border-radius:\s*0;/);
  });

  it("styles the stacked bars with that one rule only, never a second margin or radius for one of them", () => {
    const sidebar = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");
    const shared = ".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity)";
    for (const source of [css, sidebar]) {
      const rules = [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)];
      for (const [, selector, body] of rules) {
        const sel = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (!sel.startsWith(".agent-footer") || !/\.sb-(drawer|dock|activity)\b/.test(sel)) continue;
        if (sel === shared || sel.startsWith(`${shared} ~`)) continue;
        expect(body, `${sel} must not set its own margin or radius`).not.toMatch(/(^|;|\s)(margin|border-radius)\s*:/);
      }
    }
  });
});

describe("stacked bars line up", () => {
  it("lets a bar below another keep the inset, so every bar in the stack is the same width", () => {
    const below = block(".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity) ~ :is(.sb-drawer, .sb-dock, .sb-activity)");
    expect(below).not.toMatch(/margin/);
    expect(below).toMatch(/border-radius:\s*0;/);
  });
});
