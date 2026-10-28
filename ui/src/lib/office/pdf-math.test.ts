import { describe, expect, it } from 'vitest';
import { PDF_ZOOM_MAX, PDF_ZOOM_MIN, canvasScale, matchRect, clampPdfZoom, findMatches, fitWidthZoom, nextMatchIndex, parsePageInput, pageLayout, stepPdfZoom, visiblePages } from './pdf-math';

describe('pdf zoom and fit', () => {
  it('clamps zoom to 50 to 400', () => {
    expect([PDF_ZOOM_MIN, PDF_ZOOM_MAX]).toEqual([50, 400]);
    expect(clampPdfZoom(10)).toBe(50);
    expect(clampPdfZoom(1000)).toBe(400);
    expect(clampPdfZoom(133.4)).toBe(133);
  });
  it('steps through presets from any value', () => {
    expect(stepPdfZoom(100, 1)).toBe(125);
    expect(stepPdfZoom(100, -1)).toBe(90);
    expect(stepPdfZoom(110, 1)).toBe(125);
    expect(stepPdfZoom(400, 1)).toBe(400);
    expect(stepPdfZoom(50, -1)).toBe(50);
  });
  it('fits the page width into the container minus the gutter', () => {
    // 612 pt is 816 CSS px at 100 percent.
    expect(fitWidthZoom(612, 816 + 48)).toBe(100);
    expect(fitWidthZoom(612, 408 + 48)).toBe(50);
    expect(fitWidthZoom(612, 100)).toBe(50);
    expect(fitWidthZoom(0, 900)).toBe(100);
  });
  it('limits canvas pixels by lowering the backing scale', () => {
    expect(canvasScale(800, 1000, 2, 16_000_000)).toBe(2);
    const s = canvasScale(4000, 5000, 2, 16_000_000);
    expect(4000 * 5000 * s * s).toBeLessThanOrEqual(16_000_000 + 1);
    expect(canvasScale(10, 10, 0, 100)).toBe(1);
  });
  it('parses the page input', () => {
    expect(parsePageInput('3', 12)).toBe(3);
    expect(parsePageInput('99', 12)).toBe(12);
    expect(parsePageInput('0', 12)).toBe(1);
    expect(parsePageInput('x', 12)).toBeUndefined();
  });
});

describe('lazy page window', () => {
  const layout = pageLayout([100, 100, 100, 100, 100], 10);
  it('lays out page tops with gaps', () => {
    expect(layout.tops).toEqual([0, 110, 220, 330, 440]);
    expect(layout.total).toBe(540);
  });
  it('returns only the pages in view plus overscan', () => {
    expect(visiblePages(layout, 0, 150, 0)).toEqual({ first: 0, last: 1 });
    expect(visiblePages(layout, 250, 50, 0)).toEqual({ first: 2, last: 2 });
    expect(visiblePages(layout, 250, 50, 1)).toEqual({ first: 1, last: 3 });
    expect(visiblePages(layout, 5000, 50, 1)).toEqual({ first: 3, last: 4 });
    expect(visiblePages(pageLayout([], 10), 0, 100, 1)).toEqual({ first: 0, last: -1 });
  });
});

describe('find in document', () => {
  const pages = [['Hello world', 'Contrast check'], ['Nothing'], ['contrast ratio', 'CONTRAST']];
  it('finds case-insensitive matches per page and item', () => {
    expect(findMatches(pages, 'contrast')).toEqual([
      { page: 0, item: 1, start: 0, length: 8 },
      { page: 2, item: 0, start: 0, length: 8 },
      { page: 2, item: 1, start: 0, length: 8 },
    ]);
    expect(findMatches(pages, '  ')).toEqual([]);
    expect(findMatches(pages, 'o', 2)).toHaveLength(2);
  });
  it('cycles next and previous', () => {
    expect(nextMatchIndex(-1, 3, 1)).toBe(0);
    expect(nextMatchIndex(2, 3, 1)).toBe(0);
    expect(nextMatchIndex(0, 3, -1)).toBe(2);
    expect(nextMatchIndex(0, 0, 1)).toBe(-1);
  });
});

describe('find highlight geometry', () => {
  it('maps a text item through the viewport transform', () => {
    // A 792 pt tall page at scale 2: the viewport flips y and scales.
    const viewport = [2, 0, 0, -2, 0, 1584];
    const rect = matchRect(viewport, 2, { str: 'abcdefghij', transform: [12, 0, 0, 12, 72, 700], width: 60 }, 2, 3);
    expect(rect).toEqual({ left: 144 + 24, top: 1584 - 1400 - 24, width: 36, height: 24 });
  });
});
