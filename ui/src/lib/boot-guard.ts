// Startup safety net. The app signals `ready` once the restored session is on screen; if that does not happen in
// time, or rendering throws, the root shows a recovery screen instead of leaving an empty, unreadable window.

export const BOOT_WATCHDOG_MS = 8000;

type Timers = { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
const defaultTimers: Timers = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

let ready = false;
const listeners = new Set<() => void>();

/** Called by the app once the restored session has rendered. Later calls do nothing. */
export function signalAppReady() {
  if (ready) return;
  ready = true;
  if (typeof document !== "undefined") document.documentElement.dataset.spanReady = "true";
  for (const listener of [...listeners]) listener();
  listeners.clear();
}

export const isAppReady = () => ready;

/** Runs `listener` once the app is ready (at once when it already is). Returns an unsubscribe. */
export function onAppReady(listener: () => void): () => void {
  if (ready) {
    listener();
    return () => undefined;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: forget a previous ready signal. */
export function resetAppReadyForTests() {
  ready = false;
  listeners.clear();
}

/**
 * Calls `onTimeout` when `ready` has not been signalled within `timeoutMs`. `onReadyAfterTimeout` runs if the app
 * becomes ready later after all, so a slow start can take the recovery screen away again.
 */
export function startBootWatchdog(options: { onTimeout: () => void; onReadyAfterTimeout?: () => void; timeoutMs?: number; timers?: Timers }) {
  const timers = options.timers ?? defaultTimers;
  let fired = false;
  let done = false;
  const handle = timers.setTimeout(() => {
    if (done || ready) return;
    fired = true;
    options.onTimeout();
  }, options.timeoutMs ?? BOOT_WATCHDOG_MS);
  const unsubscribe = onAppReady(() => {
    timers.clearTimeout(handle);
    if (fired && !done) options.onReadyAfterTimeout?.();
    done = true;
  });
  return () => {
    done = true;
    timers.clearTimeout(handle);
    unsubscribe();
  };
}

/** A short, single line summary of an unknown thrown value. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  if (typeof error === "string") return error.slice(0, 500);
  try {
    return JSON.stringify(error)?.slice(0, 500) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Text for "Copy diagnostics": what failed and where startup got to. Error text and stack come from the app bundle;
 * storage keys are names only, with folder paths redacted. No stored values, prompts or file contents.
 */
export function diagnosticsText(input: { reason: "error" | "slow"; error?: unknown; version?: string; userAgent?: string; marks?: Record<string, number | null>; storageKeys?: string[]; now?: Date }): string {
  const lines = [
    "span startup diagnostics",
    `time: ${(input.now ?? new Date()).toISOString()}`,
    `reason: ${input.reason === "error" ? "the interface failed to render" : "startup did not finish in time"}`,
  ];
  if (input.version) lines.push(`version: ${input.version}`);
  if (input.userAgent) lines.push(`webview: ${input.userAgent}`);
  if (input.error !== undefined) {
    lines.push(`error: ${errorSummary(input.error)}`);
    const stack = input.error instanceof Error ? input.error.stack : undefined;
    if (stack) lines.push("stack:", ...stack.split("\n").slice(0, 12).map((line) => `  ${line.trim()}`));
  }
  if (input.marks) lines.push(`startup marks (ms): ${Object.entries(input.marks).map(([name, value]) => `${name}=${value ?? "none"}`).join(", ")}`);
  if (input.storageKeys) lines.push(`stored interface keys: ${input.storageKeys.join(", ") || "none"}`);
  return lines.join("\n");
}
