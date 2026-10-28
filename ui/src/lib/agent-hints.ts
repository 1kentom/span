import type { ComposerHint, ComposerHintMode } from "../components/agent/ComposerHints";
import type { PermissionChoice } from "../components/agent/types";
import { DOCK_TAB_HINT } from "./agent-dock-focus";

type HintInput = {
  /** Options of the open permission request, if any. */
  permission?: readonly PermissionChoice[];
  /** The open input request, if any. */
  elicitation?: { mode: string };
  /** The form field currently asked, when the request is a form. */
  field?: { options: readonly unknown[] };
  /** Focus is inside the open dock. Dock keys act only then, so only then are they listed. */
  dockFocused?: boolean;
};

/**
 * Keyboard hints per composer mode. Each entry names a binding that exists in code:
 * - idle: Enter sends, Shift+Enter inserts a newline (textarea default), ArrowUp at the start recalls earlier
 *   prompts (recallPrompt), "/" at the start of the prompt opens commands (isSlashQuery), Alt+Enter opens the attach menu.
 * - running: Enter steers, Tab queues (AgentComposer keydown), Escape stops the turn (AgentPanel keydown).
 * - question: digits answer a numbered option and Escape declines (QuestionDock), Enter opens the page and Escape
 *   declines for a URL request (UrlDock).
 * - permission: Y picks the first allow option, A the standing allow (when a one-time allow also exists, otherwise Y
 *   already picks it) and N the first reject option (PermissionDock), only when those exist.
 * Dock keys act only while focus is inside the dock, never while typing in the composer (see `dockKey`), so the
 * question and permission rows list them only while the dock has focus. Otherwise they say how to reach the dock.
 */
export function composerHints(input: HintInput): Record<ComposerHintMode, ComposerHint[]> {
  const options = input.permission ?? [];
  const permission: ComposerHint[] = [];
  if (options.some((option) => option.kind.startsWith("allow"))) permission.push({ keys: ["Y"], label: "Allow" });
  if (options.some((option) => option.kind === "allow_once") && options.some((option) => option.kind === "allow_always")) permission.push({ keys: ["A"], label: "Always allow" });
  if (options.some((option) => option.kind.startsWith("reject") && option.kind !== "reject_always")) permission.push({ keys: ["N"], label: "Reject" });
  const question: ComposerHint[] = [];
  if (input.elicitation?.mode === "url") question.push({ keys: ["↵"], label: "Open browser" });
  else if (input.field?.options.length) question.push({ keys: ["1-9"], label: "Pick an option" });
  if (input.elicitation) question.push({ keys: ["Esc"], label: "Decline" });
  const reach: ComposerHint[] = [{ keys: [], label: DOCK_TAB_HINT }];
  return {
    idle: [
      { keys: ["↵"], label: "Send" },
      { keys: ["⇧", "↵"], label: "Newline" },
      { keys: ["/"], label: "Commands" },
      { keys: ["⌥", "↵"], label: "Attach" },
    ],
    running: [
      { keys: ["↵"], label: "Steer" },
      { keys: ["Tab"], label: "Queue" },
      { keys: ["Esc"], label: "Stop" },
    ],
    question: input.dockFocused ? question : reach,
    permission: input.dockFocused ? permission : reach,
  };
}
