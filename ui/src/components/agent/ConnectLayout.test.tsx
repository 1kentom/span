// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentUpdate_Serialize as AgentUpdate, InstalledAgent, RegistryAgent } from "../../bindings";
import { buildAgentCatalog } from "../../lib/acp-catalog";
import { AgentCatalog } from "./AgentCatalog";
import { ConnectScreen } from "./ConnectScreen";
import { mount, text } from "./test-utils";

const noop = () => {};
const installed = (id: string, version: string): InstalledAgent => ({ id, version, launch: { command: `/managed/${id}`, args: [], env: {} } });
const registry = (id: string, installable: boolean): RegistryAgent => ({ id, name: id, version: "1.0.0", description: "", installable } as RegistryAgent);
const catalog = (extra: Record<string, unknown> = {}) => {
  const rows = buildAgentCatalog([registry("claude-acp", true), registry("gemini", true), registry("opencode", false)], [installed("claude-acp", "1.0.0")]);
  const picked: string[] = [];
  const presetsUsed: string[] = [];
  const host = mount(() => (
    <AgentCatalog
      rows={rows}
      others={[]}
      search=""
      onSearch={noop}
      installingIds={[]}
      installErrors={{}}
      registryBusy={false}
      working={false}
      desktop
      onRefresh={noop}
      onPick={(row) => picked.push(row.definition.id)}
      removalBlock=""
      removalConnected={false}
      onCancelRemoval={noop}
      onConfirmRemoval={noop}
      presets={[{ id: "opencode", name: "OpenCode", description: "Runs `opencode acp`.", command: "opencode acp" }]}
      onPreset={(id: string) => presetsUsed.push(id)}
      {...extra}
    />
  ));
  const row = (name: string) => [...host.querySelectorAll<HTMLButtonElement>(".agent-catalog-row")].find((item) => item.textContent?.includes(name))!;
  return { host, row, picked, presetsUsed };
};

describe("curated catalog actions", () => {
  it("heads the list with a small eyebrow and a count", () => {
    const { host } = catalog();
    expect(text(host.querySelector(".agent-menu-heading .sb-count"))).toBe("8");
  });
  it("draws Connect as the primary action and marks installed rows with a quiet check", () => {
    const { row } = catalog();
    const claude = row("Claude Code");
    expect(text(claude.querySelector(".agent-action.primary"))).toBe("Connect");
    expect(claude.querySelector("small")!.innerHTML).toContain("tick-circle");
    expect(claude.textContent).toContain("Installed · 1.0.0");
  });
  it("draws Install as a secondary action with the package glyph", () => {
    const { row } = catalog();
    const install = row("Gemini CLI").querySelector(".agent-action.secondary")!;
    expect(text(install)).toBe("Install");
    expect(install.innerHTML).toContain("package.svg");
  });
  it("puts the full subtitle in the title so the ellipsis loses nothing", () => {
    const { row } = catalog();
    expect(row("Gemini CLI").querySelector("small")!.getAttribute("title")).toBe("Native ACP in Gemini CLI");
  });
  it("connects a curated program that has a known command directly, once, with its command as a copyable chip", () => {
    const { host, row, picked, presetsUsed } = catalog();
    const opencode = row("OpenCode");
    expect(text(opencode.querySelector(".agent-action.primary"))).toBe("Connect");
    opencode.click();
    expect(presetsUsed).toEqual(["opencode"]);
    expect(picked).toEqual([]);
    const entry = opencode.closest(".agent-catalog-entry")!;
    expect(text(entry.querySelector(".sb-preset-command"))).toBe("opencode acp");
    expect(entry.querySelector("button[aria-label='Copy command']")).not.toBeNull();
    expect(host.querySelectorAll(".sb-preset-command")).toHaveLength(1);
  });
  it("puts the update pill under a curated row and expands its panel there", () => {
    const update: AgentUpdate = { id: "claude-acp", name: "Claude Code", installedVersion: "1.0.0", latestVersion: "1.2.0", status: "updateAvailable", managed: true, howToUpdate: "Span runs: `npm install x`", repository: null, note: null };
    const { row } = catalog({ updates: [update] });
    const entry = row("Claude Code").closest(".agent-catalog-entry")!;
    expect(text(entry.querySelector(".sb-update-badge"))).toBe("Update available: 1.0.0 to 1.2.0");
    entry.querySelector<HTMLButtonElement>("button[aria-label='How to update Claude Code']")!.click();
    expect(entry.querySelector(".sb-update-panel code")?.textContent).toBe("npm install x");
  });
});

describe("connect screen groups", () => {
  const screen = (extra: Record<string, unknown> = {}) =>
    mount(() => (
      <ConnectScreen
        found={[{ id: "claude-acp", name: "Claude Code", subtitle: "1.0.0" }, { id: "my-agent", name: "My Agent", subtitle: "0.1.0 · my-agent" }]}
        presets={[{ id: "opencode", name: "OpenCode", description: "Runs `opencode acp`.", command: "opencode acp" }, { id: "other", name: "Other", description: "d", command: "other acp" }]}
        registry={[{ id: "qwen", name: "Qwen Code", subtitle: "Qwen", status: "available" }]}
        onConnect={noop}
        onInstall={noop}
        onCustom={noop}
        {...extra}
      />
    ));
  it("labels each group with an eyebrow and its count", () => {
    const host = screen();
    const eyebrows = [...host.querySelectorAll(".sb-group > .sb-eyebrow")].map(text);
    expect(eyebrows).toEqual(["Found on this computer 2", "Known commands 2", "ACP registry 1"]);
  });
  it("lists a program once: rows the curated list already shows are left out", () => {
    const host = screen({ listedIds: ["claude-acp", "opencode"] });
    expect(host.querySelector("[aria-label='Connect Claude Code']")).toBeNull();
    expect(host.querySelector("[aria-label='Connect OpenCode']")).toBeNull();
    expect(host.querySelector("[aria-label='Connect My Agent']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Connect Other']")).not.toBeNull();
    expect([...host.querySelectorAll(".sb-group > .sb-eyebrow")].map(text)).toEqual(["Found on this computer 1", "Known commands 1", "ACP registry 1"]);
  });
  it("shows a known command as a compact chip with a copy button, keeping the exact command text", () => {
    const host = screen();
    const chip = host.querySelector("[aria-label='Command for Other']")!;
    expect(chip.textContent).toBe("other acp");
    expect(chip.closest(".sb-command-chip")!.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  });
  it("keeps subtitles to one line with the full text in the title", () => {
    const host = screen();
    const sub = [...host.querySelectorAll(".sb-agent-text .sb-sub")].find((node) => node.textContent?.includes("my-agent"))!;
    expect(sub.getAttribute("title")).toBe("0.1.0 · my-agent");
  });
});

describe("connect screen styles", () => {
  const sidebar = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");
  const agent = readFileSync(resolve("src/styles/agent.css"), "utf8");
  const files = ["src/components/agent/ConnectScreen.tsx", "src/components/agent/AgentCatalog.tsx", "src/components/agent/UpdateBadge.tsx"].map((file) => readFileSync(resolve(file), "utf8"));
  it("rounds the curated rows and the custom command card like the other sidebar cards", () => {
    expect(agent).toMatch(/\.agent-catalog-row \{[^}]*border-radius:\s*8px/);
    expect(sidebar).toMatch(/\.sb-custom \{[^}]*border-radius:\s*8px/);
    expect(sidebar).toMatch(/\.sb-update-panel \{[^}]*border-radius:\s*8px/);
  });
  it("uses no em dashes in the connect screen sources and styles", () => {
    for (const source of [...files, sidebar, agent]) expect(source).not.toContain("—");
  });
});
