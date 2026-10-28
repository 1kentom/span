// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { AgentHealthSettings, AgentStartSettings } from "./AgentStartSettings";

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
