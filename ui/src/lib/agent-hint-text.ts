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
};

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
