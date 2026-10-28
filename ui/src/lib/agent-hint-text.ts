import type { AgentHint } from "../bindings";

/**
 * The one table from a backend hint id to the short English the panel shows.
 * The backend sends ids only, never display text, so every hint string in the UI comes from here.
 * `runOpencodeAuthLogin` carries backticks: render it with `splitCode`.
 */
export const HINT_TEXT: Record<AgentHint, string> = {
  turnLimitOrLoop: "Turn limit or loop detected",
  noOutputStreamed: "Command ran, no output streamed",
  outputUnavailable: "Output not available from agent",
  runOpencodeAuthLogin: "Run `opencode auth login` in a terminal, then retry",
  retrying: "Retrying",
  compacting: "Compacting conversation",
  toolPending: "Preparing tool",
  permissionsBypassed: "it will not ask before running tools, and Span's approval prompts will not appear",
  rejectedByUser: "Stopped after you rejected a request",
  deletedStillListed: "The agent still lists a conversation you deleted. Span hides it until you reconnect.",
  runOpencodeAuthLoginOrSwitchModel: "Run `opencode auth login` in a terminal, or choose another model, then retry",
  needsEnvironmentSetup: "needs setup in a terminal or environment variables, which Span does not do. Set it up, then reconnect.",
  interruptedByUser: "Request interrupted by user",
};

/** The one line the mode chip adds while the session's mode bypasses permission prompts. */
export const BYPASS_MODE_EXPLANATION = "This agent will not ask before running tools or editing files";

/** The `noticeId` of the backend's permission bypass notice. It is shown as a banner by the composer, not as a feed card. */
export const PERMISSION_BYPASS_NOTICE = "span/permission-bypass";

/** Text for a hint, or undefined when there is no hint or the id is one this build does not know. */
export function hintText(hint: AgentHint | string | null | undefined): string | undefined {
  return hint && Object.prototype.hasOwnProperty.call(HINT_TEXT, hint) ? HINT_TEXT[hint as AgentHint] : undefined;
}

/** Splits text on backtick pairs so the quoted parts can render as code. Odd backticks stay as plain text. */
export function splitCode(text: string): { text: string; code: boolean }[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return [{ text, code: false }];
  return parts.map((part, index) => ({ text: part, code: index % 2 === 1 })).filter((part) => part.text !== "");
}

/** What the activity bar, the pinned running step and the session list say about a running turn. */
export const RUN_TEXT = {
  thinking: "Thinking",
  running: "Running",
  runningCommand: "Running command",
  approval: "Waiting for your approval",
  answer: "Waiting for your answer",
  stopping: "Stopping",
  idle: "Idle",
  queued: "Queued",
  /** Shown inline when Send is pressed, or text is typed, while a turn runs. */
  busy: "A turn is running. Enter steers it, Tab queues, Esc stops",
  stillRunning: "Still running, no new output for",
  showFull: "Show full output",
  hideFull: "Show less",
} as const;
