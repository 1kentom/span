/**
 * Context window, cost, limit and compaction view data for the composer's context meter. Every number comes from
 * what an agent reported over ACP (`usage_update` with `used`, `size` and an optional `cost`, the delegation meter
 * for delegated children, and the advertised slash commands). Nothing here estimates or fills in a missing value.
 */
import type { SlashCommand } from "../bindings";
import type { DelegationTaskState } from "./agent-delegation";
import { isFinished } from "./agent-delegation";

export type Tone = "neutral" | "attention" | "danger";
export type Cost = { amount: number; currency: string };
export type ContextUsage = { used: number; size: number; cost?: Cost };

/** At or above this the meter turns to the attention tone. */
export const ATTENTION_AT = 70;
/** Above this the meter turns to the danger tone. */
export const DANGER_ABOVE = 90;
/** At or above this a Compact hint appears, only when the agent advertised a compact command. */
export const COMPACT_HINT_AT = 80;

/** Whole percent of the window used, clamped to 0..100. `undefined` when the window size is not a usable number. */
export function contextPercent(used: number | null | undefined, size: number | null | undefined): number | undefined {
  if (typeof used !== "number" || typeof size !== "number" || !Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((used / size) * 100)));
}

/** Neutral under 70%, attention from 70% to 90%, danger over 90%. Unknown reads as neutral. */
export function contextTone(pct: number | undefined): Tone {
  if (pct === undefined) return "neutral";
  if (pct > DANGER_ABOVE) return "danger";
  if (pct >= ATTENTION_AT) return "attention";
  return "neutral";
}

/** 950, 1.2k, 12k, 128k, 1M, 1.5M. Never rounds 999,999 up to a misleading "1000k". */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${trim(Math.floor(count / 100) / 10)}k`;
  if (count < 1_000_000) return `${Math.floor(count / 1000)}k`;
  return `${trim(Math.floor(count / 100_000) / 10)}M`;
}

/** The cost in its currency, only when the agent reported both an amount and a currency. */
export function formatCost(cost: { amount?: number | null; currency?: string | null } | undefined): string | undefined {
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || !cost.currency) return undefined;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cost.currency, maximumFractionDigits: cost.amount < 1 ? 4 : 2 }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

/** The compact command an agent advertised, with its leading slash, or `undefined`. Never assumed per agent. */
export function compactCommand(commands: readonly Pick<SlashCommand, "name">[]): string | undefined {
  const found = commands.find((command) => command.name.replace(/^\//, "").toLowerCase() === "compact");
  return found ? `/${found.name.replace(/^\//, "")}` : undefined;
}

export function compactHint(pct: number): string {
  return `Context is ${pct}% full. Compact?`;
}

/** The quiet hint shows once the window passes the threshold, the agent can compact, and nothing is in the way. */
export function showCompactHint(input: { pct: number | undefined; canCompact: boolean; dismissed: boolean; running: boolean; stale: boolean; compacting: boolean }): boolean {
  return input.pct !== undefined && input.pct >= COMPACT_HINT_AT && input.canCompact && !input.dismissed && !input.running && !input.stale && !input.compacting;
}

/**
 * Meter states. `unknown`: nothing reported yet. `unreported`: a turn finished and the agent sent no context usage.
 * `stale`: the last report came from before a model switch. `live`: a current report.
 */
export type MeterState = "unknown" | "unreported" | "stale" | "live";

export function meterState(input: { usage?: ContextUsage; turnFinished: boolean; stale: boolean }): MeterState {
  if (!input.usage || contextPercent(input.usage.used, input.usage.size) === undefined) return input.turnFinished ? "unreported" : "unknown";
  return input.stale ? "stale" : "live";
}

/** The one-line meter text. */
export function meterLabel(state: MeterState, pct: number | undefined): string {
  if ((state === "live" || state === "stale") && pct !== undefined) return `${pct}% context`;
  if (state === "unreported") return "Context not reported";
  return "Context unknown";
}

/** The meter's accessible name: the numbers, the cost when reported, and why a number may be old. */
export function meterAria(state: MeterState, usage: ContextUsage | undefined, agent: string): string {
  const pct = usage ? contextPercent(usage.used, usage.size) : undefined;
  if ((state === "live" || state === "stale") && usage && pct !== undefined) {
    const cost = formatCost(usage.cost);
    const parts = [`Context ${pct}% used, ${usage.used.toLocaleString("en-US")} of ${usage.size.toLocaleString("en-US")} tokens`];
    if (cost) parts.push(`cost ${cost}`);
    if (state === "stale") parts.push("from before the model switch");
    return `${parts.join(", ")}. Show usage details`;
  }
  if (state === "unreported") return `${agent} has not reported context usage. Show usage details`;
  return "Context usage not reported yet. Show usage details";
}

/** The settled line after a compaction. Both percentages only when both are known. */
export function compactionMessage(before: number | undefined, after: number | undefined): string {
  return before !== undefined && after !== undefined ? `Compacted, ${before}% to ${after}%` : "Compacted";
}

export type CompactPhase = "running" | "done" | "failed";
export type CompactRun = { phase: CompactPhase; before?: number; after?: number; error?: string };
export type CompactSignal =
  | { kind: "usage"; pct: number | undefined }
  | { kind: "compaction"; status: string; error?: string }
  | { kind: "turnEnd"; error?: string };

export function startCompaction(before: number | undefined): CompactRun {
  return { phase: "running", before };
}

/**
 * Advances a compaction from what the agent reports. The next usage update gives the after figure (also when it lands
 * just after the turn ended). An ACP compaction update or the turn ending settles the run; an error fails it.
 */
export function compactStep(run: CompactRun, signal: CompactSignal): CompactRun {
  switch (signal.kind) {
    case "usage":
      if (run.phase === "running" || (run.phase === "done" && run.after === undefined)) return signal.pct === undefined ? run : { ...run, after: signal.pct };
      return run;
    case "compaction":
      if (run.phase !== "running") return run;
      if (signal.status === "failed") return { ...run, phase: "failed", error: signal.error || undefined };
      if (signal.status === "cancelled") return { ...run, phase: "failed", error: "Compaction was cancelled" };
      if (signal.status === "completed") return { ...run, phase: "done" };
      return run;
    case "turnEnd":
      if (run.phase !== "running") return run;
      return signal.error ? { ...run, phase: "failed", error: signal.error } : { ...run, phase: "done" };
  }
}

export function compactRunText(run: CompactRun): string {
  if (run.phase === "running") return "Compacting context";
  if (run.phase === "failed") return run.error ? `Compaction failed: ${run.error}` : "Compaction failed";
  return compactionMessage(run.before, run.after);
}

/** Limit facts for one agent, mapped from the quota classifier's AgentLimit by limitNote. */
export type LimitNote = { provider?: string; resetsAtMs?: number; kind?: "quota" | "rate_limit" };

/**
 * The last quota or rate-limit event as a popover note, only for the agent that hit it and only until its reset time.
 * Success clears the source signal; other kinds (auth, overloaded) are not a limit line.
 */
export function limitNote(event: { kind: string; provider?: string; resetAt?: number; agentId?: string } | undefined, agentId: string | undefined, now: number): LimitNote | undefined {
  if (!event || (event.kind !== "quota" && event.kind !== "rate_limit")) return undefined;
  if (!agentId || event.agentId !== agentId) return undefined;
  if (event.resetAt !== undefined && event.resetAt <= now) return undefined;
  return { kind: event.kind, provider: event.provider, resetsAtMs: event.resetAt };
}

/** "2h", "45m", "3d". Rounds up so a reset is never shown as sooner than it is. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

/** "Limit reached, resets in 2h" or "Rate limited, resets in 4m"; the reset part only when known and still ahead. */
export function limitText(limit: LimitNote, now: number): string {
  const reset = limit.resetsAtMs !== undefined && limit.resetsAtMs > now ? `, resets in ${formatWait(limit.resetsAtMs - now)}` : "";
  return `${limit.kind === "rate_limit" ? "Rate limited" : "Limit reached"}${reset}`;
}

/** One agent's own row in the popover. A delegated child's figures are its own delegation meter, never the lead's. */
export type AgentUsageRow = {
  key: string;
  id?: string;
  name: string;
  lead: boolean;
  /** For the lead: current context. For a child: the peak context its meter recorded. */
  used?: number;
  size?: number;
  pct?: number;
  tone: Tone;
  cost?: string;
  /** What the figures mean, in words. */
  note: string;
};

export function agentUsageRows(input: { lead: { id?: string; name: string; usage?: ContextUsage; stale?: boolean }; tasks: readonly DelegationTaskState[] }): AgentUsageRow[] {
  const lead = input.lead;
  const leadPct = lead.usage ? contextPercent(lead.usage.used, lead.usage.size) : undefined;
  const rows: AgentUsageRow[] = [
    {
      key: "lead",
      id: lead.id,
      name: lead.name,
      lead: true,
      used: leadPct !== undefined ? lead.usage!.used : undefined,
      size: leadPct !== undefined ? lead.usage!.size : undefined,
      pct: leadPct,
      tone: lead.stale ? "neutral" : contextTone(leadPct),
      cost: formatCost(lead.usage?.cost),
      note: leadPct === undefined ? "Not reported" : `${formatTokens(lead.usage!.used)} of ${formatTokens(lead.usage!.size)}${lead.stale ? ", before model switch" : ""}`,
    },
  ];
  for (const task of input.tasks) {
    if (isFinished(task.status) || task.status === "starting") continue;
    const budget = task.budgetUsed;
    const tokens = typeof budget?.tokens === "number" ? budget.tokens : undefined;
    const size = typeof budget?.contextSize === "number" ? budget.contextSize : undefined;
    // The meter's token figure can be summed turn totals, which may exceed the window: then it is not a context share.
    const pct = tokens !== undefined && size !== undefined && tokens <= size ? contextPercent(tokens, size) : undefined;
    rows.push({
      key: task.taskId,
      id: task.startingAgentId,
      name: task.agentName || task.startingAgentId || "Delegated agent",
      lead: false,
      used: tokens,
      size,
      pct,
      tone: contextTone(pct),
      cost: formatCost({ amount: budget?.cost, currency: budget?.currency }),
      note: tokens === undefined ? "Not reported" : pct !== undefined ? `Peak ${formatTokens(tokens)} of ${formatTokens(size!)}` : `${formatTokens(tokens)} tokens reported`,
    });
  }
  return rows;
}
