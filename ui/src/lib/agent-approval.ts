import { approvalTitle, friendlyToolTitle, humanizeName } from "./agent-tool-bar";

/** Lines a long command, question or preview shows before "Show more". */
export const CLAMP_LINES = 3;
/** Lines an expanded block shows before it scrolls inside the dock. */
export const EXPANDED_LINES = 12;
/**
 * Characters that fit on one monospace line at the narrowest sidebar (320px, 11px JetBrains Mono). Only used when the
 * block cannot be measured (tests, first paint); the real overflow check wins once layout exists.
 */
export const CHARS_PER_LINE = 40;

export const CLAMP_TEXT = {
  more: "Show more",
  less: "Show less",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Could not copy",
} as const;

/** A title this long or longer, or one with a line break, is treated as content (a command, a path), not a heading. */
const MAX_HEADING = 48;

const squash = (value: string) => value.replace(/[`\s]+/g, " ").trim();

export type ApprovalHeadingInput = {
  /** The ACP tool kind, when the agent sent one. */
  kind?: string;
  /** The agent's own title for the request. Often the command itself. */
  title: string;
  /** The command or first target shown in the body. */
  command?: string;
  /** File labels shown in the body. */
  locations?: readonly string[];
  /** Agent housekeeping: its title is kept as is. */
  internal?: boolean;
};

export type ApprovalHeading = {
  /** The short title for the header row: "Run command", "Edit file". Never the full command. */
  heading: string;
  /** The agent's own title, only when it says something the heading and the body do not already show. */
  note?: string;
};

/**
 * Decides what the header row of an approval says, so the command is never shown twice: the header gets a short
 * human title from the tool kind (the same words as the activity bar where it has them), and the agent's title is
 * kept as a body note only when it is neither the command, a path already listed, nor just the kind again.
 */
export function approvalHeading(input: ApprovalHeadingInput): ApprovalHeading {
  const title = squash(input.title);
  if (input.internal) return { heading: title || "Agent housekeeping" };
  const command = input.command ? squash(input.command) : "";
  const fromKind = approvalTitle(input.kind);
  const friendly = friendlyToolTitle({ toolKind: input.kind, title: input.title });
  const short = title.length > 0 && title.length < MAX_HEADING && !/\n/.test(input.title);
  const heading = fromKind ?? (friendly !== "Tool" ? friendly : command ? approvalTitle("execute")! : short ? title : "Allow tool call");
  if (!title || heading === title) return { heading };
  const plain = title.toLowerCase();
  const redundant =
    plain === heading.toLowerCase() ||
    plain === (input.kind ?? "").toLowerCase() ||
    plain === friendly.toLowerCase() ||
    humanizeName(title).toLowerCase() === heading.toLowerCase() ||
    (command && (plain.includes(command.toLowerCase()) || command.toLowerCase().includes(plain))) ||
    (input.locations ?? []).some((label) => label && plain.includes(squash(label).toLowerCase()));
  return redundant ? { heading } : { heading, note: title };
}

/** Rough count of wrapped lines: each source line takes at least one row, long ones wrap every `charsPerLine`. */
export function estimateLines(text: string, charsPerLine = CHARS_PER_LINE): number {
  return text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / Math.max(1, charsPerLine))), 0);
}

export type ClampInput = {
  text: string;
  expanded: boolean;
  /** Overflow measured from layout: true or false once known, undefined before (or without) layout. */
  measured?: boolean;
  maxLines?: number;
  charsPerLine?: number;
};

export type ClampState = {
  /** The text needs more than `maxLines`: the toggle is offered. */
  long: boolean;
  /** The block is drawn clamped to `maxLines`. */
  clamped: boolean;
  /** Toggle label and chevron, only when the text is long. */
  toggle?: { label: string; icon: "arrow-down4" | "arrow-up3"; expanded: boolean };
};

/** Whether a block is clamped and what its toggle says. Measured overflow wins over the character estimate. */
export function clampState(input: ClampInput): ClampState {
  const long = input.measured ?? estimateLines(input.text, input.charsPerLine) > (input.maxLines ?? CLAMP_LINES);
  const expanded = long && input.expanded;
  return {
    long,
    clamped: !expanded,
    toggle: long ? { label: expanded ? CLAMP_TEXT.less : CLAMP_TEXT.more, icon: expanded ? "arrow-up3" : "arrow-down4", expanded } : undefined,
  };
}
