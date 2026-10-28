import { isDangerKey, normaliseChoice } from "./danger-choice";

/** Icon names (files in public/icons, recorded in mode-provenance.json) for the rows of the composer Mode popover. */
export const MODE_ICON_NAMES = ["ModeReadOnly", "ModeWorkspace", "ModeAuto", "ModeDanger", "ModePlan", "ModeDefault", "ModeOther"] as const;
export type ModeIconName = (typeof MODE_ICON_NAMES)[number];

/** Normalised choice value (lowercase, separators as hyphens) to icon. */
const TABLE: Record<string, ModeIconName> = {
  "read-only": "ModeReadOnly", readonly: "ModeReadOnly",
  workspace: "ModeWorkspace", "workspace-write": "ModeWorkspace", "accept-edits": "ModeWorkspace", acceptedits: "ModeWorkspace", "auto-edit": "ModeWorkspace",
  auto: "ModeAuto", agent: "ModeAuto", "auto-review": "ModeAuto",
  default: "ModeDefault",
  plan: "ModePlan",
};

/** The icon for a mode choice, picked from its value (the ACP choice id) alone. Unknown values get the neutral icon. */
export function modeIconFor(value: string): { icon: ModeIconName; danger: boolean } {
  const key = normaliseChoice(value);
  if (isDangerKey(key)) return { icon: "ModeDanger", danger: true };
  return { icon: TABLE[key] ?? "ModeOther", danger: false };
}
