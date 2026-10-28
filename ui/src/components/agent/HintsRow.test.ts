import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

  it("puts the mark, the status and the shortcuts on one line that never wraps", () => {
    const mark = readFileSync(resolve("src/styles/agent-mark.css"), "utf8");
    const row = rule(mark, ".agent-footer .agent-statusbar");
    expect(row).toContain("display: flex");
    expect(row).toContain("white-space: nowrap");
    expect(row).toContain("font-size: 11px");
    expect(rule(mark, ".agent-footer .agent-statusbar .sb-hints")).toContain("flex-wrap: nowrap");
  });

  it("uses the pack's motion for each state and honours reduced motion", () => {
    const mark = readFileSync(resolve("src/styles/agent-mark.css"), "utf8");
    expect(mark).toMatch(/thinking"\] > img \{ animation: agent-mark-breathe 1\.8s/);
    expect(mark).toMatch(/running"\] > img \{ animation: agent-mark-orbit 2\.2s/);
    expect(mark).toMatch(/needs"\] > img \{ animation: agent-mark-nudge 2s/);
    expect(mark).toContain("prefers-reduced-motion: no-preference");
  });
});
