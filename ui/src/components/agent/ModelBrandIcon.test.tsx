// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ModelIcon, ModelPopover } from "./ModelPopover";
import { mount } from "./test-utils";

const choices = [
  { value: "opencode/claude-opus-5-5", name: "Claude Opus 5.5", description: null },
  { value: "opencode-go/glm-5", name: "GLM 5", description: null },
  { value: "opencode/big-pickle", name: "Big Pickle", description: null },
  { value: "opencode/deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", description: null },
  { value: "opencode/nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", description: null },
  { value: "opencode/llama-4-maverick", name: "Llama 4 Maverick", description: null },
  { value: "opencode/minimax-m3", name: "MiniMax M3", description: null },
  { value: "opencode/beam-free", name: "Beam Free", description: null },
  { value: "opencode/flint-free", name: "Flint Free", description: null },
  { value: "opencode-go/iceman-contributor-free", name: "Iceman Free", description: null },
];
const options = [{ id: "model", name: "Model", description: null, category: "model", currentValue: "opencode/claude-opus-5-5", choices }] as never;
const opencode = { id: "opencode", name: "OpenCode" };

beforeEach(() => window.localStorage.setItem("span.agent.freeModelsOnly", "false"));

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[role='radio']")];
const row = (host: HTMLElement, name: string) => rows(host).find((node) => node.querySelector(".sb-option-name")?.textContent === name)!;

describe("model rows carry the model vendor mark", () => {
  it("shows the model logo with the agent as a bottom-left badge and the trait bottom-right", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" brand={opencode} options={options} onSelect={() => undefined} onClose={() => undefined} />);
    const avatar = row(host, "Claude Opus 5.5").querySelector(".sb-model-icon")!;
    expect(avatar.getAttribute("role")).toBe("img");
    expect(avatar.getAttribute("aria-label")).toBe("Claude model on OpenCode");
    expect(avatar.querySelector(":scope > .brand-icon img")?.getAttribute("src")).toBe("/brands/claude.svg");
    const badge = avatar.querySelector(".sb-agent-badge")!;
    expect(badge).not.toBeNull();
    expect([...badge.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual(["/brands/opencode-light.svg", "/brands/opencode-dark.svg"]);
    expect(avatar.querySelector(".sb-trait-badge")?.getAttribute("data-trait")).toBe("frontier");
    expect(row(host, "GLM 5").querySelector(".sb-model-icon")?.getAttribute("aria-label")).toBe("Z.ai model on OpenCode");
  });
  it("falls back to the agent mark alone when the model has no logo", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" brand={opencode} options={options} onSelect={() => undefined} onClose={() => undefined} />);
    for (const name of ["Big Pickle", "Beam Free", "Flint Free", "Iceman Free"]) {
      const avatar = row(host, name).querySelector(".sb-model-icon")!;
      expect(avatar.getAttribute("aria-label"), name).toBe("Model on OpenCode");
      expect(avatar.querySelector(".sb-agent-badge"), name).toBeNull();
      expect(avatar.querySelector(".brand-icon img")?.getAttribute("src"), name).toBe("/brands/opencode-light.svg");
    }
  });
  it("draws the DeepSeek, NVIDIA, Meta and MiniMax marks as currentColor masks", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" brand={opencode} options={options} onSelect={() => undefined} onClose={() => undefined} />);
    for (const [name, file, label] of [
      ["DeepSeek V4.1 Flash Free", "deepseek", "DeepSeek"],
      ["Nemotron 3.5 Super VL Free", "nvidia", "NVIDIA"],
      ["Llama 4 Maverick", "meta", "Llama"],
      ["MiniMax M3", "minimax", "MiniMax"],
    ]) {
      const avatar = row(host, name).querySelector(".sb-model-icon")!;
      expect(avatar.getAttribute("aria-label"), name).toBe(`${label} model on OpenCode`);
      expect(avatar.querySelector<HTMLElement>(".brand-mask")?.style.getPropertyValue("--brand-mask"), name).toBe(`url("/brands/models/${file}.svg")`);
    }
  });
  it("keeps the provider row as the agent mark alone", () => {
    const host = mount(() => <ModelPopover agentName="OpenCode" brand={opencode} options={options} onSelect={() => undefined} onOpenAgents={() => undefined} onClose={() => undefined} />);
    const provider = host.querySelector(".sb-provider")!;
    expect(provider.querySelector(".sb-model-icon, .sb-agent-badge")).toBeNull();
    expect(provider.querySelector(".brand-icon img")?.getAttribute("src")).toBe("/brands/opencode-light.svg");
  });
  it("draws a single-colour mark as a currentColor mask", () => {
    const host = mount(() => <ModelIcon id="opencode" name="OpenCode" agentName="OpenCode" model={{ value: "opencode/granite-5", name: "Granite 5" }} traits={[]} />);
    const mask = host.querySelector<HTMLElement>(".brand-mask")!;
    expect(mask).not.toBeNull();
    expect(mask.style.getPropertyValue("--brand-mask")).toBe('url("/brands/models/granite.svg")');
    expect(host.querySelector(".sb-model-icon")?.getAttribute("aria-label")).toBe("Granite model on OpenCode");
  });
  it("shows a single agent mark with no badge for unprefixed ids, keeping the trait badge", () => {
    const claude = mount(() => <ModelIcon id="claude" name="Claude" agentName="Claude" model={{ value: "opus", name: "Opus" }} traits={["frontier"]} />);
    const plain = claude.querySelector(".sb-model-icon")!;
    expect(plain.querySelectorAll(".brand-icon, .brand-mask")).toHaveLength(1);
    expect(plain.querySelector(".sb-agent-badge")).toBeNull();
    expect(plain.getAttribute("aria-label")).toBeNull();
    expect(plain.querySelector(".brand-icon img")?.getAttribute("src")).toContain("claude");
    expect(plain.querySelector(".sb-trait-badge")?.getAttribute("data-trait")).toBe("frontier");
    const codex = mount(() => <ModelIcon id="codex" name="Codex" agentName="Codex" model={{ value: "gpt-5.6-luna", name: "GPT 5.6 Luna" }} traits={[]} />);
    expect(codex.querySelector(".sb-agent-badge")).toBeNull();
    expect(codex.querySelectorAll(".sb-model-icon .brand-icon, .sb-model-icon .brand-mask")).toHaveLength(1);
    expect(codex.querySelector(".sb-model-icon")?.getAttribute("aria-label")).toBeNull();
  });
});
