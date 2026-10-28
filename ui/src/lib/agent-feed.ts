import type { AgentEvent } from "../bindings";

export type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

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
  const input = record.rawInput && typeof record.rawInput === "object" ? (record.rawInput as Record<string, unknown>) : {};
  const locations = Array.isArray(record.locations) ? record.locations : [];
  const firstLocation = locations[0] && typeof locations[0] === "object" ? (locations[0] as Record<string, unknown>).path : undefined;
  const pick = [input.command, input.file_path, input.path, input.url, input.pattern, input.query, firstLocation].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const text = (pick ?? "").trim().replace(/\s+/g, " ");
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
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
