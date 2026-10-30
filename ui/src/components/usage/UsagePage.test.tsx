// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { UsageCost, UsageSummary_Serialize as UsageSummary, UsageTotals_Serialize as UsageTotals } from "../../bindings";
import { UsagePage, type UsageApi } from "./UsagePage";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });
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
    days: [{ day: "2026-10-28", agents: [{ agentId: "claude", tokens: 1_000_000, cost: priced }] }, { day: "2026-10-29", agents: [{ agentId: "local", tokens: 500, cost: unknown }] }],
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
    const running = { enabled: true, running: true, report: { filesTotal: 2314, filesDone: 949, filesRead: 949, bytesRead: 10, entries: 4, duplicates: 0, skipped: 0, truncated: false }, scannedMs: null, error: null };
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
});
