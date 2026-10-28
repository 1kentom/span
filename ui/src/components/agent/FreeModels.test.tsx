// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ModelPopover } from "./ModelPopover";
import { mount } from "./test-utils";

const choices = [
  { value: "opencode-go/iceman-contributor-free", name: "Iceman Free", description: null },
  { value: "opencode/claude-opus-5-5", name: "Claude Opus 5.5", description: null },
  { value: "opencode-go/glm-5", name: "GLM 5", description: null },
];
const options = (current: string) => [{ id: "model", name: "Model", description: null, category: "model", currentValue: current, choices }] as never;
const names = (host: HTMLElement) => [...host.querySelectorAll("[role='radio'] .sb-option-name")].map((node) => node.textContent);

beforeEach(() => window.localStorage.clear());

describe("free models in the model popover", () => {
  it("shows only free models by default and keeps the current one visible", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" options={options("opencode/claude-opus-5-5")} onSelect={() => undefined} onClose={() => undefined} />);
    expect(names(host)).toEqual(["Iceman Free", "Claude Opus 5.5"]);
    expect(host.querySelector(".sb-free-toggle")?.getAttribute("aria-checked")).toBe("true");
  });
  it("shows every model grouped by tier once the switch is turned off, and remembers it", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" options={options("opencode-go/iceman-contributor-free")} onSelect={() => undefined} onClose={() => undefined} />);
    expect(names(host)).toEqual(["Iceman Free"]);
    host.querySelector<HTMLButtonElement>(".sb-free-toggle")!.click();
    expect(names(host)).toEqual(["Iceman Free", "GLM 5", "Claude Opus 5.5"]);
    expect([...host.querySelectorAll(".sb-tier")].map((node) => node.textContent)).toEqual(["Free", "Subscription", "Paid"]);
    expect(window.localStorage.getItem("span.agent.freeModelsOnly")).toBe("false");
  });
  it("leaves lists without cost tiers alone", () => {
    const plain = [{ id: "model", name: "Model", description: null, category: "model", currentValue: "default", choices: [{ value: "default", name: "Default", description: null }, { value: "opus", name: "Opus", description: null }] }] as never;
    const host = mount(() => <ModelPopover agentName="Claude" options={plain} onSelect={() => undefined} onClose={() => undefined} />);
    expect(names(host)).toEqual(["Default", "Opus"]);
    expect(host.querySelector(".sb-free-toggle")).toBeNull();
  });
});

describe("provider prefixes", () => {
  it("drops the prefix and tags the provider only where two models would read the same", () => {
    const dup = [{ id: "model", name: "Model", description: null, category: "model", currentValue: "opencode/beam-free", choices: [
      { value: "opencode/beam-free", name: "opencode/Beam Free", description: null },
      { value: "opencode-go/beam-free", name: "opencode-go/Beam Free", description: null },
      { value: "opencode/big-pickle", name: "opencode/Big Pickle", description: null },
      { value: "opencode/claude-opus-5-5", name: "opencode/Claude Opus 5.5", description: null },
    ] }] as never;
    const host = mount(() => <ModelPopover agentName="OpenCode" options={dup} onSelect={() => undefined} onClose={() => undefined} />);
    expect(names(host)).toEqual(["Beam Free", "Beam Free", "Big Pickle"]);
    expect([...host.querySelectorAll(".sb-provider-tag")].map((node) => node.textContent)).toEqual(["opencode", "opencode-go"]);
  });
});
