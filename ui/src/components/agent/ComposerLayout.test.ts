import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(process.env.AGENT_CSS_FILE ?? resolve("src/styles/agent.css"), "utf8");

/** Declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (!match) throw new Error(`missing rule ${selector}`);
  return match[1];
}
const has = (body: string, declaration: string) => expect(body.replace(/\s+/g, " ")).toContain(declaration);

describe("composer layout rules", () => {
  it("lets the prompt textarea wrap long unbroken text and never scroll sideways", () => {
    const body = rule(".agent-input");
    has(body, "overflow-x: hidden");
    has(body, "overflow-wrap: anywhere");
    has(body, "white-space: pre-wrap");
    has(body, "min-width: 0");
    expect(body).not.toMatch(/overflow:\s*auto/);
  });
  it("wraps attachment tiles instead of scrolling the tray sideways, and hides an empty tray", () => {
    const tray = rule(".agent-composer .att-tray");
    has(tray, "flex-wrap: wrap");
    has(tray, "overflow-x: hidden");
    expect(tray).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    has(rule(".agent-composer .att-tray:empty"), "display: none");
  });
  it("draws one rounded gradient card with a quiet focus border and no hex colours", () => {
    const card = rule(".agent-composer");
    has(card, "border-radius: 20px");
    expect(card).toMatch(/border:\s*1px solid/);
    expect(card).toMatch(/linear-gradient\(\s*180deg/);
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const focus = rule(".agent-composer:focus-within");
    expect(focus).toMatch(/border-color:\s*color-mix/);
    expect(focus).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it("puts the toolbar controls straight on the card with no container of their own", () => {
    const toolbar = rule(".agent-composer-toolbar");
    expect(toolbar).not.toMatch(/background/);
    expect(toolbar).not.toMatch(/border/);
  });
  it("grows the textarea up to eight lines and then scrolls vertically with a thin scrollbar", () => {
    const body = rule(".agent-input");
    has(body, "max-height: 178px");
    has(body, "overflow-y: auto");
    has(body, "scrollbar-width: thin");
    has(rule(".agent-composer.expanded .agent-input"), "max-height: none");
  });
  it("styles the send button as a quiet rounded square", () => {
    const send = rule(".agent-send");
    has(send, "border-radius: 8px");
    expect(send).toMatch(/background:\s*color-mix/);
  });
  it("keeps the composer box and toolbar children shrinkable so the row cannot overflow", () => {
    has(rule(".agent-composer"), "min-width: 0");
    const toolbar = rule(".agent-composer-toolbar");
    has(toolbar, "min-width: 0");
    has(rule(".agent-composer-toolbar > *"), "min-width: 0");
    has(rule(".agent-model-name"), "min-width: 0");
  });
  it("never shrinks the mode chip: it keeps its full label up to a cap", () => {
    const chip = rule(".agent-mode-button");
    has(chip, "flex: 0 0 auto");
    expect(chip).toMatch(/max-width:\s*\d+px/);
    expect(rule(".agent-mode-button .agent-model-name")).not.toMatch(/max-width/);
    const flexNone = rule(".agent-composer-toolbar > :is(.agent-send, .agent-tool-button:not(.agent-model-button), .agent-toolbar-end)");
    has(flexNone, "flex: none");
    expect(css).not.toMatch(/\.agent-mode-button[^{]*\{[^}]*display:\s*none/);
  });
  it("lets the model chip give way first and ellipsise its name, then the usage ring text", () => {
    // Small bases that grow back to the content: line breaking sees the minimum, so these give way before anything wraps.
    const chip = rule(".agent-model-button");
    const [, grow, shrink, basis] = /flex:\s*(\d+)\s+(\d+)\s+(\d+)px/.exec(chip) ?? [];
    expect(Number(shrink)).toBeGreaterThan(1);
    expect(Number(grow)).toBeGreaterThan(1);
    has(chip, `min-width: ${basis}px`);
    has(chip, "max-width: max-content");
    const name = rule(".agent-model-name");
    has(name, "overflow: hidden");
    has(name, "text-overflow: ellipsis");
    const ring = rule(".agent-composer-toolbar > .sb-ring");
    const [, ringGrow] = /flex:\s*(\d+)\s+1\s+\d+px/.exec(ring) ?? [];
    expect(Number(ringGrow)).toBeLessThan(Number(grow));
    has(ring, "max-width: max-content");
    has(rule(".agent-composer-toolbar > .sb-ring > span"), "text-overflow: ellipsis");
  });
  it("wraps a short row instead of overflowing, keeping expand, send and stop together on the right", () => {
    has(rule(".agent-composer-toolbar"), "flex-wrap: wrap");
    const end = rule(".agent-toolbar-end");
    has(end, "display: inline-flex");
    has(end, "margin-left: auto");
  });
  it("keeps the bypass mode chip uncut and warning coloured", () => {
    const warn = rule(".agent-mode-button.warn");
    has(warn, "flex: none");
    has(warn, "max-width: none");
    has(rule(".agent-mode-button.warn .agent-model-name"), "color: var(--sb-warning)");
  });
});
