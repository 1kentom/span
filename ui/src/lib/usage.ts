/**
 * Usage page helpers (ADR 0012): what a finished turn reported, turned into a metadata patch; day ranges; number and
 * dollar formatting that never shows an unknown price as $0; fixed series slots per agent; and the CSV export.
 * Counters only: nothing here reads or keeps prompt text.
 */
import type { AgentEvent, SessionMetaPatch_Deserialize as SessionMetaPatch, SessionUsageRow_Serialize as SessionUsageRow, TokenCounts_Deserialize as TokenCounts, UsageCost, UsageRange_Deserialize as UsageRange } from "../bindings";

export type RangeKey = "today" | "7d" | "30d" | "all";
export const RANGES: readonly { key: RangeKey; label: string; days?: number }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "all", label: "All" },
];

/** `YYYY-MM-DD` of `date` in the local time zone. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type SourceKey = "all" | "tracked" | "imported";
export const SOURCES: readonly { key: SourceKey; label: string }[] = [
  { key: "all", label: "All sources" },
  { key: "tracked", label: "Tracked by Span" },
  { key: "imported", label: "Imported from local logs" },
];

/**
 * The inclusive local day range for a range key, ending today ("All" is open on both ends), with the viewer's UTC
 * offset so imported usage lands on local days, and the source filter.
 */
export function rangeFor(key: RangeKey, now: Date = new Date(), source: SourceKey = "all"): UsageRange {
  const base: UsageRange = { utcOffsetMinutes: -now.getTimezoneOffset(), ...(source !== "all" ? { source } : {}) };
  const days = RANGES.find((range) => range.key === key)?.days;
  if (!days) return base;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { ...base, from: localDay(start), to: localDay(now) };
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** ACP `PromptResponse.usage` (unstable) as token counts, camelCase or snake_case. `undefined` when nothing usable. */
export function turnTokenCounts(usage: unknown): TokenCounts | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const pick = (...keys: string[]) => count(keys.map((key) => record[key]).find((value) => typeof value === "number"));
  const tokens: TokenCounts = {
    input: pick("inputTokens", "input_tokens"),
    output: pick("outputTokens", "output_tokens"),
    cacheRead: pick("cachedReadTokens", "cacheReadTokens", "cache_read_input_tokens", "cached_input_tokens"),
    cacheWrite: pick("cachedWriteTokens", "cacheWriteTokens", "cache_creation_input_tokens"),
    thought: pick("thoughtTokens", "reasoningTokens", "reasoning_output_tokens"),
    total: pick("totalTokens", "total_tokens"),
  };
  return Object.values(tokens).some((value) => value > 0) ? tokens : undefined;
}

type Seen = { used?: number; size?: number; costMicros?: number; currency?: string };

/**
 * Keeps the latest `usage_update` of each session and turns a `complete` event into one usage patch for the metadata
 * store: the turn's token counts (when the agent sent them), the cumulative cost (the store adds only its growth) and
 * the context reading. One patch per finished turn, so the store is written once per turn, never per update.
 */
export function createUsageRecorder(limit = 200) {
  const seen = new Map<string, Seen>();
  function remember(sessionId: string, next: Seen) {
    seen.delete(sessionId);
    seen.set(sessionId, next);
    if (seen.size > limit) seen.delete(seen.keys().next().value!);
  }
  function observe(event: AgentEvent, context: { agentId?: string; model?: string; day?: string }): SessionMetaPatch | undefined {
    if (event.kind === "usage") {
      const amount = event.costAmount;
      const cost = typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && event.costCurrency ? { costMicros: Math.round(amount * 1_000_000), currency: event.costCurrency } : {};
      remember(event.sessionId, { ...seen.get(event.sessionId), used: count(event.used), size: count(event.size), ...cost });
      return undefined;
    }
    if (event.kind !== "complete" || !context.agentId) return undefined;
    const last = seen.get(event.sessionId);
    const tokens = turnTokenCounts(event.usage);
    return {
      agentId: context.agentId,
      sessionId: event.sessionId,
      usage: {
        day: context.day ?? localDay(new Date()),
        ...(context.model ? { model: context.model } : {}),
        ...(tokens ? { tokens } : {}),
        ...(last?.costMicros !== undefined && last.currency ? { costTotal: { micros: last.costMicros, currency: last.currency } } : {}),
        ...(last?.used !== undefined && last.size ? { context: { used: last.used, size: last.size } } : {}),
      },
    };
  }
  return { observe };
}

/** 950, 12.3k, 4.56M, 1.2B. Exact figures belong in the tooltip and the table. */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2).replace(/\.?0+$/, "")}${unit}`;
    }
  }
  return String(value);
}

/** A dollar amount from the backend: specta types a Rust f64 as `number | null`. */
export const money = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const fullNumber = (value: number) => Math.round(value).toLocaleString("en-US");

/** "$12.34", "$0.0042", "< $0.0001". */
export function usd(value: number): string {
  if (value > 0 && value < 0.0001) return "< $0.0001";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 4 : 2, minimumFractionDigits: 2 }).format(value);
}

/**
 * A cost cell: no amount at all when nothing was priced (never "$0.00"), a trailing "+" when some tokens had no price.
 * `title` says where the number came from.
 */
export function costText(cost: UsageCost): { text: string; title: string; known: boolean } {
  if (!cost.known) return { text: "No price", title: "No price is known for this model and the agent reported no cost. Tokens are still counted.", known: false };
  const parts: string[] = [];
  if (money(cost.reportedUsd) > 0) parts.push(`${usd(money(cost.reportedUsd))} reported by the agent`);
  if (money(cost.estimatedUsd) > 0) parts.push(`${usd(money(cost.estimatedUsd))} estimated from tokens`);
  if (!cost.complete) parts.push(`${fullNumber(cost.unpricedTokens)} tokens without a price are not included`);
  return { text: `${usd(money(cost.usd))}${cost.complete ? "" : "+"}`, title: `API-equivalent estimate: ${parts.join("; ") || "no billable tokens"}. Not your subscription bill.`, known: true };
}

/**
 * Series slot (1 to 5) for an agent: the four common agents keep their own slot in every view, others take the next
 * free slot in name order, and a sixth agent onward folds into "Other". Colour follows the agent, never its rank.
 */
export const SERIES_SLOTS = 5;
const FIXED_SLOTS: Record<string, number> = { claude: 1, "claude-code": 1, "claude-acp": 1, codex: 2, "codex-acp": 2, gemini: 3, "gemini-cli": 3, opencode: 4 };
export function slotFor(agentId: string): number | undefined {
  const id = agentId.toLowerCase();
  if (FIXED_SLOTS[id]) return FIXED_SLOTS[id];
  const key = Object.keys(FIXED_SLOTS).find((name) => id.startsWith(`${name}-`) || id.startsWith(`${name}:`) || id.endsWith(`/${name}`));
  return key ? FIXED_SLOTS[key] : undefined;
}
export function assignSlots(agentIds: readonly string[]): Map<string, number | "other"> {
  const slots = new Map<string, number | "other">();
  const used = new Set<number>();
  for (const id of agentIds) {
    const slot = slotFor(id);
    if (slot !== undefined && !used.has(slot)) { slots.set(id, slot); used.add(slot); }
  }
  for (const id of [...agentIds].filter((id) => !slots.has(id)).sort()) {
    const free = [1, 2, 3, 4, 5].find((slot) => !used.has(slot));
    if (free === undefined) slots.set(id, "other");
    else { slots.set(id, free); used.add(free); }
  }
  return slots;
}

/** Sorting for the tables: a key per column, numbers descending by default. */
export type SortState<K extends string> = { key: K; descending: boolean };
export function sortRows<T, K extends string>(rows: readonly T[], sort: SortState<K>, value: (row: T, key: K) => number | string): T[] {
  const direction = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = value(a, sort.key);
    const right = value(b, sort.key);
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

function csvField(value: string | number): string {
  const text = String(value);
  // A leading formula character is neutralised so a spreadsheet never evaluates a field.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One row per session in the range. Costs are left empty when unknown, never written as 0. */
export function usageCsv(rows: readonly SessionUsageRow[]): string {
  const header = ["source", "agent", "agent_id", "session_id", "title", "first_seen", "last_active", "models", "turns", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "total_tokens", "cost_usd_estimate", "cost_complete", "cost_reported_usd"];
  const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : "");
  const lines = rows.map((row) => {
    const t = row.totals.tokens;
    const cost = row.totals.cost;
    return [row.imported ? "imported" : "tracked", row.agentName, row.agentId, row.sessionId, row.title ?? "", iso(row.firstSeenMs), iso(row.lastActiveMs), row.models.join(" "), row.totals.turns, t.input, t.output, t.cacheRead, t.cacheWrite, t.thought, t.total, cost.known ? money(cost.usd).toFixed(6) : "", cost.known ? String(cost.complete) : "", money(cost.reportedUsd) > 0 ? money(cost.reportedUsd).toFixed(6) : ""].map(csvField).join(",");
  });
  return `${[header.join(","), ...lines].join("\n")}\n`;
}

/** `span-usage-2026-10-29.csv`. */
export function csvFileName(now: Date = new Date()) {
  return `span-usage-${localDay(now)}.csv`;
}

/** "Oct 29" for a `YYYY-MM-DD` day, read as a local date. */
export function shortDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export function longDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
