/** Pure layout math for the PDF viewer: zoom, fit width, canvas budget, lazy page window and find. */
export const PDF_ZOOM_MIN = 50;
export const PDF_ZOOM_MAX = 400;
export const PDF_ZOOM_PRESETS = [50, 67, 75, 90, 100, 125, 150, 200, 250, 300, 400] as const;
/** Largest canvas backing store, in pixels, for one page (about 64 MiB of RGBA). */
export const PDF_MAX_CANVAS_PIXELS = 16_777_216;
/** PDF points are 1/72 inch, CSS pixels 1/96 inch. */
export const CSS_PER_PT = 96 / 72;

export function clampPdfZoom(value: number): number { return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, Math.round(value))); }
export function stepPdfZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return PDF_ZOOM_PRESETS.find(p => p > current) ?? PDF_ZOOM_MAX;
  return [...PDF_ZOOM_PRESETS].reverse().find(p => p < current) ?? PDF_ZOOM_MIN;
}
export function fitWidthZoom(pageWidthPt: number, containerWidth: number, gutter = 48): number {
  if (!(pageWidthPt > 0) || !(containerWidth > 0)) return 100;
  return clampPdfZoom(Math.floor((containerWidth - gutter) / (pageWidthPt * CSS_PER_PT) * 100));
}
/** Backing-store scale for a page canvas: the device pixel ratio, lowered when the canvas would pass the pixel budget. */
export function canvasScale(cssWidth: number, cssHeight: number, devicePixelRatio: number, maxPixels = PDF_MAX_CANVAS_PIXELS): number {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const area = cssWidth * cssHeight;
  if (area <= 0 || area * scale * scale <= maxPixels) return scale;
  return Math.sqrt(maxPixels / area);
}
export function parsePageInput(text: string, count: number): number | undefined {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || count < 1) return undefined;
  return Math.min(count, Math.max(1, n));
}

export interface PageLayout { tops: number[]; heights: number[]; total: number }
export function pageLayout(heights: readonly number[], gap: number): PageLayout {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) { tops.push(y); y += h + gap; }
  return { tops, heights: [...heights], total: heights.length ? y - gap : 0 };
}
export function visiblePages(layout: PageLayout, scrollTop: number, viewportHeight: number, overscan = 1): { first: number; last: number } {
  const n = layout.tops.length;
  if (!n) return { first: 0, last: -1 };
  let first = layout.tops.findIndex((top, i) => top + layout.heights[i] > scrollTop);
  if (first < 0) first = n - 1;
  let last = first;
  while (last + 1 < n && layout.tops[last + 1] < scrollTop + viewportHeight) last++;
  return { first: Math.max(0, first - overscan), last: Math.min(n - 1, last + overscan) };
}

export interface FindMatch { page: number; item: number; start: number; length: number }
export function findMatches(pages: readonly (readonly string[])[], query: string, limit = 5000): FindMatch[] {
  const q = query.trim().toLowerCase();
  const out: FindMatch[] = [];
  if (!q) return out;
  pages.forEach((items, page) => items.forEach((text, item) => {
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(q); at >= 0 && out.length < limit; at = lower.indexOf(q, at + q.length)) out.push({ page, item, start: at, length: q.length });
  }));
  return out;
}
export function nextMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Multiply two PDF affine matrices [a, b, c, d, e, f]. */
export function multiplyTransform(m: readonly number[], n: readonly number[]): number[] {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
export interface TextItemLike { str: string; transform: readonly number[]; width: number }
/**
 * Highlight box for part of a text item, in CSS pixels of the page box. The horizontal share is
 * proportional to characters, which is an approximation for proportional fonts.
 */
export function matchRect(viewportTransform: readonly number[], scale: number, item: TextItemLike, start: number, length: number): { left: number; top: number; width: number; height: number } {
  const tx = multiplyTransform(viewportTransform, item.transform);
  const height = Math.hypot(tx[2], tx[3]);
  const width = item.width * scale;
  const chars = Math.max(1, item.str.length);
  return { left: tx[4] + width * (start / chars), top: tx[5] - height, width: Math.max(2, width * (length / chars)), height };
}
