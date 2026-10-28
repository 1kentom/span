/** Text for the dock line and the hints row while the dock does not have focus. One string, so the two always agree. */
export const DOCK_TAB_HINT = "Press Tab to answer, or click an option";

/** How long after the last keystroke in the composer a new dock leaves focus alone. */
export const TYPING_QUIET_MS = 1500;

export type DockFocusInput = {
  now: number;
  /** Time of the last key or input in the composer, 0 when none. */
  lastTypedAt: number;
  composerFocused: boolean;
  composerText: string;
};

/**
 * Whether a dock that just appeared may take focus. It may not while the user is typing (a keystroke in the last
 * 1500 ms) or while the composer has focus and holds unsent text, since the next key would land on the dock.
 */
export function shouldFocusDock(input: DockFocusInput): boolean {
  if (input.now - input.lastTypedAt < TYPING_QUIET_MS) return false;
  if (input.composerFocused && input.composerText.trim() !== "") return false;
  return true;
}
