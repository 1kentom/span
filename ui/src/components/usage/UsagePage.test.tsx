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
  it("labels estimates, never prices unknown usage as zero, and offers the opt-in importer", async () => {
    const api: UsageApi = { summary: vi.fn(async () => summary()), sessions: vi.fn(async () => []) };
    const onImportChange = vi.fn(async () => undefined);
    const root = mount(() => <UsagePage api={api} desktop onClose={() => undefined} onImportChange={onImportChange} />);
    await settle();
    expect(root.textContent).toContain("Cost figures are estimates.");
    expect(root.textContent).toContain("not your subscription bill");
    expect(root.textContent).toContain("$4.00+");
    const local = [...root.querySelectorAll("tr")].find((row) => row.textContent?.includes("Local"))!;
    expect(local.textContent).toContain("No price");
    expect(local.textContent).not.toContain("$0.00");
    expect(api.summary).toHaveBeenCalledWith(expect.objectContaining({ source: "tracked" }));
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Import local logs")!.click();
    expect(onImportChange).toHaveBeenCalledWith(true);
  });

  it("scans local logs when the importer is on and shows the source filter", async () => {
    const status = { enabled: true, running: false, report: { filesTotal: 3, filesDone: 3, filesRead: 3, bytesRead: 10, entries: 4, duplicates: 0, skipped: 0, truncated: false }, scannedMs: Date.UTC(2026, 9, 29, 12), error: null };
    const api: UsageApi = { summary: vi.fn(async () => summary()), sessions: vi.fn(async () => []), importScan: vi.fn(async () => status), importStatus: vi.fn(async () => status) };
    const root = mount(() => <UsagePage api={api} desktop importEnabled onClose={() => undefined} />);
    await settle();
    expect(api.importScan).toHaveBeenCalledTimes(1);
    expect(root.querySelector('[aria-label="Source"]')).not.toBeNull();
    expect(root.textContent).toContain("Local logs read");
    expect(root.textContent).toContain("3 files");
    expect(root.textContent).not.toContain("Import local logs");
    (root.querySelector('[aria-label="Source"] button[title="Imported from local logs"]') as HTMLButtonElement).click();
    await settle();
    expect(api.summary).toHaveBeenLastCalledWith(expect.objectContaining({ source: "imported" }));
  });

  it("explains an empty history and closes on Escape", async () => {
    const empty = { ...summary(), totals: totals(0, cost({})), days: [], agents: [], models: [], topModel: null, trackedSessions: 0 };
    empty.totals.turns = 0;
    const onClose = vi.fn();
    const root = mount(() => <UsagePage api={{ summary: async () => empty, sessions: async () => [] }} desktop onClose={onClose} />);
    await settle();
    expect(root.textContent).toContain("No usage recorded yet");
    root.querySelector(".usage-page")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });
});
