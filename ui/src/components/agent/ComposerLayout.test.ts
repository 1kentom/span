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
    has(rule(".agent-model-button,\n.agent-mode-button"), "min-width: 0");
    has(rule(".agent-model-name"), "min-width: 0");
  });
});
