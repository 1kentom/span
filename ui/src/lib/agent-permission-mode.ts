import { createEffect, createSignal } from "solid-js";
import type { SessionMeta, SessionMetaPatch, ThreadPermissionMode } from "../bindings";
import type { AgentState } from "./agent-session";
import { readLastConfig, writeLastConfig } from "./last-config";
import { SPAN_MODE_KEY, cycleNext, downgrade, rememberedMode } from "./permission-modes";

type Deps = {
  state: () => AgentState;
  sessionId: () => string | undefined;
  agentId: () => string | undefined;
  running: () => boolean;
  /** `agent_set_permission_mode` on the focused session. The backend validates and enforces the mode. */
  apply: (mode: ThreadPermissionMode) => Promise<unknown>;
  recordSessionMeta: (patch: SessionMetaPatch) => void;
  sessionMetaOf: (sessionId: string) => SessionMeta | undefined;
  sendText: (text: string) => void;
  setPrompt: (text: string) => void;
  focusPrompt: () => void;
  markPlan: (itemId: number, status: "ready" | "implementing" | "refining") => void;
  fail: (message: string) => void;
};

/**
 * The user's side of a thread's permission mode (ADR 0015). Only the user's own actions reach `apply`: the mode
 * popover, Shift+Tab, the Plan ready card, the mismatch banner's retry, and restoring what the user chose earlier for
 * this thread (session metadata) or this agent (remembered config). Full access asks for confirmation once per thread
 * when the user picks it; a restore of the user's earlier choice does not ask again (owner decision on remembered
 * config) but the chip always shows it.
 */
export function createPermissionModeControl(deps: Deps) {
  const [busy, setBusy] = createSignal(false);
  /** The session whose switch to Full waits for the confirmation dialog. */
  const [confirming, setConfirming] = createSignal<string>();
  const confirmed = new Set<string>();
  /** A mode to restore on a session once its Span mode is known. */
  const [target, setTarget] = createSignal<{ id: string; mode: ThreadPermissionMode }>();

  const current = () => deps.state().permissionMode;

  async function set(mode: ThreadPermissionMode, remember = true): Promise<boolean> {
    const id = deps.sessionId();
    if (!id || !current()) return false;
    setBusy(true);
    try {
      await deps.apply(mode);
      if (remember) {
        const agent = deps.agentId();
        if (agent) {
          writeLastConfig(agent, SPAN_MODE_KEY, mode);
          deps.recordSessionMeta({ agentId: agent, sessionId: id, permissionMode: mode });
        }
      }
      return true;
    } catch (cause) {
      deps.fail(`Could not change the permission mode: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The user picked a mode. Full waits for the confirmation the first time in this thread. */
  async function choose(mode: ThreadPermissionMode): Promise<boolean> {
    const id = deps.sessionId();
    const now = current();
    if (!id || !now || busy()) return false;
    if (mode === now.mode) return true;
    if (!now.supported.includes(mode)) return false;
    if (mode === "full" && !confirmed.has(id)) {
      setConfirming(id);
      return false;
    }
    return set(mode);
  }

  async function confirmFull() {
    const id = confirming();
    setConfirming(undefined);
    if (!id || id !== deps.sessionId()) return;
    confirmed.add(id);
    await set("full");
  }

  /** Shift+Tab: Ask, Accept edits, Plan. Never into Full. Returns false when there is nothing to cycle. */
  function cycle(): boolean {
    const now = current();
    if (!now || busy()) return false;
    const next = cycleNext(now.mode, now.supported);
    if (next !== now.mode) void set(next);
    return true;
  }

  /** Restores the mode stored with a resumed thread. */
  function restoreThread(id: string) {
    const mode = deps.sessionMetaOf(id)?.permissionMode;
    if (mode) setTarget({ id, mode });
  }
  /** A brand new session starts in the mode this agent last ran in (`saved` for a session continuing another one). */
  function restoreFresh(id: string, saved?: Record<string, string>) {
    const agent = deps.agentId();
    const mode = rememberedMode(saved ?? (agent ? readLastConfig(agent) : undefined));
    if (mode) setTarget({ id, mode });
  }
  createEffect(() => {
    const want = target();
    const now = current();
    const id = deps.sessionId();
    if (!want || !now || id !== want.id) return;
    setTarget(undefined);
    // An unsupported mode falls back to Ask, never to anything looser.
    const mode = downgrade(want.mode, now.supported);
    if (mode === "full") confirmed.add(id);
    if (mode !== now.mode) void set(mode, false);
  });

  /** Plan ready: switch the thread to Accept edits or Ask (the user's choice), then ask the agent to implement. */
  async function implementPlan(itemId: number, mode: "acceptEdits" | "ask") {
    if (deps.running()) return;
    const now = current();
    if (!now) return;
    const next = downgrade(mode, now.supported);
    if (next !== now.mode && !(await set(next))) return;
    deps.markPlan(itemId, "implementing");
    deps.sendText("Implement the plan");
  }
  /** Refine plan: stay in Plan and put the cursor in the composer. */
  function refinePlan(itemId: number) {
    deps.markPlan(itemId, "refining");
    deps.setPrompt("Refine the plan: ");
    deps.focusPrompt();
  }
  /** The mismatch banner's retry: set the thread's own mode again. */
  async function reapply() {
    const now = current();
    if (now) await set(now.mode, false);
  }

  return { busy, choose, cycle, confirming, confirmFull, cancelFull: () => setConfirming(undefined), restoreThread, restoreFresh, implementPlan, refinePlan, reapply };
}

export type PermissionModeControl = ReturnType<typeof createPermissionModeControl>;
