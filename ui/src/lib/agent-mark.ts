/** Motion state of the brand mark in the status row, named after the Logo Motion System in the design pack. */
export type MarkState = "idle" | "thinking" | "running" | "needs" | "error" | "done";

export interface MarkInput {
  connecting: boolean;
  running: boolean;
  /** A tool or command is executing, as opposed to the model still thinking. */
  toolActive: boolean;
  /** A permission, question or form is waiting on the user. */
  needsYou: boolean;
  failed: boolean;
  /** A turn ended a moment ago. */
  justFinished: boolean;
}

/** One state, most urgent first: error, needs you, running a tool, thinking, finished, at rest. */
export function markState(input: MarkInput): MarkState {
  if (input.failed) return "error";
  if (input.needsYou) return "needs";
  if (input.running) return input.toolActive ? "running" : "thinking";
  if (input.connecting) return "thinking";
  return input.justFinished ? "done" : "idle";
}
