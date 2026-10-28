// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ModelPopover } from "./ModelPopover";
import { ModePopover } from "./ModePopover";
import { AgentPopover } from "./AgentPopover";
import type { ConfigOptionView } from "./types";
import { key, mount, text } from "./test-utils";

/** The shapes Codex reports, trimmed to what the popovers render. */
const codex: ConfigOptionView[] = [
  {
    id: "mode", name: "Mode", category: "mode", currentValue: "agent",
    choices: [
      { value: "read-only", name: "Read-only", description: "Requires approval to edit files and access the internet." },
      { value: "workspace", name: "Workspace access" },
      { value: "agent", name: "Auto review", description: "Only ask for actions detected as potentially unsafe" },
      { value: "agent-full-access", name: "Full access", description: "Unrestricted access to the internet and any file on your computer" },
    ],
  },
  { id: "model", name: "Model", category: "model", currentValue: "6.1-sol", choices: [{ value: "6.1-sol", name: "6.1 Sol", description: "Flagship" }, { value: "6-luna", name: "6 Luna", description: "Fast and light" }] },
  { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", currentValue: "medium", choices: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] },
  { id: "collaboration_mode", name: "Collaboration mode", currentValue: "default", choices: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan", description: "Plan before making changes" }] },
  { id: "fast_mode", name: "Fast mode", currentValue: "off", choices: [{ value: "off", name: "Off", description: "Default speed, normal usage" }, { value: "on", name: "On", description: "1.5x speed, increased usage" }] },
];
const groupNames = (host: Element) => [...host.querySelectorAll("[role=radiogroup]")].map((group) => group.getAttribute("aria-label"));
const buttons = (host: Element) => [...host.querySelectorAll<HTMLButtonElement>("button")];
const byText = (host: Element, label: string) => buttons(host).find((button) => button.textContent?.includes(label))!;

describe("ModelPopover", () => {
  it("shows the provider row, the model list and the effort slider, and nothing from the mode group", () => {
    const host = mount(() => <ModelPopover agentName="Codex" brand={{ id: "codex-acp" }} options={codex} onSelect={() => {}} onClose={() => {}} onOpenAgents={() => {}} />);
    expect(groupNames(host)).toEqual(["Model"]);
    expect(host.querySelector("[role=slider]")!.getAttribute("aria-label")).toBe("Reasoning effort");
    expect(text(host)).toContain("6 Luna");
    for (const absent of ["Auto review", "Collaboration mode", "Fast mode", "Plan before making changes"]) expect(text(host)).not.toContain(absent);
    const provider = host.querySelector<HTMLButtonElement>(".sb-provider")!;
    expect(provider.getAttribute("aria-label")).toBe("Agent: Codex. Switch agent");
    expect(provider.getAttribute("aria-haspopup")).toBe("dialog");
    expect(provider.querySelector("img, .brand-icon")).not.toBeNull();
    expect(provider.innerHTML).toContain("arrow-right4");
  });

  it("opens the agent popover from the provider row", () => {
    const openAgents = vi.fn();
    const host = mount(() => <ModelPopover agentName="Codex" options={codex} onSelect={() => {}} onClose={() => {}} onOpenAgents={openAgents} />);
    host.querySelector<HTMLButtonElement>(".sb-provider")!.click();
    expect(openAgents).toHaveBeenCalledOnce();
  });

  it("applies a model pick at once through onSelect and still focuses the selected model first", async () => {
    const picked: string[] = [];
    const host = mount(() => <ModelPopover agentName="Codex" options={codex} onSelect={(id, value) => picked.push(`${id}=${value}`)} onClose={() => {}} onOpenAgents={() => {}} />);
    await Promise.resolve();
    expect(document.activeElement?.textContent).toContain("6.1 Sol");
    byText(host, "6 Luna").click();
    expect(picked).toEqual(["model=6-luna"]);
  });

  it("moves with Home and End across the provider row and the model rows", () => {
    const host = mount(() => <ModelPopover agentName="Codex" options={codex} onSelect={() => {}} onClose={() => {}} onOpenAgents={() => {}} />);
    const first = host.querySelector<HTMLButtonElement>(".sb-provider")!;
    first.focus();
    key("End", {}, first);
    const last = buttons(host).filter((button) => !button.disabled).at(-1)!;
    expect(document.activeElement).toBe(last);
    key("Home", {}, last);
    expect(document.activeElement).toBe(first);
  });
});

describe("ModePopover", () => {
  it("lists the mode and every other non-model option under its own heading, with descriptions", () => {
    const host = mount(() => <ModePopover agentName="Codex" options={codex} onSelect={() => {}} onClose={() => {}} />);
    expect(groupNames(host)).toEqual(["Mode", "Collaboration mode", "Fast mode"]);
    expect([...host.querySelectorAll(".sb-eyebrow")].map((heading) => text(heading))).toEqual(["Mode", "Collaboration mode", "Fast mode"]);
    expect(text(host)).toContain("Only ask for actions detected as potentially unsafe");
    expect(text(host)).toContain("1.5x speed, increased usage");
    expect(text(host)).not.toContain("6.1 Sol");
    expect(host.querySelector("[role=slider]")).toBeNull();
    const checked = [...host.querySelectorAll("[aria-checked=true]")].map((row) => text(row.querySelector(".sb-option-name")));
    expect(checked).toEqual(["Auto review", "Default", "Off"]);
  });

  it("applies a pick through onSelect, focuses the current mode first, moves with arrows and closes on Escape", async () => {
    const picked: string[] = [];
    const closed = vi.fn();
    const host = mount(() => <ModePopover agentName="Codex" options={codex} onSelect={(id, value) => picked.push(`${id}=${value}`)} onClose={closed} />);
    await Promise.resolve();
    expect(text(document.activeElement?.querySelector(".sb-option-name"))).toBe("Auto review");
    key("ArrowDown", {}, document.activeElement!);
    expect(text(document.activeElement?.querySelector(".sb-option-name"))).toBe("Full access");
    byText(host, "1.5x speed").click();
    byText(host, "Plan before making changes").click();
    expect(picked).toEqual(["fast_mode=on", "collaboration_mode=plan"]);
    key("Escape");
    expect(closed).toHaveBeenCalledOnce();
  });

  it("keeps focus and rows when a config update delivers new option objects", () => {
    const fresh = (current: string) => codex.map((option) => ({ ...option, choices: option.choices.map((choice) => ({ ...choice })), currentValue: option.id === "fast_mode" ? current : option.currentValue }));
    const [list, setList] = createSignal(fresh("off"));
    const host = mount(() => <ModePopover agentName="Codex" options={list()} onSelect={() => {}} onClose={() => {}} />);
    const on = byText(host, "1.5x speed");
    on.focus();
    setList(fresh("on"));
    expect(byText(host, "1.5x speed")).toBe(on);
    expect(document.activeElement).toBe(on);
    expect(on.getAttribute("aria-checked")).toBe("true");
  });
});

describe("AgentPopover", () => {
  const agents = [
    { id: "claude-acp", name: "Claude Agent", subtitle: "0.99.0" },
    { id: "codex-acp", name: "Codex", subtitle: "2.3.0", current: true },
    { id: "opencode", name: "OpenCode", subtitle: "2.0.32" },
  ];
  const update = { id: "opencode", name: "OpenCode", status: "updateAvailable", installedVersion: "2.0.32", latestVersion: "2.2.0", howToUpdate: "npm i -g opencode" } as never;

  it("lists installed agents with versions, the connected one, update badges, presets and Add agent", () => {
    const host = mount(() => (
      <AgentPopover agents={agents} connectedName="Codex" presets={[{ id: "gemini", name: "Gemini CLI", description: "Google" }]} updates={[update]} onSelect={() => {}} onPreset={() => {}} onCheckUpdates={() => {}} onAdd={() => {}} onClose={() => {}} />
    ));
    expect(host.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe("Agents");
    const codexRow = byText(host, "Codex");
    expect(codexRow.getAttribute("aria-current")).toBe("true");
    expect(text(codexRow)).toContain("Connected");
    expect(text(byText(host, "Claude Agent"))).toContain("0.99.0");
    expect(text(byText(host, "OpenCode").querySelector(".sb-update-badge"))).toBe("Update available: 2.0.32 to 2.2.0");
    expect(text(byText(host, "Gemini CLI"))).toContain("Connect");
    expect(byText(host, "Check for updates")).toBeDefined();
    expect(byText(host, "Add agent").innerHTML).toContain("arrow-right4");
  });

  it("says switching starts a new chat with the agent under focus, and switches on click", () => {
    const picked: string[] = [];
    const host = mount(() => <AgentPopover agents={agents} connectedName="Codex" onSelect={(id) => picked.push(id)} onCheckUpdates={() => {}} onAdd={() => {}} onClose={() => {}} />);
    const line = host.querySelector(".sb-switch-note")!;
    expect(text(line)).toBe("Switching starts a new chat with Claude Agent.");
    const opencode = byText(host, "OpenCode");
    opencode.focus();
    expect(text(line)).toBe("Switching starts a new chat with OpenCode.");
    expect(opencode.getAttribute("aria-describedby")).toBe(line.id);
    opencode.click();
    expect(picked).toEqual(["opencode"]);
  });

  it("omits the switching line when no chat is connected", () => {
    const host = mount(() => <AgentPopover agents={agents.map((agent) => ({ ...agent, current: false }))} onSelect={() => {}} onCheckUpdates={() => {}} onAdd={() => {}} onClose={() => {}} />);
    expect(host.querySelector(".sb-switch-note")).toBeNull();
  });

  it("moves with arrows, Home and End, opens Add agent and closes on Escape", async () => {
    const add = vi.fn();
    const closed = vi.fn();
    const host = mount(() => <AgentPopover agents={agents} connectedName="Codex" onSelect={() => {}} onCheckUpdates={() => {}} onAdd={add} onClose={closed} />);
    await Promise.resolve();
    const enabled = buttons(host).filter((button) => !button.disabled);
    expect(document.activeElement).toBe(enabled[0]);
    key("ArrowDown", {}, enabled[0]);
    expect(document.activeElement).toBe(enabled[1]);
    key("End", {}, enabled[1]);
    expect(document.activeElement).toBe(byText(host, "Add agent"));
    key("Home", {}, document.activeElement!);
    expect(document.activeElement).toBe(enabled[0]);
    byText(host, "Add agent").click();
    expect(add).toHaveBeenCalledOnce();
    key("Escape");
    expect(closed).toHaveBeenCalledOnce();
  });
});
