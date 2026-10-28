// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InstalledAgent, RegistryAgent } from "../../bindings";
import { buildAgentCatalog } from "../../lib/acp-catalog";
import { AgentCatalog } from "./AgentCatalog";
import { ConnectScreen } from "./ConnectScreen";
import { mount, text } from "./test-utils";

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
