// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { AgentHealthSettings, AgentStartModeSettings, AgentStartSettings } from "./AgentStartSettings";

function mount(view: () => any) {
  const host = document.createElement("div");
  document.body.append(host);
  render(view, host);
  return host;
}

describe("Start installed agents in the background", () => {
  it("is a switch row for the user-only agents.warmStart, on by default", () => {
    const changes: boolean[] = [];
    const host = mount(() => <AgentStartSettings onChange={(on) => changes.push(on)} />);
    const toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
    expect(host.textContent).toContain("Start installed agents in the background");
    expect(host.textContent).toContain("agents.warmStart");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(changes).toEqual([false]);
  });
  it("shows the saved value and is read-only without a writer", () => {
    const host = mount(() => <AgentStartSettings enabled={false} />);
    const toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
  });
});

describe("Check agents in the background", () => {
  it("is a switch row for the user-only agents.healthCheck, on by default", () => {
    const changes: boolean[] = [];
    const host = mount(() => <AgentHealthSettings onChange={(on) => changes.push(on)} />);
    const toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
    expect(host.textContent).toContain("Check agents in the background");
    expect(host.textContent).toContain("agents.healthCheck");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).not.toContain("\u2014");
    toggle.click();
    expect(changes).toEqual([false]);
  });
  it("shows the saved value and is read-only without a writer", () => {
    const host = mount(() => <AgentHealthSettings enabled={false} />);
    const toggle = host.querySelector<HTMLButtonElement>("button[role=switch]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(true);
  });
});

describe("Agent start mode", () => {
  it("is off per agent by default and opting one agent in writes only its entry", () => {
    const changes: unknown[] = [];
    const host = mount(() => <AgentStartModeSettings onChange={(value) => changes.push(value)} />);
    const toggles = [...host.querySelectorAll<HTMLButtonElement>("button[role=switch]")];
    expect(toggles.map((t) => t.getAttribute("aria-label"))).toEqual(["Claude Agent: keep its own start mode", "Codex: keep its own start mode", "Gemini CLI: keep its own start mode", "Other agents: keep its own start mode"]);
    expect(toggles.every((t) => t.getAttribute("aria-checked") === "false")).toBe(true);
    expect(host.textContent).toContain("agents.startMode.claude");
    expect(host.textContent).not.toContain("\u2014");
    toggles[0].click();
    expect(changes).toEqual([{ claude: "agentDefault" }]);
  });
  it("shows a saved opt-in and turning it off removes the entry", () => {
    const changes: unknown[] = [];
    const host = mount(() => <AgentStartModeSettings value={{ codex: "agentDefault", claude: "approval" }} onChange={(value) => changes.push(value)} />);
    const codex = host.querySelector<HTMLButtonElement>("#agent-start-mode-codex")!;
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector("#agent-start-mode-claude")!.getAttribute("aria-checked")).toBe("false");
    codex.click();
    expect(changes).toEqual([{ claude: "approval" }]);
  });
  it("is read-only without a writer", () => {
    const host = mount(() => <AgentStartModeSettings />);
    expect([...host.querySelectorAll<HTMLButtonElement>("button[role=switch]")].every((t) => t.disabled)).toBe(true);
  });
});
