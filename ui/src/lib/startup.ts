// Startup timing marks. Pure helpers so they can be tested without a webview.

export const STARTUP_MARKS = {
  entryEvaluated: "span:entry-evaluated",
  shellRendered: "span:shell-rendered",
  sessionReady: "span:session-ready",
} as const;

export type StartupMark = (typeof STARTUP_MARKS)[keyof typeof STARTUP_MARKS];

export type StartupTimings = {
  firstPaintMs: number | null;
  entryEvaluatedMs: number | null;
  shellRenderedMs: number | null;
  sessionReadyMs: number | null;
};

type PerformanceLike = Pick<Performance, "mark" | "getEntriesByName" | "getEntriesByType">;

const defaultPerformance = (): PerformanceLike | undefined => (typeof performance === "undefined" ? undefined : performance);

/** Records a startup mark once. A second call keeps the first time. */
export function markStartup(name: StartupMark, perf: PerformanceLike | undefined = defaultPerformance()) {
  if (!perf) return;
  try { if (!perf.getEntriesByName(name, "mark").length) perf.mark(name); } catch { /* marks are diagnostics only */ }
}

const markTime = (perf: PerformanceLike, name: StartupMark) => {
  const entry = perf.getEntriesByName(name, "mark")[0];
  return entry ? Math.round(entry.startTime) : null;
};

/** Reads the marks plus the browser's own paint entry, preferring first-paint over first-contentful-paint. */
export function collectStartupTimings(perf: PerformanceLike | undefined = defaultPerformance()): StartupTimings {
  if (!perf) return { firstPaintMs: null, entryEvaluatedMs: null, shellRenderedMs: null, sessionReadyMs: null };
  let paints: PerformanceEntry[] = [];
  try { paints = perf.getEntriesByType("paint"); } catch { /* paint timing is optional */ }
  const paint = paints.find(entry => entry.name === "first-paint") ?? paints.find(entry => entry.name === "first-contentful-paint");
  return {
    firstPaintMs: paint ? Math.round(paint.startTime) : null,
    entryEvaluatedMs: markTime(perf, STARTUP_MARKS.entryEvaluated),
    shellRenderedMs: markTime(perf, STARTUP_MARKS.shellRendered),
    sessionReadyMs: markTime(perf, STARTUP_MARKS.sessionReady),
  };
}

/** Runs `callback` after the next frame has painted, or after `fallbackMs` when frames are throttled. */
export function afterNextPaint(callback: () => void, fallbackMs = 1000) {
  let done = false;
  const run = () => { if (done) return; done = true; callback(); };
  const timer = setTimeout(run, fallbackMs);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); run(); }, 0));
}

export type BootTheme = "dark" | "light" | "purple";

/** localStorage key read by public/boot.js before the bundle loads. Keep the two in step. */
export const THEME_STORAGE_KEY = "span.theme";

/** The `--canvas` token of each theme in styles/workbench.css, painted before any UI exists. */
export const CANVAS_COLORS: Record<BootTheme, string> = { dark: "#090909", light: "#eeeff0", purple: "#080810" };

const isBootTheme = (value: unknown): value is BootTheme => value === "dark" || value === "light" || value === "purple";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const defaultStorage = (): StorageLike | undefined => { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } };

/** The theme saved by the last run, so the first frame matches it before settings load. */
export function readBootTheme(storage: StorageLike | undefined = defaultStorage()): BootTheme | undefined {
  try { const value = storage?.getItem(THEME_STORAGE_KEY); return isBootTheme(value) ? value : undefined; } catch { return undefined; }
}

export function rememberBootTheme(theme: BootTheme, storage: StorageLike | undefined = defaultStorage()) {
  try { if (storage?.getItem(THEME_STORAGE_KEY) !== theme) storage?.setItem(THEME_STORAGE_KEY, theme); } catch { /* storage can be unavailable */ }
}
