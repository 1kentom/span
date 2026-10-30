// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { UsageCost, UsageSummary_Serialize as UsageSummary, UsageTotals_Serialize as UsageTotals } from "../../bindings";
import { RESCAN_MS, UsagePage, type UsageApi } from "./UsagePage";
import { UsageImportSettings } from "./UsageImportSettings";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const usageCss = readFileSync(resolve("src/styles/usage.css"), "utf8");

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); localStorage.clear(); });
function mount(view: () => any) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(view, root));
  return root;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const cost = (patch: Partial<UsageCost>): UsageCost => ({ usd: 0, reportedUsd: 0, estimatedUsd: 0, unpricedTokens: 0, known: false, complete: true, ...patch });
const totals = (tokens: number, c: UsageCost): UsageTotals => ({ tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, thought: 0, total: tokens }, turns: 2, turnsWithTokens: 2, sessions: 1, cost: c });

function summary(): UsageSummary {
  const priced = cost({ known: true, usd: 4, estimatedUsd: 4 });
  const unknown = cost({ known: false, complete: false, unpricedTokens: 500 });
  return {
    range: {},
    totals: totals(1_000_500, cost({ known: true, usd: 4, estimatedUsd: 4, complete: false, unpricedTokens: 500 })),
    days: [
      { day: "2026-10-28", agents: [{ agentId: "claude", tokens: 1_000_000, cost: priced }], models: [{ agentId: "claude", model: "claude-opus-5-5", tokens: 1_000_000, cost: priced }] },
      { day: "2026-10-29", agents: [{ agentId: "local", tokens: 500, cost: unknown }], models: [{ agentId: "local", model: "local-model", tokens: 500, cost: unknown }] },
    ],
    agents: [{ agentId: "claude", name: "Claude", totals: totals(1_000_000, priced), imported: false }, { agentId: "local", name: "Local", totals: totals(500, unknown), imported: false }],
    models: [{ model: "claude-opus-5-5", agentIds: ["claude"], price: { id: "claude-opus-5-5", label: "Claude Opus 5.5", kind: "exact", note: null }, totals: totals(1_000_000, priced) }],
    topModel: "claude-opus-5-5",
    prices: { asOf: "2026-10-29", currency: "USD", unit: "USD per million tokens", models: 1, sources: [{ provider: "Anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing" }] },
    trackedSessions: 2,
  };
}

describe("UsagePage", () => {
  it("labels estimates, never prices unknown usage as zero, and offers the importer", async () => {
    const api: UsageApi = { summary: vi.fn(async () => summary()), sessions: vi.fn(async () => []) };
    const onImportChange = vi.fn(async () => undefined);
    const root = mount(() => <UsagePage api={api} desktop onClose={() => undefined} onImportChange={onImportChange} />);
    await settle();
    expect(root.textContent).toContain("Pricing and estimates");
    expect(root.textContent).toContain("not your subscription bill");
    expect(root.textContent).toContain("$4.00+");
    expect(root.textContent).toContain("API-equivalent estimate");
    expect(root.textContent).not.toContain("$0.00");
    expect(api.summary).toHaveBeenCalledWith(expect.objectContaining({ source: "tracked" }));
    // The previous period is asked for too, for the deltas.
    expect(api.summary).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[aria-label="Source"]')).toBeNull();
  });

  it("filters by agent chips without repainting the remaining series", async () => {
    const api: UsageApi = { summary: vi.fn(async () => summary()), sessions: vi.fn(async () => []) };
    const root = mount(() => <UsagePage api={api} desktop onClose={() => undefined} />);
    await settle();
    const chips = [...root.querySelectorAll('[aria-label="Agents"] button')] as HTMLButtonElement[];
    expect(chips.map((chip) => chip.textContent)).toEqual(["All agents", "Claude Code", "Local"]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    chips[1].click();
    await settle();
    expect(chips[1].getAttribute("aria-pressed")).toBe("true");
    expect(chips[0].getAttribute("aria-pressed")).toBe("false");
    const legend = root.querySelector('[aria-label="Legend"]')!;
    expect(legend.textContent).toContain("Claude Code");
    expect(legend.textContent).not.toContain("Local");
    // Only Claude's tokens are left in the total.
    expect(root.querySelector(".usage-tile:nth-child(2) .usage-hero")!.textContent).toBe("1M");
    chips[0].click();
    await settle();
    expect(root.querySelector('[aria-label="Legend"]')!.textContent).toContain("Local");
  });

  it("shows scan progress, partial results and the source filter while the importer runs", async () => {
    const running = { enabled: true, running: true, report: { filesTotal: 2314, filesDone: 949, filesRead: 949, bytesRead: 10, entries: 4, duplicates: 0, skipped: 0, truncated: false, compressedRead: 0, compressedSkipped: 0, databasesRead: 0, kinds: [], notes: [] }, scannedMs: null, error: null };
    const api: UsageApi = { summary: vi.fn(async () => summary()), sessions: vi.fn(async () => []), importScan: vi.fn(async () => running), importStatus: vi.fn(async () => running) };
    const root = mount(() => <UsagePage api={api} desktop importEnabled onClose={() => undefined} />);
    await settle();
    expect(api.importScan).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain("Scanning 2,314 files, 41%");
    expect(root.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("41");
    expect(root.textContent).toContain("Partial results");
    (root.querySelector('[aria-label="Source"] button[title="Imported from local logs"]') as HTMLButtonElement).click();
    await settle();
    expect(api.summary).toHaveBeenCalledWith(expect.objectContaining({ source: "imported" }));
  });

  it("searches sessions and opens only the ones Span can resume", async () => {
    const row = (sessionId: string, title: string, imported: boolean) => ({ imported, agentId: imported ? "claude-code-logs" : "claude", agentName: "Claude", sessionId, title, firstSeenMs: 1, lastActiveMs: 2, models: ["claude-opus-5-5"], totals: totals(10, cost({ known: true, usd: 1, estimatedUsd: 1 })), contextPeak: 0, contextSize: 0 });
    const onOpen = vi.fn();
    const api: UsageApi = { summary: async () => summary(), sessions: async () => [row("a", "Fix the parser", false), row("b", "Write docs", true)] };
    const root = mount(() => <UsagePage api={api} desktop onClose={() => undefined} onOpenSession={onOpen} />);
    await settle();
    const rows = () => [...root.querySelectorAll(".usage-sessions tbody tr")] as HTMLTableRowElement[];
    expect(rows()).toHaveLength(2);
    rows().find((tr) => tr.textContent?.includes("Write docs"))!.click();
    expect(onOpen).not.toHaveBeenCalled();
    rows().find((tr) => tr.textContent?.includes("Fix the parser"))!.click();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "a" }));
    const search = root.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;
    search.value = "docs";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(rows().map((tr) => tr.textContent)).toEqual([expect.stringContaining("Write docs")]);
  });

  it("names models without a price in the pricing note instead of showing $0", async () => {
    const value = summary();
    value.models.push({ model: "local-model", agentIds: ["local"], price: null, totals: totals(500, cost({ known: false, complete: false, unpricedTokens: 500 })) });
    const root = mount(() => <UsagePage api={{ summary: async () => value, sessions: async () => [] }} desktop onClose={() => undefined} />);
    await settle();
    expect(root.textContent).toContain("1 model without a price");
    expect(root.querySelector(".usage-noprice-chip")!.textContent).toContain("local-model");
  });

  it("explains an empty history, offers the importer and closes on Escape", async () => {
    const empty = { ...summary(), totals: totals(0, cost({})), days: [], agents: [], models: [], topModel: null, trackedSessions: 0 };
    empty.totals.turns = 0;
    const onClose = vi.fn();
    const onImportChange = vi.fn(async () => undefined);
    const root = mount(() => <UsagePage api={{ summary: async () => empty, sessions: async () => [] }} desktop onClose={onClose} onImportChange={onImportChange} />);
    await settle();
    expect(root.textContent).toContain("No usage yet");
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Read local logs")!.click();
    expect(onImportChange).toHaveBeenCalledWith(true);
    root.querySelector(".usage-page")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a designed error state with a retry", async () => {
    let fail = true;
    const api: UsageApi = { summary: async () => { if (fail) throw new Error("store unreadable"); return summary(); }, sessions: async () => [] };
    const root = mount(() => <UsagePage api={api} desktop onClose={() => undefined} />);
    await settle();
    expect(root.querySelector('[role="alert"]')!.textContent).toContain("store unreadable");
    fail = false;
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click();
    await settle();
    expect(root.textContent).toContain("Tokens over time");
  });

  it("shows the importer notice once, with a link to Settings", async () => {
    const done = { enabled: true, running: false, report: { filesTotal: 3, filesDone: 3, filesRead: 3, bytesRead: 10, entries: 4, duplicates: 1, skipped: 0, truncated: false, compressedRead: 1, compressedSkipped: 2, databasesRead: 1, kinds: ["claude", "codex", "openCode"] as ("claude" | "codex" | "openCode")[], notes: ["OpenCode database format not recognised (version 7), so it was not read."] }, scannedMs: Date.now(), error: null };
    const api: UsageApi = { summary: async () => summary(), sessions: async () => [], importScan: async () => done, importStatus: async () => done };
    const onOpenSettings = vi.fn();
    const first = mount(() => <UsagePage api={api} desktop importEnabled onOpenSettings={onOpenSettings} onClose={() => undefined} />);
    await settle();
    const note = first.querySelector(".usage-notice")!;
    expect(note.textContent).toContain("Reading local usage from Claude Code, Codex, Gemini CLI and OpenCode logs. Turn off in Settings.");
    (note.querySelector(".usage-link") as HTMLButtonElement).click();
    expect(onOpenSettings).toHaveBeenCalled();
    // Skipped sources are named, never silently dropped.
    expect(first.textContent).toContain("3 sources not read");
    expect(first.textContent).toContain("2 compressed Codex logs skipped: larger than 256 MB once decompressed.");
    expect(first.textContent).not.toContain("no zstd reader");
    expect(first.textContent).toContain("OpenCode database format not recognised (version 7)");
    expect(first.textContent).toContain("Found Claude Code, Codex, OpenCode logs, 3 files, 1 compressed, 1 OpenCode database");
    disposers.splice(0).forEach((dispose) => dispose());
    document.body.replaceChildren();
    const second = mount(() => <UsagePage api={api} desktop importEnabled onClose={() => undefined} />);
    await settle();
    expect(second.querySelector(".usage-notice")).toBeNull();
  });

  it("lays the importer notice out as one compact left-aligned row", async () => {
    const done = { enabled: true, running: false, report: null, scannedMs: Date.now(), error: null };
    const api: UsageApi = { summary: async () => summary(), sessions: async () => [], importScan: async () => done, importStatus: async () => done };
    const root = mount(() => <UsagePage api={api} desktop importEnabled onOpenSettings={() => undefined} onClose={() => undefined} />);
    await settle();
    const note = root.querySelector('.usage-notice[role="note"]')!;
    expect(note.tagName).toBe("DIV");
    // Icon, then the text with its Settings link, then the dismiss button last.
    const children = [...note.children];
    expect(children.map((child) => child.className.trim())).toEqual(["icon", "usage-notice-text", "usage-icon-button small"]);
    expect(children[1].querySelector(".usage-link")!.textContent).toBe("Settings");
    expect(children[2].getAttribute("aria-label")).toBe("Dismiss");
    // The text keeps its own width (no flex grow) so nothing opens a gap between icon and text; only the dismiss
    // button is pushed right, and the row uses the tiles' surface and radius.
    expect(usageCss.length).toBeGreaterThan(0);
    const rule = (selector: string) => { const start = usageCss.indexOf(`\n${selector} {`); return start < 0 ? "" : usageCss.slice(start, usageCss.indexOf("}", start)); };
    expect(rule(".usage-notice-text")).toContain("flex: 0 1 auto");
    expect(rule(".usage-notice > .icon")).toContain("flex: none");
    expect(rule(".usage-notice > .usage-icon-button")).toContain("margin-left: auto");
    expect(rule(".usage-notice")).toContain("justify-content: flex-start");
    expect(rule(".usage-notice")).toContain("border-radius: 12px");
    expect(rule(".usage-tile")).toContain("border-radius: 12px");
    expect(rule(".usage-notice")).toContain("background: var(--island)");
    (children[2] as HTMLButtonElement).click();
    await settle();
    expect(root.querySelector(".usage-notice")).toBeNull();
  });

  it("rescans every minute only while the window is visible", async () => {
    vi.useFakeTimers();
    try {
      const done = { enabled: true, running: false, report: null, scannedMs: Date.now(), error: null };
      const importScan = vi.fn(async () => done);
      const api: UsageApi = { summary: async () => summary(), sessions: async () => [], importScan, importStatus: async () => done };
      mount(() => <UsagePage api={api} desktop importEnabled onClose={() => undefined} />);
      await vi.advanceTimersByTimeAsync(0);
      expect(importScan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(RESCAN_MS);
      expect(importScan).toHaveBeenCalledTimes(2);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(RESCAN_MS);
      expect(importScan).toHaveBeenCalledTimes(2);
      visibility.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Claude Code five-hour blocks as a chart mode when the importer is on", async () => {
    const done = { enabled: true, running: false, report: null, scannedMs: Date.now(), error: null };
    const now = Date.now();
    const block = (startMs: number, active: boolean, total: number) => ({ startMs, endMs: startMs + 5 * 3_600_000, lastMs: startMs, active, turns: 3, tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, thought: 0, total }, cost: cost({ known: true, usd: 2, estimatedUsd: 2 }), models: ["claude-opus-5-5"] });
    const blocks = vi.fn(async () => [block(now - 30 * 3_600_000, false, 500), block(now - 3_600_000, true, 2_000_000)]);
    const api: UsageApi = { summary: async () => summary(), sessions: async () => [], importScan: async () => done, importStatus: async () => done, blocks };
    const root = mount(() => <UsagePage api={api} desktop importEnabled onClose={() => undefined} />);
    await settle();
    await settle();
    expect(blocks).toHaveBeenCalledWith(30);
    const button = [...root.querySelectorAll('[aria-label="Group chart by"] button')].find((b) => b.textContent === "Blocks") as HTMLButtonElement;
    button.click();
    await settle();
    const rows = [...root.querySelectorAll(".usage-block")];
    expect(rows).toHaveLength(2);
    // Newest first, the open block marked with its time left.
    expect(rows[0].classList.contains("active")).toBe(true);
    expect(rows[0].textContent).toContain("2M");
    expect(rows[0].textContent).toMatch(/Active, 4h \d+m left/);
    expect(rows[1].textContent).toContain("3 turns");
    expect(root.textContent).toContain("Claude Code five-hour blocks");
    expect(root.querySelector('[aria-label="Legend"]')).toBeNull();
  });

  it("hides the Blocks mode when the importer is off", async () => {
    const blocks = vi.fn(async () => []);
    const root = mount(() => <UsagePage api={{ summary: async () => summary(), sessions: async () => [], blocks }} desktop onClose={() => undefined} />);
    await settle();
    expect([...root.querySelectorAll('[aria-label="Group chart by"] button')].map((b) => b.textContent)).toEqual(["By agent", "By model"]);
    expect(blocks).not.toHaveBeenCalled();
  });

  it("switches the chart between agents and models", async () => {
    const value = summary();
    value.models.push({ model: "local-model", agentIds: ["local"], price: null, totals: totals(500, cost({ known: false, complete: false, unpricedTokens: 500 })) });
    const root = mount(() => <UsagePage api={{ summary: async () => value, sessions: async () => [] }} desktop onClose={() => undefined} />);
    await settle();
    const legend = () => root.querySelector('[aria-label="Legend"]')!.textContent;
    expect(legend()).toContain("Claude Code");
    (root.querySelector('[aria-label="Group chart by"] button:nth-child(2)') as HTMLButtonElement).click();
    await settle();
    expect(legend()).toContain("Claude Opus 5.5");
    expect(legend()).toContain("local-model");
    expect(legend()).not.toContain("Claude Code");
  });
});

describe("UsageImportSettings", () => {
  it("is on by default and saves a change", () => {
    const onChange = vi.fn();
    const root = mount(() => <UsageImportSettings onChange={onChange} />);
    const toggle = root.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(root.textContent).toContain("On by default");
    toggle.click();
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
