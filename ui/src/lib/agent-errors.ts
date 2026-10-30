/**
 * Agent error classification: names a failed prompt from the text (and any JSON-RPC code or data) the agent reported,
 * so the panel can show a purpose-built card for usage limits, rate limits and overloads instead of the raw error.
 *
 * Matching is conservative on purpose: only phrases agents and providers are known to send are matched, and anything
 * else stays `unknown` with its raw text shown as before.
 */
import { createSignal } from "solid-js";

export type AgentErrorKind = "quota" | "rate_limit" | "overloaded" | "auth" | "context_too_long" | "unknown";

export type AgentErrorLink = { url: string; host: string; label: string };

export type AgentErrorInfo = {
  kind: AgentErrorKind;
  /** The provider the text names ("OpenCode", "Claude", "OpenAI", "Gemini", "OpenRouter"), else the agent's name. */
  provider?: string;
  /** A free-tier limit: other paid models may still work, and other free models may not. */
  freeTier: boolean;
  /** When the limit lifts or the provider asks for a retry, as epoch milliseconds. */
  resetAt?: number;
  /** The first https link in the text that reads as a plan or billing page. */
  link?: AgentErrorLink;
};

export type AgentErrorInput = {
  message: string;
  /** A JSON-RPC error code, when the backend kept it. */
  code?: number;
  /** JSON-RPC error data, when the backend kept it. Read only for retry hints and provider text. */
  data?: unknown;
  /** The agent's display name, used when the text names no provider. */
  agent?: string;
};

const AUTH = /authentication required|unauthori[sz]ed|invalid api key|not logged in|\b401\b/i;
/** Usage or credit exhausted. Each phrase comes from a provider's documented or observed error text. */
const QUOTA: readonly RegExp[] = [
  /free usage limit reached/i, // OpenCode Zen free tier
  /usage limit reached/i, // Claude Code ("Claude AI usage limit reached|<epoch>"), OpenCode
  /\b5-hour limit reached\b/i, // Claude Code plan window
  /exceeded your current quota/i, // OpenAI
  /\binsufficient_quota\b/i, // OpenAI error code
  /\bRESOURCE_EXHAUSTED\b/, // Gemini (Google RPC status)
  /\bquota (?:exceeded|reached|exhausted)\b/i, // Gemini "Quota exceeded for quota metric ..."
  /\binsufficient credits?\b/i, // OpenRouter 402
  /\binsufficient (?:account )?balance\b/i,
  /credit balance is too low/i, // Anthropic API
  /\bcredits? (?:exhausted|depleted)\b/i,
  /\b402\b.{0,40}\bpayment required\b/i,
];
const FREE_TIER = /\bfree (?:usage|tier|plan|models?)\b/i;
const RATE_LIMIT: readonly RegExp[] = [/\b429\b/, /too many requests/i, /\brate[ _-]?limit(?:ed|s|_exceeded|_error)?\b/i, /\bretry[ -]after\b/i];
const OVERLOADED: readonly RegExp[] = [/\boverloaded(?:_error)?\b/i, /\b529\b/, /\b503\b/, /service unavailable/i];
const CONTEXT: readonly RegExp[] = [/prompt is too long/i, /\bcontext_length_exceeded\b/i, /maximum context length/i, /context window (?:is )?(?:exceeded|full)/i];

const PROVIDERS: readonly [RegExp, string][] = [
  [/openrouter/i, "OpenRouter"],
  [/opencode/i, "OpenCode"],
  [/\bclaude\b|anthropic/i, "Claude"],
  [/\bgemini\b|RESOURCE_EXHAUSTED|generativelanguage\.googleapis/i, "Gemini"],
  [/openai|chatgpt|\bcodex\b|insufficient_quota/i, "OpenAI"],
];

/** Text of the JSON-RPC data, flattened so phrases inside it are matched too. */
function dataText(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return "";
  }
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000 };

/** "30s", "1m30s", "2h 10m", "45 seconds", "1.5 minutes" as milliseconds. */
export function parseDuration(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])/gi)) {
    total += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
    found = true;
  }
  return found ? Math.round(total) : undefined;
}

/** The next local time at `hour`:`minute` after `now`. */
function nextClock(hour: number, minute: number, now: number): number {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** When the limit lifts, from the forms providers send. Undefined when the text says nothing usable. */
export function resetTime(text: string, now: number): number | undefined {
  // Claude Code: "Claude AI usage limit reached|1760000000" (seconds, or milliseconds).
  const epoch = text.match(/limit reached\|(\d{10}|\d{13})\b/i);
  if (epoch) return epoch[1].length === 10 ? Number(epoch[1]) * 1000 : Number(epoch[1]);
  // Retry-After seconds, as a header echo or JSON data ("retry_after": 30, "retryAfter": "30").
  const after = text.match(/retry[ _-]?after"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?\b/i);
  if (after) return now + Number(after[1]) * (after[2]?.toLowerCase() === "ms" ? 1 : 1000);
  // Gemini RetryInfo: "retryDelay": "30s".
  const delay = text.match(/retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (delay) return now + Number(delay[1]) * 1000;
  // "Please try again in 20s", "try again in 1m30s", "resets in 2h 10m".
  const span = text.match(/(?:try again in|retry in|resets? in)\s+((?:\d+(?:\.\d+)?\s*[a-z]+\s*){1,3})/i);
  const ms = span ? parseDuration(span[1]) : undefined;
  if (ms !== undefined) return now + ms;
  // Claude Code: "5-hour limit reached ∙ resets 3pm", "resets at 10:30 pm".
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
    return nextClock(hour, Number(clock[2] ?? 0), now);
  }
  return undefined;
}

/** https links only, without trailing punctuation. Anything else (http, javascript:, file:) is ignored. */
export function httpsLinks(text: string): { url: string; host: string; index: number }[] {
  const links: { url: string; host: string; index: number }[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s"'<>()|]+/gi)) {
    const raw = match[0].replace(/[.,;:!?\]}]+$/, "");
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) continue;
      links.push({ url: parsed.toString(), host: parsed.hostname.replace(/^www\./, ""), index: match.index ?? 0 });
    } catch {
      // Not a URL after all.
    }
  }
  return links;
}

/** The plan or billing link: the last https link, labelled with the product the text asks to subscribe to. */
function planLink(text: string): AgentErrorLink | undefined {
  const links = httpsLinks(text);
  const last = links[links.length - 1];
  if (!last) return undefined;
  const before = text.slice(Math.max(0, last.index - 80), last.index);
  const product = before.match(/(?:subscribe to|upgrade to|switch to)\s+([A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,2})/);
  return { url: last.url, host: last.host, label: product ? `Open ${product[1]}` : `Open ${last.host}` };
}

/** Classifies an agent error. Pure: the same input and `now` give the same result. */
export function classifyAgentError(input: AgentErrorInput, now = Date.now()): AgentErrorInfo {
  const text = `${input.message}\n${dataText(input.data)}`;
  const provider = PROVIDERS.find(([pattern]) => pattern.test(text))?.[1] ?? (input.agent || undefined);
  const base = { provider, freeTier: false };
  if (AUTH.test(text)) return { ...base, kind: "auth" };
  const limited = (kind: AgentErrorKind): AgentErrorInfo => {
    const resetAt = resetTime(text, now);
    const link = planLink(text);
    return { ...base, kind, freeTier: kind === "quota" && FREE_TIER.test(text), ...(resetAt !== undefined ? { resetAt } : {}), ...(link ? { link } : {}) };
  };
  if (QUOTA.some((pattern) => pattern.test(text)) || input.code === 402) return limited("quota");
  if (RATE_LIMIT.some((pattern) => pattern.test(text)) || input.code === 429) return limited("rate_limit");
  if (OVERLOADED.some((pattern) => pattern.test(text)) || input.code === 529) return limited("overloaded");
  if (CONTEXT.some((pattern) => pattern.test(text))) return { ...base, kind: "context_too_long" };
  return { ...base, kind: "unknown" };
}

/** True for the kinds the limit card handles. */
export const isLimitKind = (kind: AgentErrorKind) => kind === "quota" || kind === "rate_limit" || kind === "overloaded";

/** "30s", "4m 05s", "2h 10m". */
export function waitText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Card title. `now` makes the rate-limit countdown live. */
export function limitTitle(info: AgentErrorInfo, now: number): string {
  const who = info.provider ?? "Provider";
  if (info.kind === "quota") return info.freeTier ? `${who} free usage limit reached` : `${who} usage limit reached`;
  if (info.kind === "rate_limit") return info.resetAt !== undefined && info.resetAt > now ? `Rate limited, try again in ${waitText(info.resetAt - now)}` : "Rate limited";
  if (info.kind === "overloaded") return "Provider overloaded";
  return "Agent error";
}

/** One short sentence under the title. */
export function limitSentence(info: AgentErrorInfo, now: number): string {
  const resets = info.resetAt !== undefined && info.resetAt > now ? ` Resets in ${waitText(info.resetAt - now)}.` : "";
  if (info.kind === "quota") return info.freeTier ? `This model's free usage is used up.${resets}` : `No usage left on this plan for now.${resets}`;
  if (info.kind === "rate_limit") return "Too many requests in a short time.";
  if (info.kind === "overloaded") return "The provider is busy right now.";
  return "";
}

/** The status bar line. */
export function limitStatus(info: AgentErrorInfo): string {
  if (info.kind === "quota") return info.freeTier ? "Free limit reached" : "Usage limit reached";
  if (info.kind === "rate_limit") return "Rate limited";
  if (info.kind === "overloaded") return "Provider overloaded";
  return "Prompt failed";
}

/** The latest limit the open chat hit, for any panel that shows usage. Cleared on the next successful turn. */
export type AgentLimit = { kind: AgentErrorKind; provider?: string; resetAt?: number; freeTier: boolean; agentId?: string; model?: string };
const [limit, setLimit] = createSignal<AgentLimit>();
export const agentLimit = limit;
export const setAgentLimit = setLimit;
