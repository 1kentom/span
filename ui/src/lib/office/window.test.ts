import { describe, expect, it } from 'vitest';
import { ROW_WINDOW, rowWindow, scrollTopFor } from './window';

describe('row window virtualisation', () => {
  it('renders windows of 200 rows covering the viewport', () => {
    expect(ROW_WINDOW).toBe(200);
    expect(rowWindow(0, 26, 600, 1000)).toEqual({ start: 0, end: 400 });
    // Row 210 is at 5460 px, inside the second window: render windows one and two.
    expect(rowWindow(210 * 26, 26, 600, 1000)).toEqual({ start: 200, end: 600 });
    expect(rowWindow(990 * 26, 26, 600, 1000)).toEqual({ start: 800, end: 1000 });
  });
  it('handles short sheets and empty sheets', () => {
    expect(rowWindow(0, 26, 600, 12)).toEqual({ start: 0, end: 12 });
    expect(rowWindow(500, 26, 600, 0)).toEqual({ start: 0, end: 0 });
  });
  it('computes the scroll position that brings a row into view', () => {
    expect(scrollTopFor(0, 26, 0, 260)).toBe(0);
    expect(scrollTopFor(20, 26, 0, 260)).toBe(21 * 26 - 260);
    expect(scrollTopFor(2, 26, 520, 260)).toBe(52);
    expect(scrollTopFor(25, 26, 520, 260)).toBe(520);
  });
});
