import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agent = readFileSync(resolve("src/styles/agent.css"), "utf8");
const sidebar = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is defined`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("hints row under the composer", () => {
  it("draws the Enter key icon with its arrow on the lower line", () => {
    expect(rule(sidebar, ".key-enter")).toContain("transform: scaleY(-1)");
  });

  it("keeps each key and its label together and spaces the hints evenly", () => {
    expect(rule(sidebar, ".agent-footer .sb-hint")).toContain("white-space: nowrap");
    expect(rule(sidebar, ".agent-footer .sb-hints")).toMatch(/gap:\s*6px 14px/);
    expect(rule(sidebar, ".agent-footer .sb-hint-key")).toMatch(/height:\s*18px/);
  });

  it("starts the status line with a state dot that turns accent while a turn runs", () => {
    expect(rule(agent, ".agent-composer-hint::before")).toMatch(/border-radius:\s*50%/);
    expect(rule(agent, ".agent-composer-hint.running::before")).toContain("var(--sb-accent)");
    expect(rule(agent, ".agent-composer-hint")).toContain("font-size: 11px");
  });
});
