import type { ThreadPermissionMode } from "../bindings";
import type { ModeIconName } from "./mode-icons";

/**
 * Span's permission modes per thread (ADR 0015), as the composer shows them. The backend owns and enforces the mode;
 * this module only labels it, orders it and picks what the Shift+Tab shortcut moves to.
 */
export type ModeInfo = {
  mode: ThreadPermissionMode;
  label: string;
  /** One line under the label in the mode popover. */
  description: string;
  /** Short risk label shown on the row. */
  risk: string;
  icon: ModeIconName;
  /** Full access gets the warning treatment everywhere it shows. */
  danger: boolean;
};

export const PERMISSION_MODES: readonly ModeInfo[] = [
  { mode: "ask", label: "Ask every time", description: "Every edit and command waits for your answer.", risk: "Safest", icon: "ModeDefault", danger: false },
  { mode: "acceptEdits", label: "Accept edits", description: "Edits inside this folder go ahead. Commands still ask.", risk: "Edits", icon: "ModeWorkspace", danger: false },
  { mode: "plan", label: "Plan (read only)", description: "The agent reads and plans. Edits and commands are blocked.", risk: "Read only", icon: "ModePlan", danger: false },
  { mode: "auto", label: "Auto (safe commands)", description: "Edits inside this folder and a short list of read-only and test commands go ahead. Anything else asks.", risk: "Some commands", icon: "ModeAuto", danger: false },
  { mode: "full", label: "Full access", description: "Nothing asks. The agent runs commands and edits files on its own; Span still logs each one.", risk: "No prompts", icon: "ModeDanger", danger: true },
];

export const FULL_ACCESS_WARNING = "Full access lets the agent run commands and edit files without asking";

export const modeInfo = (mode: ThreadPermissionMode): ModeInfo => PERMISSION_MODES.find((info) => info.mode === mode) ?? PERMISSION_MODES[0];

/** Why a mode is not offered for this session, for the disabled row. */
export function unsupportedReason(mode: ThreadPermissionMode, child: boolean): string {
  if (child && mode !== "ask" && mode !== "plan") return "A delegated agent never runs looser than Ask every time";
  if (mode === "plan") return "This agent has no plan mode, so Span cannot keep it read only";
  return "This agent cannot run in this mode";
}

/** `mode` when the session supports it, else Ask. Never a looser mode. */
export const downgrade = (mode: ThreadPermissionMode, supported: readonly ThreadPermissionMode[]): ThreadPermissionMode => (supported.includes(mode) ? mode : "ask");

const CYCLE: readonly ThreadPermissionMode[] = ["ask", "acceptEdits", "plan"];

/** Shift+Tab: Ask, Accept edits, Plan, then Ask again, skipping what the session does not support. Never into Auto or Full. */
export function cycleNext(mode: ThreadPermissionMode, supported: readonly ThreadPermissionMode[]): ThreadPermissionMode {
  const start = CYCLE.indexOf(mode);
  if (start < 0) return "ask";
  for (let step = 1; step <= CYCLE.length; step += 1) {
    const next = CYCLE[(start + step) % CYCLE.length];
    if (supported.includes(next)) return next;
  }
  return "ask";
}

const NAMES: readonly ThreadPermissionMode[] = ["ask", "acceptEdits", "plan", "auto", "full"];
export const isPermissionMode = (value: unknown): value is ThreadPermissionMode => typeof value === "string" && (NAMES as readonly string[]).includes(value);

/** The last-config key under which the Span mode an agent last ran in is remembered (beside its option values). */
export const SPAN_MODE_KEY = "span.permissionMode";

/**
 * A Span mode from what the per-agent memory holds: the Span mode key, else an agent mode value remembered before Span
 * modes existed (so a remembered bypass mode still comes back as Full, as before).
 */
export function rememberedMode(saved: Record<string, string> | undefined): ThreadPermissionMode | undefined {
  if (!saved) return undefined;
  const span = saved[SPAN_MODE_KEY];
  if (isPermissionMode(span)) return span;
  const raw = saved.mode;
  if (!raw) return undefined;
  if (["bypassPermissions", "agent-full-access", "yolo"].includes(raw)) return "full";
  if (["plan", "read-only"].includes(raw)) return "plan";
  if (["acceptEdits", "autoEdit", "workspace-write"].includes(raw)) return "acceptEdits";
  if (raw === "auto") return "auto";
  return undefined;
}

/** The feed text for a request Span answered itself. */
export function policyRowText(decision: string, reason: string, title: string): string {
  if (decision === "rejected") return `Blocked in Plan mode: ${title}`;
  if (reason === "auto_safe_command") return `Allowed as a safe command: ${title}`;
  if (reason === "full_access") return `Allowed with Full access: ${title}`;
  return `Allowed by Accept edits: ${title}`;
}
