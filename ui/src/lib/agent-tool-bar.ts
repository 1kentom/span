import type { AgentEvent } from "../bindings";
import { RUN_TEXT } from "./agent-hint-text";
import type { FeedItem } from "./agent-session";
import { URL_COPY } from "./agent-url-request";
import { clockText } from "./agent-running";
import { toStep } from "./agent-view";

type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

/** How long a finished tool stays on the bar, so a quick run of tools never flickers back to "Thinking" between calls. */
export const SETTLE_MS = 1_500;
/** A failed tool stays a little longer, long enough to read the reason. */
export const FAILED_SETTLE_MS = 5_000;
/** Longest secondary or reason text kept in the DOM. CSS truncates to one line; the full text sits in the tooltip. */
const MAX_TEXT = 400;

const UNFINISHED = new Set(["pending", "in_progress"]);

/** Friendly labels for the ACP tool kinds. */
const KIND_LABEL: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Execute",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

/** Short human titles for a request waiting on approval, by ACP tool kind: the command or path is shown elsewhere, once. */
const APPROVAL_TITLE: Record<string, string> = {
  execute: "Run command",
  edit: "Edit file",
  read: "Read file",
  delete: "Delete file",
  move: "Move file",
  search: "Search files",
  fetch: "Fetch page",
};

/** "Run command" for execute, "Edit file" for edit; undefined for a kind without a short approval title. */
export function approvalTitle(kind: string | null | undefined): string | undefined {
  return kind ? APPROVAL_TITLE[kind] : undefined;
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string) => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value);

/** "web_search", "WebFetch" or "read-file" as words with one capital: "Web search", "Web fetch", "Read file". */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

const isBareName = (title: string) => /^[A-Za-z][\w.-]{0,31}$/.test(title);

/** The bar's main label: the ACP kind as a word, or a humanized bare tool name, never a raw identifier. */
export function friendlyToolTitle(event: Pick<ToolEvent, "toolKind" | "title">): string {
  const kind = event.toolKind ? KIND_LABEL[event.toolKind] : undefined;
  if (kind) return kind;
  const title = squash(event.title ?? "");
  if (title && isBareName(title)) return humanizeName(title);
  return "Tool";
}

/**
 * The one-line secondary: the shell command, else the file or target path, else the agent's own title when it says
 * more than the label (a title such as "execute" or "Read" adds nothing and is dropped).
 */
export function toolSummary(event: ToolEvent): string | undefined {
  const step = toStep(event, []);
  if (step.detail?.type === "terminal") {
    const command = step.detail.lines.find((line) => line.kind === "cmd")?.text;
    if (command?.trim()) return clip(squash(command));
  }
  if (step.target?.trim()) return clip(squash(step.target));
  const title = squash(event.title ?? "");
  if (!title) return undefined;
  const label = friendlyToolTitle(event).toLowerCase();
  const plain = title.toLowerCase();
  if (plain === label || plain === (event.toolKind ?? "").toLowerCase() || humanizeName(title).toLowerCase() === label) return undefined;
  return clip(title);
}

/** A short reason for a failed tool: its error or stderr, else its first text line, else a generic line. */
export function failureReason(event: ToolEvent): string {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value.split("\n").map(squash).find(Boolean);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      for (const key of ["error", "message", "stderr", "reason"]) {
        const found = pick(entry[key]);
        if (found) return found;
      }
    }
    return undefined;
  };
  let update: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(event.contentJson) as unknown;
    update = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    update = undefined;
  }
  const fromOutput = pick((event as { rawOutput?: unknown }).rawOutput ?? update?.rawOutput);
  if (fromOutput) return clip(fromOutput);
  const content = Array.isArray(update?.content) ? (update!.content as { type?: string; content?: { type?: string; text?: unknown } }[]) : [];
  for (const entry of content) {
    const found = entry?.type === "content" && entry.content?.type === "text" ? pick(entry.content.text) : undefined;
    if (found) return clip(found);
  }
  return "The tool call failed";
}

/** Every visible tool call that has not finished, oldest first. Agent housekeeping calls are left out. */
export function runningTools(feed: readonly FeedItem[]): ToolEvent[] {
  return feed.flatMap((item) => (item.kind === "tool" && !item.event.internal && UNFINISHED.has(item.event.status ?? "pending") ? [item.event] : []));
}

/** The newest visible tool call that finished (completed or failed), for the brief settle after it ends. */
export function lastFinishedTool(feed: readonly FeedItem[]): ToolEvent | undefined {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const item = feed[index];
    if (item.kind !== "tool" || item.event.internal) continue;
    if (item.event.status === "completed" || item.event.status === "failed") return item.event;
  }
  return undefined;
}

export type ToolBarTone = "thinking" | "running" | "attention" | "stopping" | "done" | "failed";

export type ToolBarView = {
  tone: ToolBarTone;
  /** Friendly title or phase: "Execute", "Thinking", "Waiting for your approval". */
  label: string;
  /** One-line monospace secondary (command or path), with the full text for the tooltip. */
  summary?: string;
  /** True when the shown tool is a shell command. */
  command: boolean;
  /** The one timer on the bar: the shown tool's own elapsed time, or the turn's while nothing runs. */
  elapsed: string;
  /** The turn's elapsed time, only when it differs from `elapsed`, for the timer tooltip. */
  turn?: string;
  /** Other tools running at the same time, for the "+N more" chip, with their labels for its tooltip. */
  more: string[];
  /** Why the shown tool failed. */
  reason?: string;
  /** Whether "Esc to stop" applies: not while waiting on the user or after a stop was asked. */
  stoppable: boolean;
  /** The polite announcement. Never contains the timer, so it changes only when the phase or tool changes. */
  announce: string;
  /** The tool call shown, so the output tail can follow it. */
  toolCallId?: string;
};

export type ToolBarInput = {
  /** Running tools, oldest first. The newest is shown. */
  running: readonly ToolEvent[];
  /** The newest finished tool, considered for the settle. */
  finished?: ToolEvent;
  /** Start and last update times of a tool call, in milliseconds. */
  timesOf: (event: ToolEvent) => { start: number; last: number } | undefined;
  now: number;
  /** Turn start in milliseconds, 0 when unknown. */
  turnStart: number;
  approval?: boolean;
  answer?: boolean;
  browser?: boolean;
  stopping?: boolean;
};

/** One timer string for a start time, from the same clock as every other timer on the bar. */
const since = (now: number, start: number) => clockText(now - (start || now));

/**
 * What the single running bar above the composer says. One source of truth: every timer comes from `now` and a
 * recorded start, so the tool timer and the turn timer can never disagree, and only one of them is drawn.
 */
export function toolBarView(input: ToolBarInput): ToolBarView {
  const turn = since(input.now, input.turnStart);
  const newest = input.running.at(-1);
  const settling = !newest && input.finished ? settle(input.finished, input) : undefined;
  const shown = newest ?? settling;
  const times = shown ? input.timesOf(shown) : undefined;
  const ended = !newest && settling ? (times?.last ?? input.now) : input.now;
  const elapsed = shown ? clockText(ended - (times?.start ?? (input.turnStart || ended))) : turn;
  const label = shown ? friendlyToolTitle(shown) : RUN_TEXT.thinking;
  const summary = shown ? toolSummary(shown) : undefined;
  const more = newest ? input.running.slice(0, -1).reverse().map((event) => [friendlyToolTitle(event), toolSummary(event)].filter(Boolean).join(" ")) : [];
  const base = {
    command: shown?.toolKind === "execute",
    elapsed,
    turn: turn !== elapsed ? turn : undefined,
    more,
    toolCallId: shown?.toolCallId,
  };
  const describe = (head: string) => [head, summary].filter(Boolean).join(": ");
  if (input.stopping) return { ...base, tone: "stopping", label: `${RUN_TEXT.stopping}…`, summary, stoppable: false, announce: RUN_TEXT.stopping };
  // The approval dock right below names the request and shows its command once, so the bar repeats neither.
  if (input.approval) return { ...base, tone: "attention", label: RUN_TEXT.approval, summary: undefined, stoppable: false, announce: RUN_TEXT.approval };
  if (input.browser) return { ...base, tone: "attention", label: URL_COPY.activityUrl, summary: undefined, stoppable: false, announce: URL_COPY.activityUrl };
  if (input.answer) return { ...base, tone: "attention", label: RUN_TEXT.answer, summary: undefined, stoppable: false, announce: RUN_TEXT.answer };
  if (settling?.status === "failed") {
    const reason = failureReason(settling);
    return { ...base, tone: "failed", label, summary, reason, stoppable: true, announce: `${describe(label)} failed: ${reason}` };
  }
  if (settling) return { ...base, tone: "done", label, summary, stoppable: true, announce: `${describe(label)} done` };
  if (newest) return { ...base, tone: "running", label, summary, stoppable: true, announce: `${newest.toolKind === "execute" ? RUN_TEXT.runningCommand : RUN_TEXT.running}: ${summary ?? label}` };
  return { ...base, tone: "thinking", label, summary: undefined, stoppable: true, announce: RUN_TEXT.thinking };
}

/** The finished tool when it ended within its settle window, else undefined. */
function settle(event: ToolEvent, input: ToolBarInput): ToolEvent | undefined {
  const last = input.timesOf(event)?.last;
  if (last === undefined || (input.turnStart && last < input.turnStart)) return undefined;
  const window = event.status === "failed" ? FAILED_SETTLE_MS : SETTLE_MS;
  return input.now - last <= window ? event : undefined;
}
