/**
 * Agent health check (ADR 0010): the latest result per running agent, as the backend reports it. The backend sends one
 * tiny prompt to each running agent Span is not chatting with, every five minutes, over a hidden session; this module
 * only keeps and words the results. Nothing here infers health from anything else.
 */
import { createSignal } from "solid-js";
import type { AgentHealth_Serialize as AgentHealth } from "../bindings";

export type { AgentHealth };

/** The dot colour: green Live, amber Slow, red-ish Unreachable, grey Signed out or not checked. */
export type HealthTone = "live" | "slow" | "unreachable" | "unknown";

export function healthTone(health: AgentHealth | undefined): HealthTone {
  switch (health?.state) {
    case "live":
      return "live";
    case "slow":
      return "slow";
    case "unreachable":
      return "unreachable";
    default:
      return "unknown";
  }
}

/**
 * One key for an agent across its installed id and its reported or display name, so "codex-acp", "Codex" and
 * "codex" meet: lowercase letters and digits only, without a trailing "acp", "cli", "agent" or "code".
 */
export function agentKey(name: string): string {
  let key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of ["acp", "cli", "agent", "code"]) {
      if (key.length > suffix.length && key.endsWith(suffix)) {
        key = key.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return key;
}

/** The result for the first of `names` (installed id, reported name, display name) that has one. */
export function findHealth(list: readonly AgentHealth[], ...names: Array<string | null | undefined>): AgentHealth | undefined {
  for (const name of names) {
    if (!name) continue;
    const exact = list.find((entry) => entry.agentId.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    const key = agentKey(name);
    const loose = key ? list.find((entry) => agentKey(entry.agentId) === key) : undefined;
    if (loose) return loose;
  }
  return undefined;
}

/** "just now", "4 min ago", "2 h ago", "3 d ago". */
export function ago(atMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Reply latency in seconds with one decimal: "1.2 s". */
export function latencyText(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** The tooltip and accessible name of a health dot. */
export function healthText(health: AgentHealth | undefined, nowMs: number): string {
  if (!health) return "Not checked yet";
  const when = ago(health.checkedAtMs, nowMs);
  switch (health.state) {
    case "live":
      return `Replied OK in ${latencyText(health.latencyMs ?? 0)}, ${when}`;
    case "slow":
      return `Slow: replied in ${latencyText(health.latencyMs ?? 0)}, ${when}`;
    case "signedOut":
      return `Signed out, checked ${when}`;
    case "unreachable":
      return `No reply, checked ${when}`;
  }
}

const [results, setResults] = createSignal<AgentHealth[]>([]);
const [now, setNow] = createSignal(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

/** The latest results, sorted by agent id. */
export const agentHealthResults = results;
/** A clock for "4 min ago", ticking every 30 seconds while the health check runs. */
export const healthNow = now;

/** Replace the results (from `agent_health` or an `AgentHealthChanged` event). */
export function setAgentHealth(next: readonly AgentHealth[]) {
  setResults([...next]);
  setNow(Date.now());
  if (!clock && typeof setInterval === "function") clock = setInterval(() => setNow(Date.now()), 30_000);
}
