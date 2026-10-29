import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const MIN_ZOOM_LEVEL = -5;
export const MAX_ZOOM_LEVEL = 5;
export const ZOOM_STORAGE_KEY = "span:window.zoomLevel";
export function clampZoomLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, level)) : 0;
}
/** Each level changes the whole window by a factor of 1.2, independently of editor preferences. */
export function zoomFactor(level: number): number { return 1.2 ** clampZoomLevel(level); }
function storedLevel(): number {
  try { const value = window.localStorage.getItem(ZOOM_STORAGE_KEY); return value === null ? 0 : clampZoomLevel(Number(value)); }
  catch { return 0; }
}
/** CSS zoom scales pointer coordinates, while layout dimensions stay in CSS pixels. */
export function cssZoomFactor(): number {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}
export function layoutSize(element?: HTMLElement): { width: number; height: number } {
  const factor = cssZoomFactor();
  return { width: element?.clientWidth || window.innerWidth / factor, height: element?.clientHeight || window.innerHeight / factor };
}
export async function applyWindowZoom(factor: number): Promise<void> {
  if (isTauri()) await getCurrentWebview().setZoom(factor);
  else {
    document.documentElement.style.zoom = String(factor);
    // CSS zoom scales viewport units too. Keep the preview workbench inside the visible window.
    const workbench = document.querySelector<HTMLElement>(".ide");
    if (workbench) workbench.style.height = `calc(100dvh / ${factor})`;
  }
}
export function createZoomController(options: {
  initialLevel?: number;
  applyZoom?: (factor: number) => Promise<void>;
  persistLevel?: (level: number) => void | Promise<void>;
  onChange?: (level: number) => void;
} = {}) {
  let level = clampZoomLevel(options.initialLevel ?? storedLevel());
  let queue: Promise<void> = Promise.resolve();
  const apply = options.applyZoom ?? applyWindowZoom;
  const persist = options.persistLevel ?? ((value: number) => { window.localStorage.setItem(ZOOM_STORAGE_KEY, String(value)); });
  function schedule(next: () => number, save: boolean): Promise<void> {
    const operation = queue.then(async () => {
      const value = clampZoomLevel(next());
      await apply(zoomFactor(value));
      level = value;
      options.onChange?.(level);
      if (save) await persist(level);
    });
    // A rejected native call must not block later zoom commands.
    queue = operation.catch(() => undefined);
    return operation;
  }
  return {
    level: () => level,
    restore: () => schedule(() => level, false),
    setLevel: (value: number) => schedule(() => value, true),
    zoomIn: () => schedule(() => level + 1, true),
    zoomOut: () => schedule(() => level - 1, true),
    reset: () => schedule(() => 0, true),
  };
}
