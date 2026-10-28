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

  it("gives the activity bar, docks and drawers the composer's top radius and full width", () => {
    const stacked = block(".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity)");
    expect(stacked).toContain(`border-radius: ${radius}px ${radius}px 0 0`);
    expect(stacked).toMatch(/margin:\s*0;/);
  });

  it("keeps the activity bar text clear of the rounded corner", () => {
    expect(block(".agent-footer > .sb-activity")).toMatch(/padding-inline:\s*(1[4-9]|[2-9]\d)px/);
  });

  it("squares the corners of bars that sit under another bar", () => {
    expect(css).toMatch(/\.agent-footer > :is\(\.sb-drawer, \.sb-activity\) \+ :is\(\.sb-drawer, \.sb-activity, \.sb-dock\) \{\s*border-radius: 0;/);
  });
});
