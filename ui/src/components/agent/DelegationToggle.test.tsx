// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import schema from "../../../../crates/core/settings.schema.json";
import { ConnectScreen } from "./ConnectScreen";
import { mount, text } from "./test-utils";

const screen = (extra: Record<string, unknown> = {}) => {
  const changes: boolean[] = [];
  const host = mount(() => <ConnectScreen found={[]} registry={[]} onConnect={() => {}} onInstall={() => {}} onCustom={() => {}} onDelegationChange={(enabled: boolean) => changes.push(enabled)} {...extra} />);
  return { host, changes, toggle: host.querySelector<HTMLButtonElement>("[role=switch]")! };
};

describe("agents work together card", () => {
  it("replaces the settings file hint with a titled card and one line of copy", () => {
    const { host } = screen();
    expect(host.textContent).not.toContain("agents.delegation.enabled");
    expect(host.textContent).not.toContain("off by default");
    const card = host.querySelector(".sb-delegation-toggle")!;
    expect(text(card.querySelector(".sb-delegation-title"))).toBe("Agents work together");
    expect(text(card)).toContain("an agent can start another installed agent for a subtask");
    expect(text(card)).toContain("Every action still asks you");
    expect(text(card)).toContain("limits apply per chat");
    expect(text(card)).toContain("chats started afterwards");
  });
  it("is a real switch, on when the setting is unset", () => {
    const { toggle } = screen();
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-labelledby")).toBeTruthy();
  });
  it("writes the opposite value on click and reflects the setting it is given", () => {
    const on = screen({ delegationEnabled: true });
    on.toggle.click();
    expect(on.changes).toEqual([false]);
    const off = screen({ delegationEnabled: false });
    expect(off.toggle.getAttribute("aria-checked")).toBe("false");
    off.toggle.click();
    expect(off.changes).toEqual([true]);
  });
  it("is disabled where the host cannot write settings", () => {
    const host = mount(() => <ConnectScreen found={[]} registry={[]} onConnect={() => {}} onInstall={() => {}} onCustom={() => {}} />);
    expect(host.querySelector<HTMLButtonElement>("[role=switch]")!.disabled).toBe(true);
  });
  it("draws the switch with theme tokens only", () => {
    const css = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");
    const rules = css.split("\n").filter((line) => line.includes(".sb-switch")).join("\n");
    expect(rules).toContain("var(--sb-");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
  it("ships the schema default as on", () => {
    expect(schema.properties.agents.properties.delegation.properties.enabled.default).toBe(true);
  });
});
