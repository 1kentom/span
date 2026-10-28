// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(text(host.querySelector(".agent-menu-heading .sb-count"))).toBe("7");
  });
  it("leaves installed rows out of the curated list, which lists them under Found on this computer", () => {
    const { row } = catalog();
    expect(row("Claude Code")).toBeUndefined();
    expect(row("Gemini CLI")).toBeDefined();
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
    const update: AgentUpdate = { id: "opencode", name: "OpenCode", installedVersion: "1.0.0", latestVersion: "1.2.0", status: "updateAvailable", managed: false, howToUpdate: "Run `opencode upgrade`", repository: null, note: null };
    const { row } = catalog({ updates: [update] });
    const entry = row("OpenCode").closest(".agent-catalog-entry")!;
    expect(text(entry.querySelector(".sb-update-badge"))).toBe("Update available: 1.0.0 to 1.2.0");
    entry.querySelector<HTMLButtonElement>("button[aria-label='How to update OpenCode']")!.click();
    expect(entry.querySelector(".sb-update-panel code")?.textContent).toBe("opencode upgrade");
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
    expect(sub.getAttribute("title")).toBe("Installed · 0.1.0 · my-agent");
  });
  it("hides a known command for an installed agent and keeps its chip on the Found row", () => {
    const host = screen({ presets: [{ id: "claude-acp", name: "Claude Code", description: "d", command: "claude-acp" }, { id: "other", name: "Other", description: "d", command: "other acp" }] });
    const known = host.querySelector("[aria-label='Agents with a known command']")!;
    expect(known.querySelector("[aria-label='Connect Claude Code']")).toBeNull();
    expect(known.querySelector("[aria-label='Connect Other']")).not.toBeNull();
    expect(host.querySelectorAll("[aria-label='Connect Claude Code']")).toHaveLength(1);
    const found = host.querySelector("[aria-label='Found on this computer'] [data-agent-id='claude-acp']")!;
    expect(text(found.querySelector("[aria-label='Command for Claude Code']"))).toBe("claude-acp");
    expect(found.querySelector(".sb-command-chip [aria-label='Copy command']")).not.toBeNull();
    expect([...host.querySelectorAll(".sb-group > .sb-eyebrow")].map(text)).toEqual(["Found on this computer 2", "Known commands 1", "ACP registry 1"]);
  });
  it("expands the update pill on a Found row into the how-to-update panel", () => {
    const update: AgentUpdate = { id: "my-agent", name: "My Agent", installedVersion: "0.1.0", latestVersion: "0.2.0", status: "updateAvailable", managed: false, howToUpdate: "Run `my-agent upgrade`", repository: null, note: null };
    const host = screen({ updates: [update] });
    const row = host.querySelector("[aria-label='Found on this computer'] [data-agent-id='my-agent']")!;
    row.querySelector<HTMLButtonElement>("button[aria-label='How to update My Agent']")!.click();
    expect(row.querySelector(".sb-update-panel code")?.textContent).toBe("my-agent upgrade");
  });
});

describe("connect screen styles", () => {
  const sidebar = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");
  const agent = readFileSync(resolve("src/styles/agent.css"), "utf8");
  const files = ["src/components/agent/ConnectScreen.tsx", "src/components/agent/AgentCatalog.tsx", "src/components/agent/UpdateBadge.tsx", "src/components/agent/CommandChip.tsx"].map((file) => readFileSync(resolve(file), "utf8"));
  it("rounds the curated rows and the custom command card like the other sidebar cards", () => {
    expect(agent).toMatch(/\.agent-catalog-row \{[^}]*border-radius:\s*8px/);
    expect(sidebar).toMatch(/\.sb-custom \{[^}]*border-radius:\s*8px/);
    expect(sidebar).toMatch(/\.sb-update-panel \{[^}]*border-radius:\s*8px/);
  });
  it("uses no em dashes in the connect screen sources and styles", () => {
    for (const source of [...files, sidebar, agent]) expect(source).not.toContain("\u2014");
  });
});

const css = readFileSync(resolve(__dirname, "../../styles/agent-sidebar.css"), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
const base = { registry: [], onConnect: () => {}, onInstall: () => {}, onCustom: () => {} };
const preset = { id: "opencode", name: "OpenCode", description: "Open source coding agent", command: "opencode acp" };

afterEach(() => vi.useRealTimers());

describe("command chip", () => {
  it("draws the command and an icon-only copy button on one line inside the text column", () => {
    const host = mount(() => <ConnectScreen {...base} found={[]} presets={[preset]} />);
    const chip = host.querySelector(".sb-command-chip")!;
    expect(chip.closest(".sb-agent-text")).not.toBeNull();
    expect(chip.children[0].matches("code.sb-preset-command")).toBe(true);
    expect(text(chip.children[0])).toBe("opencode acp");
    expect(chip.children[0].getAttribute("title")).toBe("opencode acp");
    const copy = chip.querySelector<HTMLButtonElement>("button")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy command");
    expect(copy.textContent).toBe("");
    expect(copy.querySelector(".icon")).not.toBeNull();
  });

  it("keeps the chip one line that fills the width, with no border and a field background", () => {
    const chip = rule(".sb-command-chip");
    expect(chip).toContain("display: flex");
    expect(chip).toContain("width: 100%");
    expect(chip).toContain("min-width: 0");
    expect(chip).toContain("height: 28px");
    expect(chip).toContain("border-radius: 6px");
    expect(chip).toContain("background: var(--sb-field)");
    expect(chip).not.toContain("border:");
    expect(chip).not.toContain("flex-direction: column");
    const code = rule(".sb-command-chip .sb-preset-command");
    expect(code).toContain("white-space: nowrap");
    expect(code).toContain("text-overflow: ellipsis");
    expect(code).toContain("min-width: 0");
  });

  it("copies the exact command and shows Copied for 1.5 seconds through the title and a live region", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn(async () => undefined);
    const host = mount(() => <ConnectScreen {...base} found={[]} presets={[preset]} onCopyCommand={onCopy} />);
    const copy = host.querySelector<HTMLButtonElement>("[aria-label='Copy command']")!;
    const live = host.querySelector(".sb-command-chip [aria-live='polite']")!;
    expect(live.textContent).toBe("");
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCopy).toHaveBeenCalledWith("opencode acp");
    expect(copy.getAttribute("title")).toBe("Copied");
    expect(copy.getAttribute("aria-label")).toBe("Copy command");
    expect(live.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.getAttribute("title")).toBe("Copy command");
    expect(live.textContent).toBe("");
  });
});

describe("installed agents appear once", () => {
  const installed: InstalledAgent[] = [
    { id: "codex-acp", version: "2.3.0", launch: { command: "/managed/codex", args: [], env: {} } },
    { id: "opencode", version: "2.0.32", launch: { command: "/usr/local/bin/opencode", args: ["acp"], env: {} } },
    { id: "my-adapter", version: "0.1.0", launch: { command: "/managed/my-adapter", args: [], env: {} } },
  ];
  const registry: RegistryAgent[] = ["codex-acp", "claude-acp", "opencode", "gemini"].map((id) => ({
    id, name: id, version: "1.0.0", description: "ACP", repository: null, icon: null, package: null, installable: true,
  }));
  const screen = (extra: Partial<Parameters<typeof ConnectScreen>[0]> = {}) => {
    const calls: string[] = [];
    const host = mount(() => (
      <ConnectScreen
        {...base}
        catalog={
          <AgentCatalog
            rows={buildAgentCatalog(registry, installed, "")}
            search=""
            onSearch={() => {}}
            installingIds={[]}
            installErrors={{}}
            registryBusy={false}
            working={false}
            desktop
            onRefresh={() => {}}
            onPick={(row) => calls.push(`pick:${row.definition.id}`)}
            removalBlock=""
            removalConnected={false}
            onCancelRemoval={() => {}}
            onConfirmRemoval={() => {}}
          />
        }
        found={installed.map((entry) => ({ id: entry.id, name: entry.id, subtitle: `${entry.version} · ${entry.launch.command.split("/").pop()}` }))}
        onConnect={(id) => calls.push(`connect:${id}`)}
        onRemove={(id, uninstall) => calls.push(`remove:${id}:${uninstall}`)}
        onCheckUpdates={() => calls.push("check")}
        {...extra}
      />
    ));
    return { host, calls };
  };

  it("renders no agent id twice across the curated list and Found on this computer", () => {
    const { host } = screen();
    const curated = [...host.querySelectorAll("[aria-label='Agents'] [data-agent-id]")].map((row) => row.getAttribute("data-agent-id"));
    const local = [...host.querySelectorAll("[aria-label='Found on this computer'] [data-agent-id]")].map((row) => row.getAttribute("data-agent-id"));
    const all = [...curated, ...local];
    expect(new Set(all).size).toBe(all.length);
    expect(local).toEqual(["codex-acp", "opencode", "my-adapter"]);
    expect(curated).not.toContain("codex-acp");
    expect(curated).not.toContain("opencode");
    expect(curated).toContain("claude-acp");
    expect(curated).toContain("gemini");
    expect(host.textContent).not.toContain("Other installed adapters");
  });

  it("keeps the version and launcher, the installed check, Connect and the update pill on the Found row", () => {
    const update = { id: "opencode", name: "OpenCode", status: "updateAvailable", installedVersion: "2.0.32", latestVersion: "2.2.0", howToUpdate: "npm i -g opencode-ai" } as never;
    const { host, calls } = screen({ updates: [update] });
    const row = host.querySelector("[aria-label='Found on this computer'] [data-agent-id='opencode']")!;
    expect(text(row.querySelector(".sb-installed-line"))).toBe("Installed · 2.0.32 · opencode");
    expect(row.querySelector(".sb-installed-line .icon")).not.toBeNull();
    expect(text(row.querySelector(".sb-update-badge"))).toBe("Update available: 2.0.32 to 2.2.0");
    row.querySelector<HTMLButtonElement>("[aria-label='Connect opencode']")!.click();
    expect(calls).toEqual(["connect:opencode"]);
  });

  it("reaches the manage menu from the Found row and only asks for removal or a check", () => {
    const { host, calls } = screen();
    const row = host.querySelector("[aria-label='Found on this computer'] [data-agent-id='codex-acp']")!;
    const manage = row.querySelector<HTMLButtonElement>("[aria-label='Manage codex-acp']")!;
    expect(manage.getAttribute("aria-expanded")).toBe("false");
    manage.click();
    expect(manage.getAttribute("aria-expanded")).toBe("true");
    const item = (label: string) => [...row.querySelectorAll<HTMLButtonElement>(".agent-row-management button")].find((button) => text(button) === label)!;
    expect(item("Remove from Span")).toBeDefined();
    expect(item("Uninstall managed adapter")).toBeDefined();
    item("Check for updates").click();
    expect(row.querySelector(".agent-row-management")).toBeNull();
    manage.click();
    item("Remove from Span").click();
    manage.click();
    item("Uninstall managed adapter").click();
    expect(calls).toEqual(["check", "remove:codex-acp:false", "remove:codex-acp:true"]);
  });
});
