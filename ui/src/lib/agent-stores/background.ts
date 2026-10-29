import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { api, isDesktop } from "../client";
import { agentHealthResults, healthNow, setAgentHealth } from "../agent-health";
import { readRecentAgents } from "../last-session";
import { sharedStore } from "./shared";

/** Runs `run` once the panel has painted. */
const afterPaint = (run: () => void) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
};

/**
 * Background agents (app-wide, ADR 0011 phase 2): warm start (ADR 0009) and the health check (ADR 0010), with the
 * user's `agents.healthCheck` setting. Both are quiet: a failure never shows an error.
 */
export function createAgentBackground() {
  /** The merged `agents.healthCheck`: on unless the user turned it off. Set by the holder from its settings. */
  const [healthOn, setHealthOn] = createSignal(true);
  let disposed = false;
  let unsubscribeHealth: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    unsubscribeHealth?.();
  });

  /**
   * Warm start (ADR 0009): once the panel has painted, ask the backend to start installed agents in the background, most
   * recently used first, so a delegation or a switch does not wait. Quiet: a failed start never shows an error here.
   */
  function warmStart(workspacePath: string | undefined) {
    if (!isDesktop || disposed || !workspacePath || !api.agentWarmStart) return;
    const recent = readRecentAgents();
    afterPaint(() => {
      if (!disposed) void api.agentWarmStart?.(recent).catch(() => undefined);
    });
  }
  /**
   * Agent health check (ADR 0010): once the panel has painted, read the latest results, which also starts the backend's
   * periodic checks, and follow every change. Quiet: a failure leaves the dots grey.
   */
  function startHealth() {
    if (!isDesktop || disposed || !api.agentHealth) return;
    afterPaint(() => {
      if (!disposed && healthOn()) void api.agentHealth?.().then(setAgentHealth).catch(() => undefined);
    });
    void api
      .onAgentHealth?.(setAgentHealth)
      .then((cleanup) => {
        if (disposed) cleanup();
        else unsubscribeHealth = cleanup;
      })
      .catch(() => undefined);
  }
  // Turned back on in Settings: show the current results again (the backend checks only while it is on).
  createEffect(
    on(healthOn, (enabled, before) => {
      if (enabled && before === false && isDesktop) void api.agentHealth?.().then(setAgentHealth).catch(() => undefined);
    }),
  );
  /** Health results to show: none while `agents.healthCheck` is off. */
  const health = createMemo(() => (healthOn() ? agentHealthResults() : []));

  return { healthOn, setHealthOn, health, healthNow, warmStart, startHealth };
}

export type AgentBackground = ReturnType<typeof createAgentBackground>;

/** The app's one warm start and health check owner. */
export const agentBackground = sharedStore(createAgentBackground);
