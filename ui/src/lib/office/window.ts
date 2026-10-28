/** Row virtualisation in fixed windows: the DOM holds the window under the viewport and the next one. */
export const ROW_WINDOW = 200;

export function rowWindow(scrollTop: number, rowHeight: number, viewportHeight: number, total: number, size = ROW_WINDOW): { start: number; end: number } {
  if (total <= 0) return { start: 0, end: 0 };
  const first = Math.min(total - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const lastVisible = Math.ceil((Math.max(0, scrollTop) + viewportHeight) / rowHeight);
  const start = Math.floor(first / size) * size;
  return { start, end: Math.min(total, Math.max(start + 2 * size, lastVisible)) };
}

/** The scroll position that brings a row fully into view, or the current one when it already is. */
export function scrollTopFor(row: number, rowHeight: number, scrollTop: number, viewportHeight: number): number {
  const top = row * rowHeight, bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}
