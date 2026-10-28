import type { AgentEvent } from "../bindings";
import { RUN_TEXT } from "./agent-hint-text";
import type { FeedItem } from "./agent-session";
import { toStep } from "./agent-view";

type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

/** Lines of live output shown in the pinned running step before "Show full output". */
export const OUTPUT_PREVIEW_LINES = 12;
/** A running step that streamed nothing for this long gets a quiet "Still running" line. */
export const STILL_RUNNING_AFTER_MS = 30_000;

const UNFINISHED = new Set(["pending", "in_progress"]);

/** The step running now: the newest tool call that has not finished and is not agent housekeeping. */
export function runningTool(feed: readonly FeedItem[]): ToolEvent | undefined {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const item = feed[index];
    if (item.kind !== "tool" || item.event.internal) continue;
    if (UNFINISHED.has(item.event.status ?? "pending")) return item.event;
  }
  return undefined;
}

const isCommand = (event: ToolEvent | undefined) => event?.toolKind === "execute";
const titleOf = (event: ToolEvent) => event.title?.trim() || "Tool call";

/** The activity bar label. Waiting and stopping win over what runs; without a running step the agent is thinking. */
export function activityLabel(input: { tool?: ToolEvent; approval?: boolean; answer?: boolean; stopping?: boolean }): string {
  if (input.stopping) return RUN_TEXT.stopping;
  if (input.approval) return RUN_TEXT.approval;
  if (input.answer) return RUN_TEXT.answer;
  if (input.tool) return `${isCommand(input.tool) ? RUN_TEXT.runningCommand : RUN_TEXT.running}: ${titleOf(input.tool)}`;
  return RUN_TEXT.thinking;
}

/** Elapsed time as m:ss, or h:mm:ss from one hour. */
export function clockText(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Every output line a running tool streamed so far: terminal output for commands, otherwise its text content. */
export function outputLines(event: ToolEvent): string[] {
  const detail = toStep(event, []).detail;
  if (detail?.type === "terminal") return detail.lines.filter((line) => line.kind !== "cmd").map((line) => line.text);
  try {
    const update = JSON.parse(event.contentJson) as { content?: { type?: string; content?: { type?: string; text?: unknown } }[] };
    return (update.content ?? []).flatMap((entry) => (entry.type === "content" && entry.content?.type === "text" && typeof entry.content.text === "string" ? entry.content.text.split("\n") : []));
  } catch {
    return [];
  }
}

/** The tail of the output and how many earlier lines it leaves out. */
export function outputPreview(event: ToolEvent, limit = OUTPUT_PREVIEW_LINES): { lines: string[]; hidden: number; all: string[] } {
  const all = outputLines(event);
  while (all.length && !all[all.length - 1].trim()) all.pop();
  return { lines: all.slice(-limit), hidden: Math.max(0, all.length - limit), all };
}

/** The quiet line for a step that streamed nothing for a while, or undefined before `STILL_RUNNING_AFTER_MS`. */
export function stillRunningText(silentMs: number): string | undefined {
  return silentMs >= STILL_RUNNING_AFTER_MS ? `${RUN_TEXT.stillRunning} ${Math.floor(silentMs / 1000)}s` : undefined;
}

/** The running step's title for the pinned card, with the command flag. */
export function runningTitle(event: ToolEvent): { title: string; command: boolean } {
  return { title: titleOf(event), command: isCommand(event) };
}
