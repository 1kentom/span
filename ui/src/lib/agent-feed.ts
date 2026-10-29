import type { AgentEvent } from "../bindings";

export type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

const limitLine = (text: string) => {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
};

const OPTION_ORDER = ["allow_once", "allow_always", "reject_once", "reject_always"];

/** Allow choices first, then reject choices, keeping the agent's order inside a kind. */
export function sortPermissionOptions<T extends { kind: string }>(options: readonly T[]): T[] {
  const rank = (option: T) => {
    const index = OPTION_ORDER.indexOf(option.kind);
    return index < 0 ? OPTION_ORDER.length : index;
  };
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map(({ option }) => option);
}

export function permissionScope(kind: string): string {
  if (kind === "allow_always") return "Remembered by Span for this session";
  if (kind === "reject_always") return "Remembered by Span for this session";
  return "";
}

/** The first useful string of a tool's input or locations: a command, a path, a url, a pattern. */
function pickTarget(rawInput: unknown, locations: unknown): string {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const list = Array.isArray(locations) ? locations : [];
  const firstLocation = list[0] && typeof list[0] === "object" ? (list[0] as Record<string, unknown>).path : undefined;
  const command = Array.isArray(input.command) ? input.command.join(" ") : input.command;
  const pick = [command, input.file_path, input.path, input.url, input.pattern, input.query, firstLocation].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return limitLine(pick ?? "");
}

/** One line describing what a tool call will touch, from its raw ACP update. */
export function toolSummary(contentJson: string): string {
  let update: unknown;
  try {
    update = JSON.parse(contentJson);
  } catch {
    return "";
  }
  if (!update || typeof update !== "object") return "";
  const record = update as Record<string, unknown>;
  return pickTarget(record.rawInput, record.locations);
}

/** Like `toolSummary`, but reads the typed rawInput and locations first and re-parses contentJson only when they are absent. */
export function toolTarget(event: { rawInput?: unknown; locations?: readonly unknown[] | null; contentJson: string }): string {
  return pickTarget(event.rawInput, event.locations) || toolSummary(event.contentJson);
}

type FeedLike = { kind: string; event?: unknown };
const toolEvents = (items: readonly FeedLike[]) =>
  items.flatMap((item) => (item.kind === "tool" ? [item.event as ToolEvent] : []));

/** Tool calls an agent attributes to a subagent call, in arrival order. */
export function subagentChildren(items: readonly FeedLike[], parentId: string): ToolEvent[] {
  return toolEvents(items).filter((event) => event.parentToolCallId === parentId);
}

/** True when a tool call should render inside its parent instead of at the top level. */
export function isNestedTool(items: readonly FeedLike[], event: ToolEvent): boolean {
  const parent = event.parentToolCallId;
  return Boolean(parent) && toolEvents(items).some((candidate) => candidate.toolCallId === parent);
}

export function isNearBottom(scroller: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 48): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

/** Latest pill visibility with hysteresis: hidden within 48px of the bottom, shown beyond 96px, unchanged between. */
export function pillVisible(previous: boolean, scroller: { scrollHeight: number; scrollTop: number; clientHeight: number }, hide = 48, show = 96): boolean {
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distance <= hide) return false;
  if (distance >= show) return true;
  return previous;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
